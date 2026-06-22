// packages/web/src/lib/status.ts
//
// Pure derivation of a service's display status from the ServiceStatus DTO.
// One source of truth shared by <StatusPill/>, <ReplicaMeter/>, row highlight,
// and the tests that enforce the "never a naked 0/2" rules from DESIGN.md.
import type { ServiceStatus } from "@chaos/shared";

/** Visual tone -> which semantic token family the chip/meter uses. */
export type Tone = "ok" | "warn" | "bad" | "chaos" | "neutral";

/** The pill word an operator reads at a glance. */
export type StatusWord =
  | "Running"
  | "Scaling"
  | "Pending"
  | "Stopped"
  | "Degraded"
  | "Throttled"
  | "Blocked"
  | "Unknown";

export interface DerivedStatus {
  word: StatusWord;
  tone: Tone;
  /** Pending/Scaling pulse their dot to signal "in transition". */
  pulse: boolean;
}

const has = (n: number | undefined): n is number => typeof n === "number";

/** A raw provider state string that explicitly reads as stopped. */
function stateIsStopped(state: string | undefined): boolean {
  return typeof state === "string" && /stop|drain|inactive/i.test(state);
}

/**
 * True when running/desired counts are genuinely unknown for this row
 * (some platforms / unmapped rows report neither). The meter shows "—" here,
 * never "0/0" or "1/0".
 */
export function countsUnknown(s: Pick<ServiceStatus, "desired" | "running">): boolean {
  return !has(s.desired) && !has(s.running);
}

/**
 * Derive the StatusPill word + tone. Precedence is operational:
 *   stopped  > pending/scaling > degraded > healthy > unknown.
 * `state` (the raw provider string) only forces "Stopped"; everything else is
 * driven by the running/desired/pending counts so the pill never disagrees with
 * the meter.
 */
export function deriveStatus(s: ServiceStatus): DerivedStatus {
  const desired = has(s.desired) ? s.desired : undefined;
  const running = has(s.running) ? s.running : undefined;
  const pending = has(s.pending) ? s.pending : 0;

  // Explicitly stopped: provider says so, or it should be up but nothing is.
  const shouldBeUp = has(desired) && desired > 0;
  if (stateIsStopped(s.state) || (shouldBeUp && running === 0)) {
    return { word: "Stopped", tone: "bad", pulse: false };
  }

  // In transition: tasks pending, or running has not yet settled to desired
  // (either still ramping up, running < desired, or draining down, running >
  // desired — e.g. a scale-down in progress, including an optimistic one).
  if (pending > 0) {
    return { word: "Pending", tone: "warn", pulse: true };
  }
  if (has(desired) && has(running) && desired > 0 && running !== desired) {
    return { word: "Scaling", tone: "warn", pulse: true };
  }

  // Healthy: running has met desired (and desired > 0).
  if (has(desired) && has(running) && running === desired && desired > 0) {
    return { word: "Running", tone: "ok", pulse: false };
  }

  // Mapped & up but we only know it's running (no desired): treat as Running.
  if (has(running) && running > 0 && !has(desired)) {
    return { word: "Running", tone: "ok", pulse: false };
  }

  return { word: "Unknown", tone: "neutral", pulse: false };
}

/** Meter color from the running/desired relationship (DESIGN.md). */
export type MeterTone = "ok" | "warn" | "bad" | "neutral";

export interface DerivedMeter {
  /** null when counts are unknown -> render "—". */
  running: number | null;
  desired: number | null;
  filled: number;
  segments: number;
  tone: MeterTone;
  label: string;
}

const MAX_SEGMENTS = 8;

/**
 * Derive the ReplicaMeter geometry + tone.
 *   ok   when running === desired (and desired > 0)
 *   warn when 0 < running < desired
 *   bad  when running === 0 && desired > 0
 * Unknown counts -> { running: null, desired: null, label: "—" }.
 */
export function deriveMeter(s: Pick<ServiceStatus, "desired" | "running">): DerivedMeter {
  if (countsUnknown(s)) {
    return { running: null, desired: null, filled: 0, segments: 0, tone: "neutral", label: "—" };
  }

  // One count known but not the other: fall back so we never print "1/0" or "0/0".
  const desired = has(s.desired) ? s.desired : (s.running as number);
  const running = has(s.running) ? s.running : (s.desired as number);

  let tone: MeterTone;
  if (desired <= 0) tone = "neutral";
  else if (running === 0) tone = "bad";
  else if (running < desired) tone = "warn";
  else tone = "ok";

  const segments = Math.max(1, Math.min(desired, MAX_SEGMENTS));
  const filled = desired <= 0 ? 0 : Math.round((Math.min(running, desired) / desired) * segments);

  return {
    running,
    desired,
    filled: Math.max(0, Math.min(filled, segments)),
    segments,
    tone,
    label: `${running} / ${desired}`,
  };
}

/**
 * A stable signature of a row's *live* state, used to detect changes between
 * polls so changed rows can flash. Excludes static fields (name/group/flow).
 */
export function statusSignature(s: ServiceStatus): string {
  return [s.running ?? "·", s.desired ?? "·", s.pending ?? "·", s.state ?? "·"].join("|");
}
