// packages/web/test/ServiceDetail.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as api from "../src/api.js";
import { ApiError } from "../src/api.js";
import type { AuditRecord, ServiceStatus } from "@chaos/shared";
import { ServiceDetail } from "../src/pages/ServiceDetail.js";

// Mock the network functions but keep the REAL ApiError class (the established
// importActual pattern) so `instanceof ApiError` handling stays truthful.
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

const eksPlatforms = [{ id: "api", layer: "API" as const, kind: "eks_ssm" as const, region: "us-east-1" }];
const ecsPlatforms = [{ id: "mi", layer: "MI" as const, kind: "ecs" as const, region: "us-east-1" }];

const svc = (o: Partial<ServiceStatus>): ServiceStatus => ({
  platformId: "api",
  layer: "API",
  name: "payments",
  mapped: true,
  ...o,
});

const verifyOutcome = (lossPercent: number, rttMs: number | null, target = "10.20.2.114") => ({
  outcome: {
    action: "net-verify" as const,
    target: "payments",
    dryRun: false,
    result: { service: "payments", target, sampled: 20, lossPercent, rttMs },
  },
  auditId: null,
});

// One raw 1s probe sample, as net-probe-tail returns them.
const rawSample = (t: number, ok: boolean, rtt: number | null = ok ? 1 : null) => ({ t, ok, rtt });
// Build a net-probe-tail outcome from raw samples.
const tailOutcome = (samples: ReturnType<typeof rawSample>[], podMissing = false) => ({
  outcome: { action: "net-probe-tail" as const, target: "payments", dryRun: false,
    result: podMissing ? { service: "payments", samples: [], podMissing: true } : { service: "payments", samples } },
  auditId: null,
});
const startOutcome = (target = "10.20.2.114") => ({
  outcome: { action: "net-probe-start" as const, target: "payments", dryRun: false,
    result: { service: "payments", probePod: "chaos-streamprobe-payments", target, started: true } },
  auditId: null,
});
const stopOutcome = () => ({
  outcome: { action: "net-probe-stop" as const, target: "payments", dryRun: false,
    result: { service: "payments", probePod: "chaos-streamprobe-payments", output: "deleted" } },
  auditId: null,
});

/**
 * Default act() router: the streaming chart fires net-probe-start/-tail/-stop and
 * the Active-chaos Verify button fires net-verify, so the shared mock dispatches
 * by action. `tail` lets a test supply the samples the next tail returns.
 */
function routeAct(tail: () => ReturnType<typeof tailOutcome> = () => tailOutcome([])) {
  mockedApi.act.mockImplementation((_id: string, action: string) => {
    if (action === "net-probe-start") return Promise.resolve(startOutcome() as any);
    if (action === "net-probe-tail") return Promise.resolve(tail() as any);
    if (action === "net-probe-stop") return Promise.resolve(stopOutcome() as any);
    return Promise.resolve(verifyOutcome(0, 2) as any); // net-verify default
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  // Sensible defaults; individual tests override.
  mockedApi.listPlatforms.mockResolvedValue(eksPlatforms);
  mockedApi.services.mockResolvedValue([svc({ desired: 2, running: 2, group: "Settlement", state: "RUNNING" })]);
  mockedApi.chaosActive.mockResolvedValue([{ platform: "api", kind: "eks_ssm", active: false, items: [], raw: null }]);
  mockedApi.audit.mockResolvedValue([]);
  // Default: a healthy stream (no chaos), and net-verify reads zero loss.
  routeAct();
});

describe("<ServiceDetail/> header + status", () => {
  it("renders the service name, platform/layer, and a live status pill + replica meter", async () => {
    render(<ServiceDetail platformId="api" name="payments" role="operator" onBack={vi.fn()} />);
    // Name in the page header (the TopBar provides the <h1> in the full shell;
    // rendered standalone here the name appears as a prominent label).
    expect(await screen.findByText("payments")).toBeInTheDocument();
    // Platform + layer context.
    expect(screen.getByText("API layer")).toBeInTheDocument();
    expect(screen.getByText("EKS")).toBeInTheDocument();
    // Live status derived from services(): 2/2 running -> Running pill + meter.
    expect(await screen.findByText("Running")).toBeInTheDocument();
    expect(screen.getByText("2 / 2")).toBeInTheDocument();
  });

  it("the back control invokes onBack", async () => {
    const onBack = vi.fn();
    render(<ServiceDetail platformId="api" name="payments" role="operator" onBack={onBack} />);
    await userEvent.click(await screen.findByRole("button", { name: /inventory/i }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});

describe("<ServiceDetail/> network chart (EKS streaming)", () => {
  it("starts the probe on mount and plots the tailed 1s samples", async () => {
    // The first tail returns three healthy 1s samples; the chart derives loss% +
    // latency from them and shows a numeric readout.
    routeAct(() => tailOutcome([rawSample(1700000001, true, 2), rawSample(1700000002, true, 3), rawSample(1700000003, true, 4)]));
    render(<ServiceDetail platformId="api" name="payments" role="operator" onBack={vi.fn()} />);

    // The probe is started on mount (operator + EKS).
    await waitFor(() => expect(mockedApi.act).toHaveBeenCalledWith("api", "net-probe-start", { service: "payments" }));
    // Then tailed; the chart renders an SVG with a readout reflecting the latest
    // sample (4 ms, 0% loss over a healthy window).
    await waitFor(() => expect(mockedApi.act).toHaveBeenCalledWith("api", "net-probe-tail", { service: "payments" }));
    expect(await screen.findByRole("img", { name: /network chart/i })).toBeInTheDocument();
    expect(await screen.findByText(/loss 0% · 4 ms/)).toBeInTheDocument();
  });

  it("derives a trailing-window loss% from dropped pings", async () => {
    // 4 samples, 2 of them lost → the latest point's trailing loss is 50%, and the
    // latest reply was lost so latency reads "no replies".
    routeAct(() => tailOutcome([
      rawSample(1700000001, true, 2),
      rawSample(1700000002, false),
      rawSample(1700000003, true, 3),
      rawSample(1700000004, false),
    ]));
    render(<ServiceDetail platformId="api" name="payments" role="operator" onBack={vi.fn()} />);
    expect(await screen.findByText(/loss 50% · no replies/)).toBeInTheDocument();
  });

  it("Refresh tails again on demand (a second tail call lands)", async () => {
    routeAct(() => tailOutcome([rawSample(1700000001, true, 5)]));
    render(<ServiceDetail platformId="api" name="payments" role="operator" onBack={vi.fn()} />);
    // Wait for the initial start+tail.
    await waitFor(() => expect(mockedApi.act.mock.calls.some((c) => c[1] === "net-probe-tail")).toBe(true));
    const before = mockedApi.act.mock.calls.filter((c) => c[1] === "net-probe-tail").length;
    await userEvent.click(await screen.findByRole("button", { name: /refresh payments stream now/i }));
    await waitFor(() =>
      expect(mockedApi.act.mock.calls.filter((c) => c[1] === "net-probe-tail").length).toBeGreaterThan(before),
    );
  });

  it("stops the probe pod on unmount (best-effort teardown)", async () => {
    routeAct(() => tailOutcome([rawSample(1700000001, true, 2)]));
    const { unmount } = render(<ServiceDetail platformId="api" name="payments" role="operator" onBack={vi.fn()} />);
    await waitFor(() => expect(mockedApi.act).toHaveBeenCalledWith("api", "net-probe-start", { service: "payments" }));
    unmount();
    await waitFor(() => expect(mockedApi.act).toHaveBeenCalledWith("api", "net-probe-stop", { service: "payments" }));
  });

  it("surfaces a probe error without tearing down the panel", async () => {
    mockedApi.act.mockImplementation((_id: string, action: string) => {
      if (action === "net-probe-start") return Promise.reject(new ApiError("NO_RUNNING_PODS", "no running pod for 'payments'", 502));
      return Promise.resolve(stopOutcome() as any);
    });
    render(<ServiceDetail platformId="api" name="payments" role="operator" onBack={vi.fn()} />);
    expect(await screen.findByText(/couldn.t stream: no running pod for 'payments'/i)).toBeInTheDocument();
    // The Refresh affordance is still there to retry.
    expect(screen.getByRole("button", { name: /refresh payments stream now/i })).toBeInTheDocument();
  });

  it("a viewer sees an operator-only note, not the live stream (no probe fired)", async () => {
    render(<ServiceDetail platformId="api" name="payments" role="viewer" onBack={vi.fn()} />);
    expect(await screen.findByText(/live measurement is operator-only/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /refresh/i })).not.toBeInTheDocument();
    // No probe action is fired for a viewer.
    expect(mockedApi.act).not.toHaveBeenCalled();
  });
});

describe("<ServiceDetail/> ECS", () => {
  it("shows the EKS-only note instead of a chart for an ECS service", async () => {
    mockedApi.listPlatforms.mockResolvedValue(ecsPlatforms);
    mockedApi.services.mockResolvedValue([
      svc({ platformId: "mi", layer: "MI", name: "settle", desired: 1, running: 1 }),
    ]);
    mockedApi.chaosActive.mockResolvedValue([{ platform: "mi", kind: "ecs", active: false, items: [], raw: null }]);
    render(<ServiceDetail platformId="mi" name="settle" role="operator" onBack={vi.fn()} />);
    expect(await screen.findByText(/live network measurement is EKS-only/i)).toBeInTheDocument();
    // No chart, no stream controls, and no probe action for ECS.
    expect(screen.queryByRole("img", { name: /network chart/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /refresh/i })).not.toBeInTheDocument();
    await waitFor(() => expect(mockedApi.listPlatforms).toHaveBeenCalled());
    expect(mockedApi.act).not.toHaveBeenCalled();
  });
});

describe("<ServiceDetail/> active chaos", () => {
  it("shows only chaos items targeting this service", async () => {
    mockedApi.chaosActive.mockResolvedValue([
      {
        platform: "api",
        kind: "eks_ssm",
        active: true,
        items: [
          { service: "payments", backend: "Pumba", summary: "payments · network fault injected (Pumba), active 2m" },
          { service: "ledger", backend: "Pumba", summary: "ledger · network fault injected (Pumba), active 9m" },
        ],
        raw: { output: "x" },
      },
    ]);
    render(<ServiceDetail platformId="api" name="payments" role="operator" onBack={vi.fn()} />);
    expect(await screen.findByText(/payments · network fault injected \(Pumba\), active 2m/)).toBeInTheDocument();
    // The other service's chaos is filtered out.
    expect(screen.queryByText(/ledger · network fault injected/)).not.toBeInTheDocument();
  });

  it("empty state when no chaos targets this service", async () => {
    render(<ServiceDetail platformId="api" name="payments" role="operator" onBack={vi.fn()} />);
    expect(await screen.findByText(/no active chaos on this service/i)).toBeInTheDocument();
  });
});

describe("<ServiceDetail/> action timeline", () => {
  const rec = (o: Partial<AuditRecord>): AuditRecord => ({
    id: "1",
    ts: "2026-06-16T00:00:00Z",
    user: "op",
    role: "operator",
    platform: "api",
    action: "restart",
    target: "payments",
    params: {},
    dryRun: false,
    confirm: false,
    result: "success",
    ...o,
  });

  it("filters audit to this service's target and renders newest first", async () => {
    mockedApi.audit.mockResolvedValue([
      rec({ id: "a", target: "payments", action: "restart", ts: "2026-06-16T00:00:00Z" }),
      rec({ id: "b", target: "ledger", action: "stop", ts: "2026-06-16T01:00:00Z" }),
      rec({ id: "c", target: "payments", action: "start", params: { count: 3, from: 2 }, ts: "2026-06-16T02:00:00Z" }),
    ]);
    render(<ServiceDetail platformId="api" name="payments" role="operator" onBack={vi.fn()} />);

    // Only payments records appear; the ledger stop is excluded.
    const scaled = await screen.findByText("scaled payments 2 → 3");
    expect(scaled).toBeInTheDocument();
    expect(screen.getByText("restart")).toBeInTheDocument();
    expect(screen.queryByText("stop")).not.toBeInTheDocument();

    // Newest first: the later "start"/scaled record (02:00) precedes the
    // "restart" (00:00) in document order.
    const items = screen.getAllByRole("listitem");
    const scaledIdx = items.findIndex((li) => within(li).queryByText("scaled payments 2 → 3"));
    const restartIdx = items.findIndex((li) => within(li).queryByText("restart"));
    expect(scaledIdx).toBeGreaterThanOrEqual(0);
    expect(restartIdx).toBeGreaterThan(scaledIdx);

    // The audit fetch is scoped to the platform (client-side filter does the rest).
    expect(mockedApi.audit).toHaveBeenCalledWith({ platform: "api" });
  });

  it("empty state when no records target this service", async () => {
    mockedApi.audit.mockResolvedValue([rec({ id: "z", target: "ledger" })]);
    render(<ServiceDetail platformId="api" name="payments" role="operator" onBack={vi.fn()} />);
    expect(await screen.findByText(/no actions recorded for this service/i)).toBeInTheDocument();
  });

  it("renders a failed action distinctly", async () => {
    mockedApi.audit.mockResolvedValue([
      rec({ id: "e", target: "payments", action: "net-loss", result: "error", error: "AccessDenied" }),
    ]);
    render(<ServiceDetail platformId="api" name="payments" role="operator" onBack={vi.fn()} />);
    expect(await screen.findByText(/AccessDenied/)).toBeInTheDocument();
  });
});
