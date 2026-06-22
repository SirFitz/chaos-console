// packages/web/test/Console.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as api from "../src/api.js";
import type { ServiceStatus } from "@chaos/shared";
import { Console } from "../src/Console.js";

// Mock the network functions but keep the REAL ApiError class (the established
// importActual pattern) so any `instanceof ApiError` handling stays truthful.
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
    audit: vi.fn(),
  };
});
const mockedApi = vi.mocked(api);

const svc = (o: Partial<ServiceStatus>): ServiceStatus => ({ platformId: "mi", layer: "MI", name: "x", mapped: true, ...o });

beforeEach(() => {
  vi.resetAllMocks();
  window.location.hash = "";
  mockedApi.listPlatforms.mockResolvedValue([
    { id: "mi", layer: "MI", kind: "ecs", region: "us-east-1" },
  ]);
  mockedApi.services.mockResolvedValue([svc({ name: "payments", group: "Settlement", desired: 1, running: 1 })]);
  mockedApi.chaosActive.mockResolvedValue([]);
  mockedApi.audit.mockResolvedValue([]);
});

describe("<Console/> (authed operator)", () => {
  const user = { username: "op", role: "operator" as const };

  it("shows the DEV pill and the signed-in user", async () => {
    render(<Console user={user} onLogout={vi.fn()} />);
    expect(screen.getByText(/^DEV$/)).toBeInTheDocument();
    // username "op" appears in the sidebar footer (and top bar); at least one is present.
    expect(screen.getAllByText("op").length).toBeGreaterThan(0);
    await screen.findByText("payments");
  });

  it("navigates to the audit view", async () => {
    render(<Console user={user} onLogout={vi.fn()} />);
    await screen.findByText("payments");
    await userEvent.click(screen.getByRole("link", { name: /audit/i }));
    await waitFor(() => expect(mockedApi.audit).toHaveBeenCalled());
  });

  it("opens the action drawer via More -> Open actions", async () => {
    mockedApi.act.mockResolvedValue({ outcome: { action: "stop", target: "payments", dryRun: true, plan: { awsCall: "ecs:UpdateService", params: {} } }, auditId: "a1" });
    render(<Console user={user} onLogout={vi.fn()} />);
    const row = (await screen.findByText("payments")).closest("tr")!;
    await userEvent.click(within(row).getByRole("button", { name: /more/i }));
    await userEvent.click(screen.getByRole("menuitem", { name: /open actions/i }));
    expect(await screen.findByLabelText(/^action$/i)).toBeInTheDocument();
  });

  it("opens the network chaos drawer when Network is clicked", async () => {
    render(<Console user={user} onLogout={vi.fn()} />);
    const row = (await screen.findByText("payments")).closest("tr")!;
    await userEvent.click(within(row).getByRole("button", { name: /^network$/i }));
    expect(await screen.findByLabelText(/network chaos/i)).toBeInTheDocument();
  });

  it("logout button invokes onLogout", async () => {
    const onLogout = vi.fn();
    render(<Console user={user} onLogout={onLogout} />);
    await userEvent.click(screen.getByRole("button", { name: /sign out/i }));
    expect(onLogout).toHaveBeenCalled();
  });
});
