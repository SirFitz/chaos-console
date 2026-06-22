// packages/web/test/ChaosDrawer.actions.test.tsx
// The full-action surface (mode="actions"), opened from a row's More -> Open actions.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as api from "../src/api.js";
import type { ServiceStatus } from "@chaos/shared";
import { ChaosDrawer } from "../src/components/ChaosDrawer.js";

// Mock the network functions but keep the REAL ApiError class (importActual
// pattern) so `instanceof ApiError` + .code/.message stay truthful.
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
  render(<ChaosDrawer service={svc} kind={kind} role={role} mode="actions" onClose={vi.fn()} onDone={vi.fn()} />);
}

describe("<ChaosDrawer mode=actions/> destructive flow", () => {
  it("a destructive action opens the confirm dialog and only fires after confirm", async () => {
    mockedApi.act.mockResolvedValue({ outcome: { action: "stop", target: "payments", dryRun: false, result: { ok: 1 } }, auditId: "a1" });
    open(ecsSvc, "ecs");
    await userEvent.selectOptions(screen.getByLabelText(/action/i), "stop");
    await userEvent.click(screen.getByRole("button", { name: /^run$/i }));
    expect(mockedApi.act).not.toHaveBeenCalled();
    expect(screen.getByText(/destructive action/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /^run stop$/i }));
    await waitFor(() => expect(mockedApi.act).toHaveBeenCalledWith("mi", "stop", expect.objectContaining({ service: "payments", confirm: true })));
  });

  it("dry-run skips the confirm dialog and sends dryRun:true without confirm", async () => {
    mockedApi.act.mockResolvedValue({
      outcome: { action: "stop", target: "payments", dryRun: true, plan: { awsCall: "ecs:UpdateService", params: { desiredCount: 0 } } },
      auditId: "a2",
    });
    open(ecsSvc, "ecs");
    await userEvent.selectOptions(screen.getByLabelText(/action/i), "stop");
    await userEvent.click(screen.getByLabelText(/dry.?run/i));
    await userEvent.click(screen.getByRole("button", { name: /^run$/i }));
    await waitFor(() => expect(mockedApi.act).toHaveBeenCalledWith("mi", "stop", expect.objectContaining({ dryRun: true })));
    expect(mockedApi.act.mock.calls[0][2]).not.toHaveProperty("confirm", true);
    // the formatted plan is rendered (awsCall + auditId)
    expect(await screen.findByText(/ecs:UpdateService/)).toBeInTheDocument();
    expect(screen.getByText(/a2/)).toBeInTheDocument();
  });

  it("renders the execute result + auditId", async () => {
    mockedApi.act.mockResolvedValue({ outcome: { action: "start", target: "payments", dryRun: false, result: { desiredCount: 1 } }, auditId: "a3" });
    open(ecsSvc, "ecs");
    await userEvent.selectOptions(screen.getByLabelText(/action/i), "start");
    await userEvent.click(screen.getByRole("button", { name: /^run$/i }));
    expect(await screen.findByText("desiredCount")).toBeInTheDocument();
    expect(screen.getByText(/a3/)).toBeInTheDocument();
  });

  it("ecs offers a blackhole CIDR field and posts it", async () => {
    mockedApi.act.mockResolvedValue({ outcome: { action: "net-block", target: "203.0.113.10/32", dryRun: true, plan: { awsCall: "ec2:CreateNetworkAclEntry", params: {} } }, auditId: "a4" });
    open(ecsSvc, "ecs");
    await userEvent.selectOptions(screen.getByLabelText(/action/i), "net-block");
    await userEvent.type(screen.getByLabelText(/cidr/i), "203.0.113.10/32");
    await userEvent.click(screen.getByLabelText(/dry.?run/i));
    await userEvent.click(screen.getByRole("button", { name: /^run$/i }));
    await waitFor(() => expect(mockedApi.act).toHaveBeenCalledWith("mi", "net-block", expect.objectContaining({ cidr: "203.0.113.10/32", dryRun: true })));
  });

  it("eks offers packet loss with a loss field", async () => {
    mockedApi.act.mockResolvedValue({ outcome: { action: "net-loss", target: "gateway", dryRun: true, plan: { awsCall: "ssm:SendCommand", params: {} } }, auditId: "a5" });
    open(eksSvc, "eks_ssm");
    await userEvent.selectOptions(screen.getByLabelText(/action/i), "net-loss");
    await userEvent.clear(screen.getByLabelText(/loss %/i));
    await userEvent.type(screen.getByLabelText(/loss %/i), "40");
    await userEvent.click(screen.getByLabelText(/dry.?run/i));
    await userEvent.click(screen.getByRole("button", { name: /^run$/i }));
    await waitFor(() => expect(mockedApi.act).toHaveBeenCalledWith("api", "net-loss", expect.objectContaining({ loss: 40, dryRun: true })));
  });

  it("surfaces CONFIRM_REQUIRED from the server as an error", async () => {
    mockedApi.act.mockRejectedValue(new api.ApiError("CONFIRM_REQUIRED", "action 'stop' requires confirm:true", 400));
    open(ecsSvc, "ecs");
    await userEvent.selectOptions(screen.getByLabelText(/action/i), "stop");
    await userEvent.click(screen.getByRole("button", { name: /^run$/i }));
    await userEvent.click(screen.getByRole("button", { name: /^run stop$/i }));
    // Scope to the error alert (a "requires confirm" hint also sits by the dry-run toggle).
    expect(await screen.findByRole("alert")).toHaveTextContent(/requires confirm/i);
  });
});

describe("<ChaosDrawer mode=actions/> viewer", () => {
  it("renders a read-only notice and no Run button", () => {
    open(ecsSvc, "ecs", "viewer");
    expect(screen.getByText(/read-only/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^run$/i })).not.toBeInTheDocument();
  });
});
