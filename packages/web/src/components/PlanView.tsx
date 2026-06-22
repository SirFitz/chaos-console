// packages/web/src/components/PlanView.tsx
import React from "react";
import type { ActionOutcome } from "@chaos/shared";

/** A {host,path} pair from an L7 path-fault dry-run preview. */
function asHostPath(v: unknown): { host?: string; path?: string } | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.path !== "string" && typeof o.host !== "string") return null;
  return {
    host: typeof o.host === "string" ? o.host : undefined,
    path: typeof o.path === "string" ? o.path : undefined,
  };
}

/** Render one {host,path} as "host/path", "any host · /path", or just the path. */
function hostPathLabel(hp: { host?: string; path?: string }): string {
  const path = hp.path ?? "/";
  if (!hp.host) return path;
  return `${hp.host}${path}`;
}

/** Render a scalar value compactly; objects/arrays fall back to compact JSON. */
function renderValue(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}

/**
 * Render one value cell. Arrays get one item per line (so a path-fault preview's
 * `paths`/`objects` read as a legible list, not a JSON blob); {host,path} pairs
 * within are rendered as "host/path" so the operator sees exactly what is hit.
 */
function ValueCell({ value }: { value: unknown }): React.ReactElement {
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="text-ink-faint">none</span>;
    return (
      <ul className="space-y-0.5">
        {value.map((item, i) => {
          const hp = asHostPath(item);
          return (
            <li key={i} className="break-words">
              {hp ? hostPathLabel(hp) : renderValue(item)}
            </li>
          );
        })}
      </ul>
    );
  }
  return <>{renderValue(value)}</>;
}

function KeyValues({ obj }: { obj: Record<string, unknown> }): React.ReactElement {
  const entries = Object.entries(obj);
  if (entries.length === 0) {
    return <p className="text-xs text-ink-faint">No parameters.</p>;
  }
  return (
    <dl className="grid grid-cols-[minmax(6rem,auto)_1fr] gap-x-4 gap-y-1.5 text-sm">
      {entries.map(([k, v]) => (
        <React.Fragment key={k}>
          <dt className="truncate font-mono text-xs text-ink-soft">{k}</dt>
          <dd className="tnum min-w-0 break-words font-mono text-xs text-ink">
            <ValueCell value={v} />
          </dd>
        </React.Fragment>
      ))}
    </dl>
  );
}

/**
 * Formats an action outcome as pretty key/value blocks (NOT a raw JSON dump),
 * with the auditId. Dry-run shows the planned AWS call + params; a live run
 * shows the result map.
 */
export function PlanView({
  outcome,
  auditId,
}: {
  outcome: ActionOutcome;
  auditId: string | null;
}): React.ReactElement {
  const isDry = outcome.dryRun;
  return (
    <div className="rounded-md border border-border bg-rail/60 p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wide text-ink-soft">
          {isDry ? "Dry-run plan" : "Result"}
        </span>
        {outcome.target && (
          <span className="tnum truncate font-mono text-xs text-ink-faint" title={outcome.target}>
            {outcome.target}
          </span>
        )}
      </div>

      {isDry && outcome.plan ? (
        <div className="space-y-2">
          <div className="text-xs text-ink-soft">
            AWS call <span className="font-mono text-ink">{outcome.plan.awsCall}</span>
          </div>
          <KeyValues obj={outcome.plan.params} />
        </div>
      ) : (
        <KeyValues obj={outcome.result ?? {}} />
      )}

      <div className="mt-3 border-t border-border pt-2 text-xs text-ink-faint">
        auditId <span className="tnum font-mono text-ink-soft">{auditId ?? "—"}</span>
      </div>
    </div>
  );
}
