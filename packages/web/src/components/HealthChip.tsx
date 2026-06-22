// packages/web/src/components/HealthChip.tsx
//
// A quiet per-platform backend-health chip for EKS sections: "Backends ready"
// when Pumba + ingress-nginx are good, a problem tone otherwise. It polls the
// platform's /health read on its own (~15s, the useLivePoll pattern) so it never
// blocks the inventory table, and reveals the server's detail + remediation in a
// small click/hover popover (sentence first, no flashy badge — DESIGN.md).
import React, { useCallback, useEffect, useRef, useState } from "react";
import * as api from "../api.js";
import { useLivePoll } from "../lib/useLivePoll.js";
import { deriveBackendHealth, type BackendHealthChip } from "../lib/health.js";
import type { Tone } from "../lib/status.js";

const POLL_MS = 15_000;

const CHIP: Record<Tone, string> = {
  ok: "bg-ok-soft text-ok",
  warn: "bg-warn-soft text-warn",
  bad: "bg-bad-soft text-bad",
  chaos: "bg-chaos-soft text-chaos",
  neutral: "bg-rail text-ink-soft",
};
const DOT: Record<Tone, string> = {
  ok: "bg-ok",
  warn: "bg-warn",
  bad: "bg-bad",
  chaos: "bg-chaos",
  neutral: "bg-ink-faint",
};

/**
 * Renders the chip for one EKS platform. Returns null (renders nothing) for a
 * non-applicable platform, while loading, or when a probe fails — health is a
 * quiet signal, not a source of error banners.
 */
export function HealthChip({ platformId }: { platformId: string }): React.ReactElement | null {
  const fetcher = useCallback(() => api.health(platformId), [platformId]);
  const poll = useLivePoll(fetcher, POLL_MS);

  const chip = poll.data ? deriveBackendHealth(poll.data) : null;
  if (!chip) return null;
  return <HealthChipView chip={chip} />;
}

/** Presentational chip + dismissible detail popover. Exported for unit tests. */
export function HealthChipView({ chip }: { chip: BackendHealthChip }): React.ReactElement {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Dismiss the popover on an outside click or Escape (a lightweight popover,
  // not a modal — it must never trap focus or dim the page).
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // The full sentence(s) are the chip's title too, so a plain hover surfaces them
  // even without a click (the popover adds a focusable, copyable rendering).
  const hoverText = chip.remediation ? `${chip.detail} ${chip.remediation}` : chip.detail;

  return (
    <div ref={ref} className="relative inline-flex">
      <button
        type="button"
        aria-expanded={open}
        aria-label={`Backend health: ${chip.label}`}
        title={hoverText}
        onClick={() => setOpen((v) => !v)}
        className={`inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-xs font-medium transition-[background-color,color] duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-surface ${CHIP[chip.tone]}`}
      >
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${DOT[chip.tone]}`} aria-hidden="true" />
        {chip.label}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label={`Backend health detail: ${chip.label}`}
          className="absolute right-0 top-full z-30 mt-1.5 w-72 rounded-md border border-border bg-panel p-3 text-left shadow-lg animate-fade-in"
        >
          <p className="text-sm leading-relaxed text-ink">{chip.detail}</p>
          {chip.remediation && (
            <p className="mt-2 border-t border-border pt-2 text-xs leading-relaxed text-ink-soft">
              <span className="font-semibold text-ink">Fix</span> {chip.remediation}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
