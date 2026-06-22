// packages/web/test/ScaleControl.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as api from "../src/api.js";
import type { ServiceStatus } from "@chaos/shared";
import { ScaleControl } from "../src/components/ScaleControl.js";
import type { RowPatch } from "../src/lib/useOptimisticRows.js";

// Mock the network functions but keep the REAL ApiError class (the established
// importActual pattern from the api/auth/ActionDrawer tests).
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

const svc = (o: Partial<ServiceStatus> = {}): ServiceStatus => ({
  platformId: "mi", layer: "MI", name: "payments", mapped: true, desired: 2, running: 2, ...o,
});

// Stand-in for <Inventory/>'s optimistic runner: it runs the mutation (so we can
// assert what api.act was called with) and propagates failure like the real one.
function passthrough() {
  return vi.fn(async (_k: string, _p: RowPatch, mutate: () => Promise<unknown>) => {
    await mutate();
  });
}

function open(s: ServiceStatus, role: "operator" | "viewer" = "operator", onAction = passthrough()) {
  render(<ScaleControl service={s} role={role} onAction={onAction} />);
  return onAction;
}

describe("<ScaleControl/> (operator)", () => {
  it("renders the running/desired counts", () => {
    open(svc({ running: 1, desired: 2 }));
    expect(screen.getByText("1 / 2")).toBeInTheDocument();
  });

  it("the + / − steppers only edit the local target — they fire NO request per click", async () => {
    const onAction = open(svc({ running: 2, desired: 2 }));
    const input = screen.getByLabelText(/set desired count/i) as HTMLInputElement;
    expect(input.value).toBe("2");
    await userEvent.click(screen.getByRole("button", { name: /scale up/i }));
    await userEvent.click(screen.getByRole("button", { name: /scale up/i }));
    expect(input.value).toBe("4");
    await userEvent.click(screen.getByRole("button", { name: /scale down/i }));
    expect(input.value).toBe("3");
    // Crucially: no action ran while stepping.
    expect(onAction).not.toHaveBeenCalled();
    expect(mockedApi.act).not.toHaveBeenCalled();
  });

  it("Scale submits the chosen target exactly once via start{count}", async () => {
    mockedApi.act.mockResolvedValue({ outcome: { action: "start", target: "payments", dryRun: false, result: { desiredCount: 4 } }, auditId: "a1" });
    const onAction = open(svc({ running: 2, desired: 2 }));
    await userEvent.click(screen.getByRole("button", { name: /scale up/i }));
    await userEvent.click(screen.getByRole("button", { name: /scale up/i }));
    await userEvent.click(screen.getByRole("button", { name: /^scale$/i }));
    await waitFor(() =>
      expect(mockedApi.act).toHaveBeenCalledWith("mi", "start", expect.objectContaining({ service: "payments", count: 4 })),
    );
    // Exactly one submit, not one-per-click.
    expect(mockedApi.act).toHaveBeenCalledTimes(1);
    expect(onAction).toHaveBeenCalledTimes(1);
  });

  it("Scale sends the prior count as `from` so the audit can read 2 -> N", async () => {
    mockedApi.act.mockResolvedValue({ outcome: { action: "start", target: "payments", dryRun: false, result: { desiredCount: 3 } }, auditId: "a2" });
    open(svc({ running: 2, desired: 2 }));
    await userEvent.click(screen.getByRole("button", { name: /scale up/i }));
    await userEvent.click(screen.getByRole("button", { name: /^scale$/i }));
    await waitFor(() =>
      expect(mockedApi.act).toHaveBeenCalledWith("mi", "start", expect.objectContaining({ count: 3, from: 2 })),
    );
  });

  it("typing a target then Scale calls start with that count (single request)", async () => {
    mockedApi.act.mockResolvedValue({ outcome: { action: "start", target: "payments", dryRun: false, result: { desiredCount: 5 } }, auditId: "a3" });
    open(svc({ running: 2, desired: 2 }));
    const input = screen.getByLabelText(/set desired count/i);
    await userEvent.clear(input);
    await userEvent.type(input, "5");
    await userEvent.click(screen.getByRole("button", { name: /^scale$/i }));
    await waitFor(() =>
      expect(mockedApi.act).toHaveBeenCalledWith("mi", "start", expect.objectContaining({ service: "payments", count: 5 })),
    );
    expect(mockedApi.act).toHaveBeenCalledTimes(1);
  });

  it("target 0 routes through stop + confirm (not fired until confirmed)", async () => {
    mockedApi.act.mockResolvedValue({ outcome: { action: "stop", target: "payments", dryRun: false, result: { desiredCount: 0 } }, auditId: "a4" });
    open(svc({ running: 1, desired: 1 }));
    // step down to 0, then Scale
    await userEvent.click(screen.getByRole("button", { name: /scale down/i }));
    expect((screen.getByLabelText(/set desired count/i) as HTMLInputElement).value).toBe("0");
    await userEvent.click(screen.getByRole("button", { name: /^scale$/i }));
    // confirm gate — nothing fired yet
    expect(mockedApi.act).not.toHaveBeenCalled();
    expect(screen.getByText(/destructive action/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /stop service/i }));
    await waitFor(() =>
      expect(mockedApi.act).toHaveBeenCalledWith("mi", "stop", expect.objectContaining({ service: "payments", confirm: true, from: 1 })),
    );
  });

  it("surfaces an ApiError and stays mounted when the action rejects", async () => {
    mockedApi.act.mockRejectedValue(new api.ApiError("BOOM", "scale failed hard", 500));
    open(svc({ running: 2, desired: 2 }));
    await userEvent.click(screen.getByRole("button", { name: /scale up/i }));
    await userEvent.click(screen.getByRole("button", { name: /^scale$/i }));
    expect(await screen.findByText(/scale failed hard/i)).toBeInTheDocument();
    // The control is still interactive (stepper present) after the failure.
    expect(screen.getByRole("button", { name: /scale up/i })).toBeInTheDocument();
  });

  it("disables the − button at target 0 so you cannot dial below zero", async () => {
    const onAction = open(svc({ running: 0, desired: 0 }));
    const down = screen.getByRole("button", { name: /scale down/i });
    expect(down).toBeDisabled();
    await userEvent.click(down);
    expect(onAction).not.toHaveBeenCalled();
    expect(screen.queryByText(/destructive action/i)).not.toBeInTheDocument();
  });

  it("strips a typed negative sign so the target is never negative", async () => {
    open(svc({ running: 2, desired: 2 }));
    const input = screen.getByLabelText(/set desired count/i) as HTMLInputElement;
    await userEvent.clear(input);
    await userEvent.type(input, "-3");
    expect(input.value).toBe("3");
  });
});

describe("<ScaleControl/> (viewer)", () => {
  it("shows the counts but no scale buttons or input", () => {
    open(svc({ running: 2, desired: 2 }), "viewer");
    expect(screen.getByText("2 / 2")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^scale$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /scale up/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /scale down/i })).not.toBeInTheDocument();
  });
});
