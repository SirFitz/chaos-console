// packages/web/src/components/ReplicaMeter.tsx
import React from "react";
import type { ServiceStatus } from "@chaos/shared";
import { deriveMeter, type MeterTone } from "../lib/status.js";

const FILL: Record<MeterTone, string> = {
  ok: "bg-ok",
  warn: "bg-warn",
  bad: "bg-bad",
  neutral: "bg-ink-faint",
};
const TEXT: Record<MeterTone, string> = {
  ok: "text-ink",
  warn: "text-warn",
  bad: "text-bad",
  neutral: "text-ink-faint",
};

/**
 * running of desired as a tiny segmented bar (filled = running, track = desired)
 * + "2 / 2" in tabular nums. Unknown counts render "—", never "0/0" or "1/0".
 */
export function ReplicaMeter({ s }: { s: Pick<ServiceStatus, "desired" | "running"> }): React.ReactElement {
  const m = deriveMeter(s);

  if (m.running === null) {
    // Match the laid-out width of the known state so a row toggling to/from
    // "—" never shifts neighboring controls.
    return (
      <span className="inline-flex w-[5.5rem] items-center justify-end" aria-label="replica count unknown">
        <span className="tnum text-sm text-ink-faint">&mdash;</span>
      </span>
    );
  }

  return (
    <span
      className="inline-flex w-[5.5rem] items-center justify-end gap-2"
      aria-label={`${m.running} running of ${m.desired} desired`}
    >
      {/* Reserve the full segment track (cap = 8) so a changing desired count
          doesn't grow/shrink the bar and shift the label. */}
      <span className="flex w-[2.375rem] shrink-0 items-center justify-end gap-[2px]" aria-hidden="true">
        {Array.from({ length: m.segments }, (_, i) => (
          <span
            key={i}
            className={`h-3 w-[3px] rounded-[1px] ${i < m.filled ? FILL[m.tone] : "bg-border-strong"}`}
          />
        ))}
      </span>
      <span className={`tnum shrink-0 text-right text-sm font-medium tabular-nums ${TEXT[m.tone]}`}>
        {m.label}
      </span>
    </span>
  );
}
