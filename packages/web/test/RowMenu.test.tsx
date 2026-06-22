// packages/web/test/RowMenu.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as api from "../src/api.js";
import type { ServiceStatus } from "@chaos/shared";
import { RowMenu } from "../src/components/RowMenu.js";
import type { RowPatch } from "../src/lib/useOptimisticRows.js";

vi.mock("../src/api.js", async (importActual) => {
  const actual = await importActual<typeof import("../src/api.js")>();
  return { ...actual, act: vi.fn() };
});
const mockedApi = vi.mocked(api);
beforeEach(() => vi.resetAllMocks());

const svc: ServiceStatus = { platformId: "mi", layer: "MI", name: "payments", mapped: true, desired: 2, running: 2 };

function setup() {
  const onAct = vi.fn();
  // Stand-in for <Inventory/>'s optimistic runner: runs the mutation so we can
  // assert what api.act was called with, and propagates failures like the real one.
  const onAction = vi.fn(async (_k: string, _p: RowPatch, mutate: () => Promise<unknown>) => {
    await mutate();
  });
  // Wrap the trigger in an overflow-hidden, clipping container — the exact
  // situation that traps an absolutely-positioned menu inside the table.
  render(
    <div style={{ overflow: "hidden" }} data-testid="clip">
      <RowMenu service={svc} onAct={onAct} onAction={onAction} />
    </div>,
  );
  return { onAct, onAction };
}

describe("<RowMenu/>", () => {
  it("portals the menu to document.body (outside the clipping container)", async () => {
    setup();
    await userEvent.click(screen.getByRole("button", { name: /more/i }));
    const menu = await screen.findByRole("menu");
    const clip = screen.getByTestId("clip");
    // The menu must NOT live inside the overflow-hidden wrapper that would clip it.
    expect(clip.contains(menu)).toBe(false);
    expect(document.body.contains(menu)).toBe(true);
    // Positioned with fixed so it escapes any ancestor stacking/scroll context.
    expect((menu as HTMLElement).style.position).toBe("fixed");
  });

  it("Open actions calls onAct and closes the menu", async () => {
    const { onAct } = setup();
    await userEvent.click(screen.getByRole("button", { name: /more/i }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /open actions/i }));
    expect(onAct).toHaveBeenCalledWith(svc);
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
  });

  it("a quick action confirms, then runs through the audited act endpoint (via the optimistic runner)", async () => {
    mockedApi.act.mockResolvedValue({ outcome: { action: "restart", target: "payments", dryRun: false, result: {} }, auditId: "a1" });
    const { onAction } = setup();
    await userEvent.click(screen.getByRole("button", { name: /more/i }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /restart/i }));
    // Confirm gate first — not fired yet.
    expect(mockedApi.act).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: /^restart$/i }));
    await waitFor(() =>
      expect(mockedApi.act).toHaveBeenCalledWith("mi", "restart", expect.objectContaining({ service: "payments", confirm: true })),
    );
    // Restart goes through the optimistic runner (so it gets a Pending pill + rollback).
    expect(onAction).toHaveBeenCalledTimes(1);
  });

  it("closes on Escape", async () => {
    setup();
    await userEvent.click(screen.getByRole("button", { name: /more/i }));
    await screen.findByRole("menu");
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
  });

  it("closes on an outside click", async () => {
    setup();
    await userEvent.click(screen.getByRole("button", { name: /more/i }));
    await screen.findByRole("menu");
    await userEvent.click(document.body);
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
  });

  it("arrow keys move focus between menu items", async () => {
    setup();
    await userEvent.click(screen.getByRole("button", { name: /more/i }));
    const items = await screen.findAllByRole("menuitem");
    // First item is focused on open.
    await waitFor(() => expect(items[0]).toHaveFocus());
    await userEvent.keyboard("{ArrowDown}");
    expect(items[1]).toHaveFocus();
    await userEvent.keyboard("{ArrowUp}");
    expect(items[0]).toHaveFocus();
  });
});
