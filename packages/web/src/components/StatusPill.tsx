// packages/web/src/components/StatusPill.tsx
import React from "react";
import type { ServiceStatus } from "@chaos/shared";
import { deriveStatus, type DerivedStatus, type Tone } from "../lib/status.js";

// Soft-tinted chip + saturated dot + word. Inactive/unknown gets neutral stone,
// never a faded saturated color (DESIGN.md).
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

export function StatusPill({
  status,
  title,
}: {
  status: DerivedStatus;
  title?: string;
}): React.ReactElement {
  // Stable min-width + consistent padding so the cell doesn't resize as the word
  // changes ("Running" -> "Scaling" -> "Degraded"). Word is left-aligned within.
  return (
    <span
      className={`inline-flex min-w-[5.5rem] items-center gap-1.5 rounded-md px-2 py-0.5 text-xs font-medium ${CHIP[status.tone]}`}
      title={title}
    >
      <span
        className={`h-1.5 w-1.5 shrink-0 rounded-full ${DOT[status.tone]} ${status.pulse ? "animate-pulse-dot" : ""}`}
        aria-hidden="true"
      />
      {status.word}
    </span>
  );
}

/** Convenience: derive + render straight from a service row. */
export function ServiceStatusPill({ s }: { s: ServiceStatus }): React.ReactElement {
  const status = deriveStatus(s);
  // Keep the raw provider state available on hover without cluttering the row.
  return <StatusPill status={status} title={s.state ? `provider: ${s.state}` : undefined} />;
}
