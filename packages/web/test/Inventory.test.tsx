// packages/web/test/Inventory.test.tsx
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, within, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as api from "../src/api.js";
import type { ServiceStatus } from "@chaos/shared";
import { Inventory } from "../src/pages/Inventory.js";

// Keep the REAL ApiError (the importActual pattern) so ScaleControl's
// `instanceof ApiError` error handling stays truthful when rendered in rows.
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

const platforms = [
  { id: "api", layer: "API" as const, kind: "eks_ssm" as const, region: "us-east-1" },
  { id: "mi", layer: "MI" as const, kind: "ecs" as const, region: "us-east-1" },
];
const svc = (o: Partial<ServiceStatus>): ServiceStatus => ({ platformId: "mi", layer: "MI", name: "x", mapped: true, ...o });

beforeEach(() => {
  vi.resetAllMocks();
  mockedApi.listPlatforms.mockResolvedValue(platforms);
  // Backend-health chip polls per EKS platform; default to a ready chip so it
  // renders without affecting the row/scale assertions below.
  mockedApi.health.mockResolvedValue({
    platform: "api",
    kind: "eks_ssm",
    applicable: true,
    pumba: { ready: true, state: "ready", detail: "Backends ready." },
    ingress: { present: true, healthy: true, detail: "ingress-nginx healthy." },
  });
  mockedApi.services.mockImplementation(async (id: string) =>
    id === "api"
      ? [svc({ platformId: "api", layer: "API", name: "gateway", group: "Edge", desired: 2, running: 2 })]
      : [
          svc({ name: "payments", group: "Settlement", desired: 1, running: 1, state: "ACTIVE" }),
          svc({ name: "ledger", group: "Settlement", desired: 1, running: 0, state: "STOPPED" }),
          svc({ name: "orphan", mapped: false }),
        ],
  );
});
afterEach(() => vi.useRealTimers());

describe("<Inventory/> (operator)", () => {
  it("renders layer + group headers and service rows", async () => {
    render(<Inventory role="operator" onAct={vi.fn()} onNetwork={vi.fn()} onOpenService={vi.fn()} />);
    expect(await screen.findByText("payments")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /^API$/ })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /^MI$/ })).toBeInTheDocument();
    expect(screen.getByText(/Settlement/)).toBeInTheDocument();
    expect(screen.getByText(/Unmapped/)).toBeInTheDocument();
  });

  it("filters rows by the search box", async () => {
    render(<Inventory role="operator" onAct={vi.fn()} onNetwork={vi.fn()} onOpenService={vi.fn()} />);
    await screen.findByText("payments");
    await userEvent.type(screen.getByPlaceholderText(/filter/i), "ledger");
    await waitFor(() => expect(screen.queryByText("payments")).not.toBeInTheDocument());
    expect(screen.getByText("ledger")).toBeInTheDocument();
  });

  it("marks stopped services with a Stopped status pill", async () => {
    render(<Inventory role="operator" onAct={vi.fn()} onNetwork={vi.fn()} onOpenService={vi.fn()} />);
    const ledgerRow = (await screen.findByText("ledger")).closest("tr")!;
    // ledger has running:0 desired:1 (and state STOPPED) -> StatusPill reads "Stopped".
    expect(within(ledgerRow).getByText("Stopped")).toBeInTheDocument();
  });

  it("shows the running/desired counts inline per row via the replica meter", async () => {
    render(<Inventory role="operator" onAct={vi.fn()} onNetwork={vi.fn()} onOpenService={vi.fn()} />);
    const paymentsRow = (await screen.findByText("payments")).closest("tr")!;
    expect(within(paymentsRow).getByText("1 / 1")).toBeInTheDocument();
    const gatewayRow = (await screen.findByText("gateway")).closest("tr")!;
    expect(within(gatewayRow).getByText("2 / 2")).toBeInTheDocument();
  });

  it("the inline + stepper edits the target, and Scale submits it once via start", async () => {
    mockedApi.act.mockResolvedValue({ outcome: { action: "start", target: "payments", dryRun: false, result: { desiredCount: 2 } }, auditId: "a1" });
    render(<Inventory role="operator" onAct={vi.fn()} onNetwork={vi.fn()} onOpenService={vi.fn()} />);
    const row = (await screen.findByText("payments")).closest("tr")!;
    // Stepping alone fires no request.
    await userEvent.click(within(row).getByRole("button", { name: /scale up/i }));
    expect(mockedApi.act).not.toHaveBeenCalled();
    // Scale submits the dialed-in target (1 -> 2) exactly once, carrying `from`.
    await userEvent.click(within(row).getByRole("button", { name: /^scale$/i }));
    await waitFor(() =>
      expect(mockedApi.act).toHaveBeenCalledWith("mi", "start", expect.objectContaining({ service: "payments", count: 2, from: 1 })),
    );
    expect(mockedApi.act).toHaveBeenCalledTimes(1);
  });

  it("scaling optimistically shows the new desired before any poll lands", async () => {
    // Hold the action open so we observe the optimistic state mid-flight.
    type ActResult = Awaited<ReturnType<typeof api.act>>;
    let resolveAct: (v: ActResult) => void = () => {};
    mockedApi.act.mockImplementation(() => new Promise<ActResult>((res) => (resolveAct = res)));
    render(<Inventory role="operator" onAct={vi.fn()} onNetwork={vi.fn()} onOpenService={vi.fn()} />);
    const row = (await screen.findByText("payments")).closest("tr")!;
    expect(within(row).getByText("1 / 1")).toBeInTheDocument();
    await userEvent.click(within(row).getByRole("button", { name: /scale up/i }));
    await userEvent.click(within(row).getByRole("button", { name: /^scale$/i }));
    // Optimistic: meter jumps to 1 / 2 and the pill reads Scaling while in flight,
    // even though services() still reports 1 / 1.
    await waitFor(() => expect(within(row).getByText("1 / 2")).toBeInTheDocument());
    expect(within(row).getByText("Scaling")).toBeInTheDocument();
    // Let the action settle + reconcile cleanly (avoids an act() warning).
    await act(async () => {
      resolveAct({ outcome: { action: "start", target: "payments", dryRun: false, result: { desiredCount: 2 } }, auditId: "a1" });
    });
  });

  it("the More menu's Open actions opens the action drawer (onAct) for operators", async () => {
    const onAct = vi.fn();
    render(<Inventory role="operator" onAct={onAct} onNetwork={vi.fn()} onOpenService={vi.fn()} />);
    const row = (await screen.findByText("payments")).closest("tr")!;
    await userEvent.click(within(row).getByRole("button", { name: /more/i }));
    await userEvent.click(screen.getByRole("menuitem", { name: /open actions/i }));
    expect(onAct).toHaveBeenCalledTimes(1);
    expect(onAct.mock.calls[0][0]).toMatchObject({ platformId: "mi", name: "payments" });
  });

  it("shows a Network button per service for operators and calls onNetwork", async () => {
    const onNetwork = vi.fn();
    render(<Inventory role="operator" onAct={vi.fn()} onNetwork={onNetwork} onOpenService={vi.fn()} />);
    const row = (await screen.findByText("payments")).closest("tr")!;
    await userEvent.click(within(row).getByRole("button", { name: /network/i }));
    expect(onNetwork).toHaveBeenCalledTimes(1);
    expect(onNetwork.mock.calls[0][0]).toMatchObject({ platformId: "mi", name: "payments" });
  });

  it("clicking a service name navigates to its detail page (onOpenService)", async () => {
    const onOpenService = vi.fn();
    render(<Inventory role="operator" onAct={vi.fn()} onNetwork={vi.fn()} onOpenService={onOpenService} />);
    // The name itself is the click-through (a button), distinct from the row's
    // Network/More action buttons.
    await userEvent.click(await screen.findByRole("button", { name: /open payments detail/i }));
    expect(onOpenService).toHaveBeenCalledTimes(1);
    expect(onOpenService.mock.calls[0][0]).toMatchObject({ platformId: "mi", name: "payments" });
  });

  it("polls services again after 10s", async () => {
    vi.useFakeTimers();
    render(<Inventory role="operator" onAct={vi.fn()} onNetwork={vi.fn()} onOpenService={vi.fn()} />);
    await vi.waitFor(() => expect(mockedApi.services).toHaveBeenCalled());
    const firstCount = mockedApi.services.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(mockedApi.services.mock.calls.length).toBeGreaterThan(firstCount);
  });

  it("refetches on the Refresh button", async () => {
    render(<Inventory role="operator" onAct={vi.fn()} onNetwork={vi.fn()} onOpenService={vi.fn()} />);
    await screen.findByText("payments");
    const before = mockedApi.services.mock.calls.length;
    await userEvent.click(screen.getByRole("button", { name: /refresh/i }));
    await waitFor(() => expect(mockedApi.services.mock.calls.length).toBeGreaterThan(before));
  });
});

describe("<Inventory/> (viewer)", () => {
  it("shows the counts but no action/network/scale buttons", async () => {
    render(<Inventory role="viewer" onAct={vi.fn()} onNetwork={vi.fn()} onOpenService={vi.fn()} />);
    const row = (await screen.findByText("payments")).closest("tr")!;
    expect(within(row).getByText("1 / 1")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /more/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /network/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /scale up/i })).not.toBeInTheDocument();
  });
});
