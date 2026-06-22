// packages/web/src/lib/auditText.ts
//
// Turn an audit record's action into a human sentence for the Audit view. The
// important case: a *scale* is recorded as start/stop, which on its own reads as
// a bare "start"/"stop". When the record carries a per-service target count
// (params.count / params.from), we render it as the operator actually meant it:
//   "scaled bps-payments-svc 2 -> 3"
//   "scaled bps-payments-svc -> 0 (stop)"
// Plain start-all / stop-all (no per-service count) stay as their raw action.
import type { AuditRecord } from "@chaos/shared";

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/**
 * The action text shown in the Audit table. Scaling start/stop (records that
 * carry a target service + a count/from) read as "scaled <svc> [from ->] N";
 * everything else is its plain action name.
 */
export function describeAuditAction(r: Pick<AuditRecord, "action" | "target" | "params">): string {
  const svc = r.target;
  const params = r.params ?? {};
  const from = num(params.from);
  const count = num(params.count);

  // A per-service scale-up / set-count: start{count}. (start-all has no service
  // target and no count, so it never matches.)
  if (r.action === "start" && svc && count !== undefined) {
    return from !== undefined
      ? `scaled ${svc} ${from} → ${count}`
      : `scaled ${svc} → ${count}`;
  }

  // A per-service scale-to-zero: stop. We know it's a scale (not stop-all) when
  // it targets a service AND carries the prior count (`from`).
  if (r.action === "stop" && svc && from !== undefined) {
    return `scaled ${svc} ${from} → 0 (stop)`;
  }

  return r.action;
}
