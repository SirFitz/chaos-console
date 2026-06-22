// packages/web/test/ChaosDrawer.network.test.tsx
// The network-only chaos surface (mode="network"), opened from a row's Network button.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as api from "../src/api.js";
import type { ServiceStatus } from "@chaos/shared";
import { ChaosDrawer } from "../src/components/ChaosDrawer.js";

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

const ecsSvc: ServiceStatus = { platformId: "mi", layer: "MI", name: "payments", mapped: true, desired: 1, running: 1 };
const eksSvc: ServiceStatus = { platformId: "api", layer: "API", name: "gateway", mapped: true, desired: 2, running: 2 };

function open(svc: ServiceStatus, kind: "ecs" | "eks_ssm", role: "operator" | "viewer" = "operator") {
  render(<ChaosDrawer service={svc} kind={kind} role={role} mode="network" onClose={vi.fn()} onDone={vi.fn()} />);
}

// The network picker is labelled "Network chaos".
const picker = () => screen.getByLabelText(/network chaos/i);

describe("<ChaosDrawer mode=network/> (ecs)", () => {
  it("offers blackhole/clear but not net-status (a read) or eks-only/scaling actions", () => {
    open(ecsSvc, "ecs");
    const select = picker() as HTMLSelectElement;
    const values = Array.from(select.options).map((o) => o.value);
    expect(values).toContain("net-block");
    expect(values).toContain("net-clear");
    // net-status is a read — it lives in the live Active Chaos panel, not here.
    expect(values).not.toContain("net-status");
    expect(values).not.toContain("net-loss");
    expect(values).not.toContain("stop");
  });

  it("shows plain-language help for the selected action", async () => {
    open(ecsSvc, "ecs");
    await userEvent.selectOptions(picker(), "net-block");
    expect(screen.getByText(/deny traffic to\/from a cidr at the subnet nacl/i)).toBeInTheDocument();
  });

  it("blackhole shows a CIDR field and posts it (dry-run sends dryRun:true)", async () => {
    mockedApi.act.mockResolvedValue({ outcome: { action: "net-block", target: "203.0.113.10/32", dryRun: true, plan: { awsCall: "ec2:CreateNetworkAclEntry", params: {} } }, auditId: "a1" });
    open(ecsSvc, "ecs");
    await userEvent.selectOptions(picker(), "net-block");
    await userEvent.type(screen.getByLabelText(/cidr/i), "203.0.113.10/32");
    await userEvent.click(screen.getByLabelText(/dry.?run/i));
    await userEvent.click(screen.getByRole("button", { name: /^run$/i }));
    await waitFor(() =>
      expect(mockedApi.act).toHaveBeenCalledWith("mi", "net-block", expect.objectContaining({ cidr: "203.0.113.10/32", dryRun: true })),
    );
    expect(mockedApi.act.mock.calls[0][2]).not.toHaveProperty("confirm", true);
    expect(await screen.findByText(/ec2:CreateNetworkAclEntry/)).toBeInTheDocument();
    expect(screen.getByText(/a1/)).toBeInTheDocument();
  });

  it("blackhole (live) is destructive -> opens confirm before firing", async () => {
    mockedApi.act.mockResolvedValue({ outcome: { action: "net-block", target: "10.0.0.5/32", dryRun: false, result: {} }, auditId: "a2" });
    open(ecsSvc, "ecs");
    await userEvent.selectOptions(picker(), "net-block");
    await userEvent.type(screen.getByLabelText(/cidr/i), "10.0.0.5/32");
    await userEvent.click(screen.getByRole("button", { name: /^run$/i }));
    expect(mockedApi.act).not.toHaveBeenCalled();
    expect(screen.getByText(/destructive action/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /^run blackhole cidr$/i }));
    await waitFor(() =>
      expect(mockedApi.act).toHaveBeenCalledWith("mi", "net-block", expect.objectContaining({ cidr: "10.0.0.5/32", confirm: true })),
    );
  });
});

describe("<ChaosDrawer mode=network/> (eks_ssm)", () => {
  it("offers throttle actions (loss/delay/partition) + clear, no blackhole, no net-status", () => {
    open(eksSvc, "eks_ssm");
    const select = picker() as HTMLSelectElement;
    const values = Array.from(select.options).map((o) => o.value);
    expect(values).toContain("net-loss");
    expect(values).toContain("net-delay");
    expect(values).toContain("net-partition");
    expect(values).toContain("net-clear");
    // net-status is a read — discovery lives in the live Active Chaos panel.
    expect(values).not.toContain("net-status");
    expect(values).not.toContain("net-block");
  });

  it("partition shows direction + duration but NOT a loss% field (it forces 100%)", async () => {
    open(eksSvc, "eks_ssm");
    await userEvent.selectOptions(picker(), "net-partition");
    expect(screen.getByLabelText(/direction/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/duration/i)).toBeInTheDocument();
    // The loss% field must be absent — partition is a full cut-off, not a tunable drop.
    expect(screen.queryByLabelText(/loss %/i)).not.toBeInTheDocument();
    // And the help line explains the full cut-off.
    expect(screen.getByText(/isolate the service/i)).toBeInTheDocument();
  });

  it("partition posts direction + duration with no loss in the request body", async () => {
    mockedApi.act.mockResolvedValue({ outcome: { action: "net-partition", target: "gateway", dryRun: false, result: {} }, auditId: "p1" });
    open(eksSvc, "eks_ssm");
    await userEvent.selectOptions(picker(), "net-partition");
    await userEvent.selectOptions(screen.getByLabelText(/direction/i), "both");
    await userEvent.type(screen.getByLabelText(/duration/i), "5m");
    await userEvent.click(screen.getByRole("button", { name: /^run$/i }));
    // destructive -> confirm first
    await userEvent.click(screen.getByRole("button", { name: /^run partition$/i }));
    await waitFor(() =>
      expect(mockedApi.act).toHaveBeenCalledWith(
        "api",
        "net-partition",
        expect.objectContaining({ direction: "both", duration: "5m", confirm: true }),
      ),
    );
    // No loss field was sent (the engine forces 100% server-side).
    expect(mockedApi.act.mock.calls[0][2]).not.toHaveProperty("loss");
  });

  it("packet loss exposes loss + direction + duration and posts them (after confirm)", async () => {
    mockedApi.act.mockResolvedValue({ outcome: { action: "net-loss", target: "gateway", dryRun: false, result: {} }, auditId: "a3" });
    open(eksSvc, "eks_ssm");
    await userEvent.selectOptions(picker(), "net-loss");
    await userEvent.clear(screen.getByLabelText(/loss %/i));
    await userEvent.type(screen.getByLabelText(/loss %/i), "40");
    await userEvent.selectOptions(screen.getByLabelText(/direction/i), "both");
    await userEvent.type(screen.getByLabelText(/duration/i), "5m");
    await userEvent.click(screen.getByRole("button", { name: /^run$/i }));
    expect(mockedApi.act).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: /^run packet loss$/i }));
    await waitFor(() =>
      expect(mockedApi.act).toHaveBeenCalledWith(
        "api",
        "net-loss",
        expect.objectContaining({ loss: 40, direction: "both", duration: "5m", confirm: true }),
      ),
    );
  });

  it("latency exposes a delay field and posts it (dry-run)", async () => {
    mockedApi.act.mockResolvedValue({ outcome: { action: "net-delay", target: "gateway", dryRun: true, plan: { awsCall: "ssm:SendCommand", params: {} } }, auditId: "a4" });
    open(eksSvc, "eks_ssm");
    await userEvent.selectOptions(picker(), "net-delay");
    await userEvent.clear(screen.getByLabelText(/delay/i));
    await userEvent.type(screen.getByLabelText(/delay/i), "300ms");
    await userEvent.click(screen.getByLabelText(/dry.?run/i));
    await userEvent.click(screen.getByRole("button", { name: /^run$/i }));
    await waitFor(() =>
      expect(mockedApi.act).toHaveBeenCalledWith("api", "net-delay", expect.objectContaining({ delay: "300ms", dryRun: true })),
    );
  });

  it("clear network chaos is non-destructive -> no confirm, fires immediately", async () => {
    mockedApi.act.mockResolvedValue({ outcome: { action: "net-clear", target: "gateway", dryRun: false, result: { output: "deleted" } }, auditId: "a5" });
    open(eksSvc, "eks_ssm");
    await userEvent.selectOptions(picker(), "net-clear");
    await userEvent.click(screen.getByRole("button", { name: /^run$/i }));
    await waitFor(() => expect(mockedApi.act).toHaveBeenCalledWith("api", "net-clear", expect.objectContaining({ service: "gateway" })));
    expect(screen.queryByText(/destructive action/i)).not.toBeInTheDocument();
  });
});

describe("<ChaosDrawer mode=network/> (eks_ssm) L7 path chaos", () => {
  it("offers cut/throttle/clear path; net-preflight is never selectable", () => {
    open(eksSvc, "eks_ssm");
    const values = Array.from((picker() as HTMLSelectElement).options).map((o) => o.value);
    expect(values).toContain("net-path-cut");
    expect(values).toContain("net-path-degrade");
    expect(values).toContain("net-path-clear");
    expect(values).not.toContain("net-preflight");
  });

  it("cut path exposes an optional path + host field and explains itself", async () => {
    open(eksSvc, "eks_ssm");
    await userEvent.selectOptions(picker(), "net-path-cut");
    expect(screen.getByLabelText(/^path$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^host$/i)).toBeInTheDocument();
    // No degrade-percent field on a cut (cut is always 100%).
    expect(screen.queryByLabelText(/percent of requests to fail/i)).not.toBeInTheDocument();
    expect(screen.getByText(/return 503 for this ingress path/i)).toBeInTheDocument();
  });

  it("degrade path adds a fail-percent field (default 50) and explains itself", async () => {
    open(eksSvc, "eks_ssm");
    await userEvent.selectOptions(picker(), "net-path-degrade");
    const pct = screen.getByLabelText(/percent of requests to fail/i) as HTMLInputElement;
    expect(pct).toBeInTheDocument();
    expect(pct.value).toBe("50");
    expect(screen.getByText(/fail a percentage of requests on this ingress path/i)).toBeInTheDocument();
  });

  it("cut path dry-run previews the host/path that will be hit (no confirm)", async () => {
    mockedApi.act.mockResolvedValue({
      outcome: {
        action: "net-path-cut",
        target: "charge",
        dryRun: true,
        plan: {
          awsCall: "kubectl:apply",
          params: { mode: "cut", objects: ["ingress/charge-chaos"], paths: [{ host: "api.dev", path: "/charge" }], manifest: "..." },
        },
      },
      auditId: "p1",
    });
    open(eksSvc, "eks_ssm");
    await userEvent.selectOptions(picker(), "net-path-cut");
    await userEvent.type(screen.getByLabelText(/^path$/i), "/charge");
    await userEvent.click(screen.getByLabelText(/dry.?run/i));
    await userEvent.click(screen.getByRole("button", { name: /^run$/i }));
    await waitFor(() =>
      expect(mockedApi.act).toHaveBeenCalledWith("api", "net-path-cut", expect.objectContaining({ path: "/charge", dryRun: true })),
    );
    // dry-run must not carry confirm
    expect(mockedApi.act.mock.calls[0][2]).not.toHaveProperty("confirm", true);
    // the preview shows the concrete host/path the operator is about to cut
    expect(await screen.findByText(/api\.dev\/charge/)).toBeInTheDocument();
  });

  it("cut path (live) is destructive -> confirm, then posts confirm:true with the path", async () => {
    mockedApi.act.mockResolvedValue({ outcome: { action: "net-path-cut", target: "charge", dryRun: false, result: {} }, auditId: "p2" });
    open(eksSvc, "eks_ssm");
    await userEvent.selectOptions(picker(), "net-path-cut");
    await userEvent.type(screen.getByLabelText(/^path$/i), "/charge");
    await userEvent.click(screen.getByRole("button", { name: /^run$/i }));
    expect(mockedApi.act).not.toHaveBeenCalled();
    expect(screen.getByText(/destructive action/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /^run cut path$/i }));
    await waitFor(() =>
      expect(mockedApi.act).toHaveBeenCalledWith("api", "net-path-cut", expect.objectContaining({ path: "/charge", confirm: true })),
    );
  });

  it("degrade path posts host + path + loss% after confirm", async () => {
    mockedApi.act.mockResolvedValue({ outcome: { action: "net-path-degrade", target: "charge", dryRun: false, result: {} }, auditId: "p3" });
    open(eksSvc, "eks_ssm");
    await userEvent.selectOptions(picker(), "net-path-degrade");
    await userEvent.type(screen.getByLabelText(/^path$/i), "/charge");
    await userEvent.type(screen.getByLabelText(/^host$/i), "api.dev");
    await userEvent.clear(screen.getByLabelText(/percent of requests to fail/i));
    await userEvent.type(screen.getByLabelText(/percent of requests to fail/i), "40");
    await userEvent.click(screen.getByRole("button", { name: /^run$/i }));
    await userEvent.click(screen.getByRole("button", { name: /^run degrade path$/i }));
    await waitFor(() =>
      expect(mockedApi.act).toHaveBeenCalledWith(
        "api",
        "net-path-degrade",
        expect.objectContaining({ path: "/charge", host: "api.dev", loss: 40, confirm: true }),
      ),
    );
  });

  it("blank path means all paths: cut omits path/host from the request", async () => {
    mockedApi.act.mockResolvedValue({ outcome: { action: "net-path-cut", target: null, dryRun: false, result: {} }, auditId: "p4" });
    open(eksSvc, "eks_ssm");
    await userEvent.selectOptions(picker(), "net-path-cut");
    await userEvent.click(screen.getByRole("button", { name: /^run$/i }));
    await userEvent.click(screen.getByRole("button", { name: /^run cut path$/i }));
    await waitFor(() => expect(mockedApi.act).toHaveBeenCalled());
    const body = mockedApi.act.mock.calls[0][2];
    expect(body).not.toHaveProperty("path");
    expect(body).not.toHaveProperty("host");
    expect(body).toMatchObject({ confirm: true });
  });

  it("clear path chaos is non-destructive -> fires immediately, no confirm", async () => {
    mockedApi.act.mockResolvedValue({ outcome: { action: "net-path-clear", target: "charge", dryRun: false, result: { output: "removed" } }, auditId: "p5" });
    open(eksSvc, "eks_ssm");
    await userEvent.selectOptions(picker(), "net-path-clear");
    await userEvent.click(screen.getByRole("button", { name: /^run$/i }));
    await waitFor(() => expect(mockedApi.act).toHaveBeenCalledWith("api", "net-path-clear", expect.objectContaining({ service: "gateway" })));
    expect(screen.queryByText(/destructive action/i)).not.toBeInTheDocument();
  });
});

describe("<ChaosDrawer mode=network/> (viewer)", () => {
  it("renders a read-only notice and no Run button", () => {
    open(ecsSvc, "ecs", "viewer");
    expect(screen.getByText(/read-only/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^run$/i })).not.toBeInTheDocument();
  });
});
