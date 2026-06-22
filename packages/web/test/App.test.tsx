// packages/web/test/App.test.tsx
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as api from "../src/api.js";
import { App } from "../src/App.js";

// Mock the network functions but keep the REAL ApiError class (the established
// importActual pattern) so `new api.ApiError(...)` resolves to the real class.
vi.mock("../src/api.js", async (importActual) => {
  const actual = await importActual<typeof import("../src/api.js")>();
  return {
    ...actual,
    me: vi.fn(),
    login: vi.fn(),
    logout: vi.fn(),
    listPlatforms: vi.fn(),
    services: vi.fn(),
    act: vi.fn(),
    chaosActive: vi.fn(),
    health: vi.fn(),
    audit: vi.fn(),
  };
});
const mockedApi = vi.mocked(api);
beforeEach(() => {
  vi.resetAllMocks();
  window.location.hash = "";
});
afterEach(() => {
  window.location.hash = "";
});

describe("<App/> shell", () => {
  it("renders the login screen when there is no session", async () => {
    mockedApi.me.mockRejectedValue(new api.ApiError("UNAUTH", "no", 401));
    render(<App />);
    expect(await screen.findByRole("button", { name: /sign in/i })).toBeInTheDocument();
  });

  it("renders the console when authenticated", async () => {
    mockedApi.me.mockResolvedValue({ username: "op", role: "operator" });
    mockedApi.listPlatforms.mockResolvedValue([]);
    mockedApi.services.mockResolvedValue([]);
    render(<App />);
    await waitFor(() => expect(screen.getByText(/^DEV$/)).toBeInTheDocument());
  });

  it("routes a #/service/:platformId/:name hash to the service detail page", async () => {
    window.location.hash = "#/service/api/payments";
    mockedApi.me.mockResolvedValue({ username: "op", role: "operator" });
    mockedApi.listPlatforms.mockResolvedValue([
      { id: "api", layer: "API", kind: "eks_ssm", region: "us-east-1" },
    ]);
    mockedApi.services.mockResolvedValue([
      { platformId: "api", layer: "API", name: "payments", mapped: true, desired: 2, running: 2 },
    ]);
    mockedApi.chaosActive.mockResolvedValue([{ platform: "api", kind: "eks_ssm", active: false, items: [], raw: null }]);
    mockedApi.audit.mockResolvedValue([]);
    mockedApi.act.mockResolvedValue({
      outcome: { action: "net-verify", target: "payments", dryRun: false, result: { service: "payments", target: "10.0.0.1", sampled: 20, lossPercent: 0, rttMs: 2 } },
      auditId: null,
    });
    render(<App />);
    // The detail page renders the service name as a heading + a back link to inventory.
    expect(await screen.findByRole("heading", { name: "payments" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /inventory/i })).toBeInTheDocument();
  });

  it("clicking a service name in inventory navigates to its detail page", async () => {
    mockedApi.me.mockResolvedValue({ username: "op", role: "operator" });
    mockedApi.listPlatforms.mockResolvedValue([
      { id: "api", layer: "API", kind: "eks_ssm", region: "us-east-1" },
    ]);
    mockedApi.services.mockResolvedValue([
      { platformId: "api", layer: "API", name: "gateway", group: "Edge", mapped: true, desired: 1, running: 1 },
    ]);
    mockedApi.chaosActive.mockResolvedValue([]);
    mockedApi.health.mockResolvedValue({
      platform: "api", kind: "eks_ssm", applicable: true,
      pumba: { ready: true, state: "ready", detail: "ok" },
      ingress: { present: true, healthy: true, detail: "ok" },
    });
    mockedApi.audit.mockResolvedValue([]);
    mockedApi.act.mockResolvedValue({
      outcome: { action: "net-verify", target: "gateway", dryRun: false, result: { service: "gateway", target: "10.0.0.1", sampled: 20, lossPercent: 0, rttMs: 2 } },
      auditId: null,
    });
    render(<App />);
    // Inventory row name is a click-through; clicking it lands on the detail page.
    await userEvent.click(await screen.findByRole("button", { name: /open gateway detail/i }));
    expect(await screen.findByRole("heading", { name: "gateway" })).toBeInTheDocument();
    expect(window.location.hash).toBe("#/service/api/gateway");
  });
});
