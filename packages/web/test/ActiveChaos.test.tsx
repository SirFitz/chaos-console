// packages/web/test/ActiveChaos.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as api from "../src/api.js";
import { ApiError } from "../src/api.js";
import { ActiveChaos } from "../src/pages/ActiveChaos.js";

// Mock the network functions but keep the REAL ApiError class (the established
// pattern from the api/auth/Login tests) so the panel's `instanceof ApiError`
// error handling and `.message` stay truthful.
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

describe("<ActiveChaos/>", () => {
  it("shows each active item as a plain sentence and isolates per-platform errors", async () => {
    mockedApi.chaosActive.mockResolvedValue([
      {
        platform: "api",
        active: true,
        items: [{ service: "payments", backend: "Chaos Mesh", summary: "payments · packet loss injected (Chaos Mesh), active 5s" }],
        raw: { output: "chaos-nc-payments loss 5s" },
      },
      { platform: "mi", active: false, items: [], raw: null, error: "AccessDenied" },
    ]);
    render(<ActiveChaos role="operator" />);
    // plain-language sentence, not a raw kubectl table
    expect(await screen.findByText(/payments · packet loss injected \(Chaos Mesh\), active 5s/)).toBeInTheDocument();
    // raw lives behind a collapsed <details> disclosure (closed by default)
    const details = screen.getByText("Details").closest("details")!;
    expect(details.open).toBe(false);
    // per-platform error surfaces as a degraded line
    expect(screen.getByText(/AccessDenied/)).toBeInTheDocument();
  });

  it("reveals the raw output behind a Details disclosure", async () => {
    mockedApi.chaosActive.mockResolvedValue([
      {
        platform: "api",
        active: true,
        items: [{ service: "dep", summary: "dep · network fault injected (Pumba), active 1m" }],
        raw: { output: "chaos-pumba-dep 1/1 Running 0 1m" },
      },
    ]);
    render(<ActiveChaos role="operator" />);
    const details = await screen.findByText("Details");
    await userEvent.click(details);
    expect(screen.getByText(/chaos-pumba-dep 1\/1 Running 0 1m/)).toBeInTheDocument();
  });

  it("does not list clear platforms; shows the empty state when nothing is active", async () => {
    mockedApi.chaosActive.mockResolvedValue([{ platform: "api", active: false, items: [], raw: { output: "" } }]);
    render(<ActiveChaos role="operator" />);
    expect(await screen.findByText("No active chaos.")).toBeInTheDocument();
    expect(screen.queryByText("api")).not.toBeInTheDocument();
  });

  it("operator can one-click net-clear an active platform, then it refetches", async () => {
    mockedApi.chaosActive
      .mockResolvedValueOnce([
        { platform: "api", active: true, items: [{ summary: "dep · packet loss injected (Chaos Mesh), active 5s" }], raw: { output: "x" } },
      ])
      .mockResolvedValueOnce([{ platform: "api", active: false, items: [], raw: { output: "" } }]);
    mockedApi.act.mockResolvedValue({ outcome: { action: "net-clear", target: null, dryRun: false, result: {} }, auditId: "a1" });
    render(<ActiveChaos role="operator" />);
    await screen.findByText(/dep · packet loss injected/);
    await userEvent.click(screen.getByRole("button", { name: /clear/i }));
    await waitFor(() => expect(mockedApi.act).toHaveBeenCalledWith("api", "net-clear", {}));
    await waitFor(() => expect(mockedApi.chaosActive).toHaveBeenCalledTimes(2));
  });

  it("viewer sees no clear buttons", async () => {
    mockedApi.chaosActive.mockResolvedValue([
      { platform: "api", active: true, items: [{ summary: "dep · network fault injected (Pumba), active 1m" }], raw: { output: "x" } },
    ]);
    render(<ActiveChaos role="viewer" />);
    await screen.findByText(/dep · network fault injected/);
    expect(screen.queryByRole("button", { name: /clear/i })).not.toBeInTheDocument();
  });
});

describe("<ActiveChaos/> verify probe", () => {
  const eksActive = (service = "payments") => [
    {
      platform: "api",
      kind: "eks_ssm" as const,
      active: true,
      items: [{ service, backend: "Pumba", summary: `${service} · network fault injected (Pumba), active 2m` }],
      raw: { output: "x" },
    },
  ];

  it("operator can Verify an EKS item; it calls net-verify and renders the measurement", async () => {
    mockedApi.chaosActive.mockResolvedValue(eksActive("payments"));
    mockedApi.act.mockResolvedValue({
      outcome: { action: "net-verify", target: "payments", dryRun: false,
        result: { service: "payments", target: "10.20.2.114", sampled: 20, lossPercent: 47, rttMs: 205.1, raw: "..." } },
      auditId: null,
    });
    render(<ActiveChaos role="operator" />);
    await userEvent.click(await screen.findByRole("button", { name: /verify packet chaos on payments/i }));
    await waitFor(() => expect(mockedApi.act).toHaveBeenCalledWith("api", "net-verify", { service: "payments" }));
    // plain-language measurement next to the configured summary
    expect(await screen.findByText(/Measured: 47% packet loss · ~205\.1 ms avg \(20 pings to 10\.20\.2\.114\)/)).toBeInTheDocument();
    // re-run affordance after a successful measure
    expect(screen.getByRole("button", { name: /verify packet chaos on payments/i })).toHaveTextContent(/re-verify/i);
  });

  it("shows a loading state while the probe runs (button busy, no measurement yet)", async () => {
    mockedApi.chaosActive.mockResolvedValue(eksActive("payments"));
    let resolve!: (v: { outcome: any; auditId: string | null }) => void;
    mockedApi.act.mockReturnValue(new Promise((r) => { resolve = r; }));
    render(<ActiveChaos role="operator" />);
    const btn = await screen.findByRole("button", { name: /verify packet chaos on payments/i });
    await userEvent.click(btn);
    // button enters busy/disabled state; a measuring caption appears
    await waitFor(() => expect(btn).toBeDisabled());
    expect(screen.getByText(/measuring/i)).toBeInTheDocument();
    // settle the promise so the test ends cleanly
    resolve({ outcome: { action: "net-verify", target: "payments", dryRun: false,
      result: { service: "payments", target: "10.0.0.1", sampled: 20, lossPercent: 0, rttMs: 2 } }, auditId: null });
    await screen.findByText(/Measured:/);
  });

  it("surfaces a probe error with a re-run affordance", async () => {
    mockedApi.chaosActive.mockResolvedValue(eksActive("payments"));
    mockedApi.act.mockRejectedValue(new ApiError("ACTION_FAILED", "no running pod for 'payments'", 502));
    render(<ActiveChaos role="operator" />);
    await userEvent.click(await screen.findByRole("button", { name: /verify packet chaos on payments/i }));
    expect(await screen.findByText(/couldn.t measure: no running pod for 'payments'/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /verify packet chaos on payments/i })).toHaveTextContent(/re-verify/i);
  });

  it("does not offer Verify for ECS items; notes that verification is EKS-only", async () => {
    mockedApi.chaosActive.mockResolvedValue([
      {
        platform: "mi",
        kind: "ecs" as const,
        active: true,
        items: [{ backend: "Subnet ACL", summary: "Blocking 203.0.113.10/32 on subnet ACL acl-1" }],
        raw: { entries: [{ cidr: "203.0.113.10/32" }] },
      },
    ]);
    render(<ActiveChaos role="operator" />);
    await screen.findByText(/Blocking 203\.0\.113\.10\/32/);
    expect(screen.queryByRole("button", { name: /verify/i })).not.toBeInTheDocument();
    expect(screen.getByText(/empirical verification is EKS-only/i)).toBeInTheDocument();
  });

  it("viewer sees no Verify button on an EKS item", async () => {
    mockedApi.chaosActive.mockResolvedValue(eksActive("payments"));
    render(<ActiveChaos role="viewer" />);
    await screen.findByText(/payments · network fault injected/);
    expect(screen.queryByRole("button", { name: /verify/i })).not.toBeInTheDocument();
  });

  it("does NOT offer Verify for an L7 path item (ingress-nginx) on an EKS platform", async () => {
    // The verify probe is L4 (ICMP to a pod); it is meaningless for a path
    // fault that lives in ingress-nginx, so it must be gated off path items.
    mockedApi.chaosActive.mockResolvedValue([
      {
        platform: "api",
        kind: "eks_ssm" as const,
        active: true,
        items: [
          { service: "charge", backend: "ingress-nginx", summary: "charge · path fault injected (ingress-nginx), active 2m" },
        ],
        raw: { output: "ingress/charge-chaos" },
      },
    ]);
    render(<ActiveChaos role="operator" />);
    await screen.findByText(/charge · path fault injected \(ingress-nginx\), active 2m/);
    // no L4 verify affordance on a path item
    expect(screen.queryByRole("button", { name: /verify/i })).not.toBeInTheDocument();
    // and it is not mislabelled as ECS-only either
    expect(screen.queryByText(/empirical verification is EKS-only/i)).not.toBeInTheDocument();
    // the per-platform Clear still clears the overlay server-side
    await userEvent.click(screen.getByRole("button", { name: /^clear$/i }));
    await waitFor(() => expect(mockedApi.act).toHaveBeenCalledWith("api", "net-clear", {}));
  });
});
