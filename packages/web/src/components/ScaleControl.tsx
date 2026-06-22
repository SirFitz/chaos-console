// packages/web/src/components/ScaleControl.tsx
import React, { useEffect, useRef, useState } from "react";
import type { ServiceStatus, Role } from "@chaos/shared";
import * as api from "../api.js";
import { ApiError } from "../api.js";
import { isOperator } from "../auth.js";
import { ConfirmModal } from "./ConfirmModal.js";
import { ReplicaMeter } from "./ReplicaMeter.js";
import { Spinner } from "./ui.js";
import { countsUnknown } from "../lib/status.js";
import { rowKey, type RowPatch } from "../lib/useOptimisticRows.js";

/**
 * Inline scale stepper for one inventory row.
 *  - shows running/desired via <ReplicaMeter/> (the row's single count),
 *  - −/＋ and the numeric input only edit a LOCAL pending target — they fire no
 *    request per click; the operator dials in the number freely,
 *  - the single **Scale** button submits that target (optimistically): N ≥ 1 →
 *    start{count:N} (not destructive), N === 0 → stop{confirm} (destructive).
 *
 * The optimistic update + rollback is owned by the parent (<Inventory/>) through
 * `onAction`: we apply the target to the row immediately, send the request, and
 * roll back to the prior count if it fails. `from` is sent so the audit reads
 * "scaled svc 2 -> 3" rather than a bare start/stop.
 *
 * Never scales below 0: the − button is disabled at target 0 and typed values
 * are clamped to ≥ 0. Viewers see the meter only.
 */
export function ScaleControl({
  service,
  role,
  onAction,
}: {
  service: ServiceStatus;
  role: Role;
  /** Run a mutating action with optimistic state + rollback (from <Inventory/>). */
  onAction: (key: string, patch: RowPatch, mutate: () => Promise<unknown>) => Promise<void>;
}): React.ReactElement {
  const desired = service.desired ?? service.running ?? 0;
  const [target, setTarget] = useState(String(desired));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingStop, setPendingStop] = useState(false);

  // Keep the stepper in sync with the live `desired` from polling, but don't
  // stomp a value the operator is actively dialing in. After an optimistic
  // scale, `desired` already reflects the target, so this keeps them aligned.
  const editing = useRef(false);
  useEffect(() => {
    if (!editing.current) setTarget(String(desired));
  }, [desired]);

  const meter = <ReplicaMeter s={service} />;

  // Viewers (and rows with no countable replicas) get just the meter.
  if (!isOperator(role)) return meter;

  const targetNum = Math.max(0, Math.trunc(target.trim() === "" ? 0 : Number(target)));

  // The actual submit: optimistically reflect the target, send the request,
  // roll back (via onAction) if it fails. `n` is already clamped to >= 0.
  async function submit(n: number) {
    setBusy(true);
    setError(null);
    const key = rowKey(service);
    try {
      if (n <= 0) {
        // Stop: drain to zero. Keep `running` so the meter reads as draining and
        // the pill pulses "Pending" until the next poll confirms.
        const patch: RowPatch = { desired: 0, pending: Math.max(1, service.running ?? 1) };
        await onAction(key, patch, () =>
          api.act(service.platformId, "stop", { service: service.name, confirm: true, from: desired }),
        );
      } else {
        // Scale: pre-empt desired so the pill reads "Scaling" at once.
        await onAction(key, { desired: n }, () =>
          api.act(service.platformId, "start", { service: service.name, count: n, from: desired }),
        );
      }
      setPendingStop(false);
    } catch (e) {
      setError(e instanceof ApiError ? `${e.code}: ${e.message}` : "scale failed");
      setPendingStop(false);
    } finally {
      setBusy(false);
    }
  }

  // The single submit entry point. 0 is destructive (stop) -> gate behind confirm.
  function onScale() {
    editing.current = false;
    setTarget(String(targetNum));
    if (targetNum === 0) setPendingStop(true);
    else void submit(targetNum);
  }

  // Local-only stepper edits — no request fires here (DESIGN.md #2). Clamp >= 0.
  function step(delta: number) {
    editing.current = true;
    setError(null);
    setTarget((t) => {
      const base = Math.max(0, Math.trunc(t.trim() === "" ? 0 : Number(t)));
      return String(Math.max(0, base + delta));
    });
  }

  const stepBtn =
    "grid h-7 w-7 shrink-0 place-items-center rounded-md border border-border-strong bg-panel text-ink-soft transition-colors duration-150 ease-out hover:bg-rail hover:text-ink active:bg-rail disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-panel focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-surface";

  // If counts are unknown we cannot meaningfully step; show the meter (em dash) alone.
  const stepDisabled = countsUnknown(service);
  // Never let "−" go below 0 — disabled when the local target is already 0.
  const atZero = targetNum <= 0;
  // The pending target differs from the live desired -> there's something to submit.
  const dirty = targetNum !== desired;

  return (
    <span className="inline-flex items-center gap-2.5">
      {meter}
      <span className="inline-flex items-center gap-1">
        <button
          type="button"
          aria-label="Scale down"
          title={atZero ? "Already at 0" : "Decrease target"}
          disabled={busy || stepDisabled || atZero}
          onClick={() => step(-1)}
          className={stepBtn}
        >
          <span aria-hidden="true">−</span>
        </button>
        <button
          type="button"
          aria-label="Scale up"
          title="Increase target"
          disabled={busy || stepDisabled}
          onClick={() => step(1)}
          className={stepBtn}
        >
          <span aria-hidden="true">+</span>
        </button>
        <input
          aria-label="Set desired count"
          inputMode="numeric"
          min={0}
          value={target}
          disabled={busy || stepDisabled}
          onFocus={() => (editing.current = true)}
          onBlur={() => (editing.current = false)}
          onChange={(e) => {
            // Keep only digits — no negative sign, no decimals.
            editing.current = true;
            setTarget(e.target.value.replace(/[^\d]/g, ""));
          }}
          className="tnum h-7 w-12 rounded-md border border-border-strong bg-panel px-1 text-center text-sm text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-surface disabled:cursor-not-allowed disabled:opacity-60"
        />
        <button
          type="button"
          title={dirty ? `Scale to ${targetNum}` : "Set a new target, then Scale"}
          disabled={busy || stepDisabled}
          onClick={onScale}
          className="relative inline-flex h-7 min-w-[4.25rem] items-center justify-center gap-1.5 rounded-md border border-border-strong bg-panel px-2.5 text-xs font-medium text-ink transition-colors duration-150 ease-out hover:bg-rail active:bg-rail disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-panel focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-surface"
        >
          {/* Spinner overlaid so the button keeps its resting width (no layout shift). */}
          {busy && (
            <span className="absolute inset-0 grid place-items-center" aria-hidden="true">
              <Spinner className="h-3 w-3" />
            </span>
          )}
          <span className={busy ? "opacity-0" : ""}>Scale</span>
        </button>
      </span>
      {error && (
        <span className="text-xs text-bad" role="alert">
          {error}
        </span>
      )}
      {pendingStop && (
        <ConfirmModal
          title={`Scale "${service.name}" to 0`}
          message={`Scale "${service.name}" to 0 (stop) on ${service.platformId}? This is a destructive action and will be audited.`}
          busy={busy}
          confirmLabel="Stop service"
          onConfirm={() => void submit(0)}
          onCancel={() => setPendingStop(false)}
        />
      )}
    </span>
  );
}
