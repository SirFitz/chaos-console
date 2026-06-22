// packages/web/src/components/RowMenu.tsx
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ActionName, ServiceStatus } from "@chaos/shared";
import * as api from "../api.js";
import { ApiError } from "../api.js";
import { ConfirmModal } from "./ConfirmModal.js";
import { rowKey, type RowPatch } from "../lib/useOptimisticRows.js";

const QUICK: { action: ActionName; label: string }[] = [
  { action: "restart", label: "Restart" },
  { action: "stop-all", label: "Stop all" },
  { action: "start-all", label: "Start all" },
];

const MENU_W = 176; // w-44

/**
 * The per-row "More" menu. The dropdown panel is PORTALED to document.body and
 * positioned from the trigger's rect, so it escapes the table's `overflow-hidden`
 * clipping/stacking context and is never trapped behind another row or the table
 * edge. Closes on outside-click / Escape; arrow keys move between items.
 *
 * Every path runs through the same audited action endpoint (api.act) via the
 * parent's optimistic runner (`onAction`): restart is per-service so it gets an
 * optimistic "Pending" pill + rollback; stop-all/start-all act on the whole
 * platform so they carry no per-row optimism (empty patch) but still reconcile
 * + roll back through the same path. The mutating quick paths are gated by a
 * confirm.
 */
export function RowMenu({
  service,
  onAct,
  onAction,
}: {
  service: ServiceStatus;
  onAct: (s: ServiceStatus) => void;
  /** Run a mutating action with optimistic state + rollback (from <Inventory/>). */
  onAction: (key: string, patch: RowPatch, mutate: () => Promise<unknown>) => Promise<void>;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<{ action: ActionName; label: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Position the portaled panel from the trigger rect: top below the button,
  // right edge aligned to the trigger, clamped into the viewport.
  const place = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const left = Math.max(8, Math.min(r.right - MENU_W, window.innerWidth - MENU_W - 8));
    setPos({ top: r.bottom + 4, left });
  }, []);

  useLayoutEffect(() => {
    if (open) place();
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t) || menuRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    // Reposition while open so the panel tracks the row (scroll/resize), and keep
    // it from drifting away from a moving trigger. `true` catches scroll on any
    // ancestor (the table's own scroll container included).
    const onReflow = () => place();
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", onReflow);
    window.addEventListener("scroll", onReflow, true);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onReflow);
      window.removeEventListener("scroll", onReflow, true);
    };
  }, [open, place]);

  // Focus the first item when the menu opens (keyboard entry point).
  useEffect(() => {
    if (open && pos) {
      const first = menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]');
      first?.focus();
    }
  }, [open, pos]);

  function onMenuKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Home" && e.key !== "End") return;
    e.preventDefault();
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []);
    if (items.length === 0) return;
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    let next = i;
    if (e.key === "ArrowDown") next = i < items.length - 1 ? i + 1 : 0;
    else if (e.key === "ArrowUp") next = i > 0 ? i - 1 : items.length - 1;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = items.length - 1;
    items[next]?.focus();
  }

  async function runQuick(action: ActionName) {
    setBusy(true);
    setError(null);
    try {
      // stop-all/start-all act on the platform (no single-row optimism, empty
      // patch); restart targets this service and optimistically pulses "Pending".
      const body = action === "restart" ? { service: service.name, confirm: true } : { confirm: true };
      const patch: RowPatch =
        action === "restart" ? { pending: Math.max(1, service.running ?? service.desired ?? 1) } : {};
      await onAction(rowKey(service), patch, () => api.act(service.platformId, action, body));
      setPending(null);
    } catch (e) {
      setError(e instanceof ApiError ? `${e.code}: ${e.message}` : "action failed");
      setPending(null);
    } finally {
      setBusy(false);
    }
  }

  const item =
    "flex w-full items-center px-3 py-1.5 text-left text-sm text-ink transition-colors duration-150 ease-out hover:bg-rail focus-visible:bg-rail focus:bg-rail focus:outline-none focus-visible:outline-none";

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex h-7 items-center gap-1 rounded-md border border-border-strong bg-panel px-2.5 text-xs font-medium text-ink transition-colors duration-150 ease-out hover:bg-rail active:bg-rail disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-surface"
      >
        More
        <svg
          viewBox="0 0 12 12"
          className={`h-2.5 w-2.5 text-ink-faint transition-transform duration-150 ease-out ${open ? "rotate-180" : ""}`}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          aria-hidden="true"
        >
          <path d="M3 4.5L6 7.5L9 4.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open &&
        pos &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            aria-label={`Actions for ${service.name}`}
            onKeyDown={onMenuKeyDown}
            style={{ position: "fixed", top: pos.top, left: pos.left, width: MENU_W }}
            className="z-[55] overflow-hidden rounded-md border border-border bg-panel py-1 shadow-lg animate-fade-in"
          >
            <button
              type="button"
              role="menuitem"
              className={item}
              onClick={() => {
                setOpen(false);
                onAct(service);
              }}
            >
              Open actions
            </button>
            <div className="my-1 border-t border-border" />
            {QUICK.map((q) => (
              <button
                key={q.action}
                type="button"
                role="menuitem"
                className={item}
                onClick={() => {
                  setOpen(false);
                  setPending(q);
                }}
              >
                {q.label}
              </button>
            ))}
            {error && (
              <p className="px-3 py-1.5 text-xs text-bad" role="alert">
                {error}
              </p>
            )}
          </div>,
          document.body,
        )}

      {pending && (
        <ConfirmModal
          title={`${pending.label} · ${service.name}`}
          message={`Run ${pending.label.toLowerCase()} on "${service.name}" (${service.platformId})? This is a destructive action and will be audited.`}
          busy={busy}
          confirmLabel={pending.label}
          onConfirm={() => void runQuick(pending.action)}
          onCancel={() => setPending(null)}
        />
      )}
    </>
  );
}
