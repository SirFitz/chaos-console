// packages/web/test/AuditView.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as api from "../src/api.js";
import type { AuditRecord } from "@chaos/shared";
import { AuditView } from "../src/pages/AuditView.js";

// Mock the network functions but keep the REAL ApiError class (the established
// importActual pattern) so the view's `instanceof ApiError` handling stays truthful.
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
beforeEach(() => vi.resetAllMocks());

const rec = (o: Partial<AuditRecord>): AuditRecord => ({
  id: "1", ts: "2026-06-16T00:00:00Z", user: "o", role: "operator", platform: "mi",
  action: "stop", target: "svc", params: {}, dryRun: false, confirm: true, result: "success", ...o,
});

describe("<AuditView/>", () => {
  it("loads and renders audit rows", async () => {
    mockedApi.audit.mockResolvedValue([rec({ id: "1", action: "stop" }), rec({ id: "2", action: "start", confirm: false })]);
    render(<AuditView />);
    expect(await screen.findByText("stop")).toBeInTheDocument();
    expect(screen.getByText("start")).toBeInTheDocument();
    expect(mockedApi.audit).toHaveBeenCalledWith({ platform: undefined, user: undefined, limit: 100 });
  });

  it("re-queries with platform/user/limit filters", async () => {
    mockedApi.audit.mockResolvedValue([]);
    render(<AuditView />);
    await waitFor(() => expect(mockedApi.audit).toHaveBeenCalled());
    await userEvent.type(screen.getByLabelText(/platform/i), "api");
    await userEvent.type(screen.getByLabelText(/user/i), "alice");
    await userEvent.clear(screen.getByLabelText(/limit/i));
    await userEvent.type(screen.getByLabelText(/limit/i), "25");
    await userEvent.click(screen.getByRole("button", { name: /apply/i }));
    await waitFor(() =>
      expect(mockedApi.audit).toHaveBeenLastCalledWith({ platform: "api", user: "alice", limit: 25 }),
    );
  });

  it("shows an error result distinctly", async () => {
    mockedApi.audit.mockResolvedValue([rec({ id: "9", result: "error", error: "AccessDenied" })]);
    render(<AuditView />);
    expect(await screen.findByText(/AccessDenied/)).toBeInTheDocument();
  });

  it("renders a scale (start carrying from/count) as a 'scaled ... -> N' sentence", async () => {
    mockedApi.audit.mockResolvedValue([
      rec({ id: "1", action: "start", target: "bps-payments-svc", params: { count: 3, from: 2 } }),
      rec({ id: "2", action: "stop", target: "bps-payments-svc", params: { from: 2, confirm: true } }),
    ]);
    render(<AuditView />);
    expect(await screen.findByText("scaled bps-payments-svc 2 → 3")).toBeInTheDocument();
    expect(screen.getByText("scaled bps-payments-svc 2 → 0 (stop)")).toBeInTheDocument();
  });
});
