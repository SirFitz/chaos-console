// packages/web/src/lib/stream.ts
//
// Pure helpers behind the near-live streaming network probe (engine: the
// net-probe-start / -tail / -stop trio in eks.ts). The continuous ping pod emits
// one JSON sample per second; the page tails its logs every ~2.5s and feeds the
// returned 1s samples through these transforms into the chart's ChartSample[].
// Kept presentational-pure (no React, no fetch) so the math is unit-testable and
// the hook stays thin — same split as verify.ts backs the Active-chaos readout.
import type { ChartSample } from "../components/NetworkChart.js";

/** One raw 1s sample as returned by net-probe-tail (mirrors the engine result). */
export interface RawSample {
  /** Epoch SECONDS the in-pod ping ran (the dedupe + ordering key). */
  t: number;
  /** True when the echo replied; false on a (dropped/timed-out) ping. */
  ok: boolean;
  /** Round-trip ms on reply, else null. */
  rtt: number | null;
}

/** Coerce one arbitrary tail sample into a RawSample (defensive over the wire). */
function toRawSample(v: unknown): RawSample | null {
  if (typeof v !== "object" || v === null) return null;
  const r = v as Record<string, unknown>;
  if (typeof r.t !== "number") return null;
  const ok = r.ok === true || r.ok === 1;
  return { t: r.t, ok, rtt: ok && typeof r.rtt === "number" ? r.rtt : null };
}

/** Pull the resolved target pod IP out of a net-probe-start outcome.result. */
export function parseProbeStart(result: unknown): { target: string | null } {
  if (typeof result !== "object" || result === null) return { target: null };
  const r = result as Record<string, unknown>;
  return { target: typeof r.target === "string" ? r.target : null };
}

/**
 * Pull `{ samples, podMissing }` out of a net-probe-tail outcome.result. Tolerates
 * a missing/empty/garbage result (returns no samples) so a tail that raced the pod
 * coming up never throws — the caller just keeps polling.
 */
export function parseProbeTail(result: unknown): { samples: RawSample[]; podMissing: boolean } {
  if (typeof result !== "object" || result === null) return { samples: [], podMissing: false };
  const r = result as Record<string, unknown>;
  const raw = Array.isArray(r.samples) ? r.samples : [];
  const samples = raw.map(toRawSample).filter((s): s is RawSample => s !== null);
  return { samples, podMissing: r.podMissing === true };
}

/**
 * Merge freshly-tailed samples into the rolling raw buffer: dedupe by `t` (each
 * tail asks for an overlapping ~6s window, so most ticks re-deliver seconds we
 * already have), keep ascending order by `t`, and cap to the last `max` seconds.
 */
export function appendRawSamples(prev: RawSample[], incoming: RawSample[], max: number): RawSample[] {
  if (incoming.length === 0) return prev;
  const byT = new Map<number, RawSample>();
  for (const s of prev) byT.set(s.t, s);
  for (const s of incoming) byT.set(s.t, s); // newer wins on collision
  const merged = [...byT.values()].sort((a, b) => a.t - b.t);
  return merged.length > max ? merged.slice(merged.length - max) : merged;
}

/**
 * Derive the chart's ChartSample[] from the raw 1s buffer. Per point:
 *   - rttMs       = that second's rtt, or null when the ping was lost (!ok)
 *   - lossPercent = a TRAILING-WINDOW loss rate (fails / total over the last
 *                   `lossWindow` samples up to and including this point), so the
 *                   loss line is a smoothed recent rate rather than a 0/100 square
 *                   wave — which is what makes the existing NetworkChart's loss
 *                   series read meaningfully on a 1s feed.
 *   - sampled     = how many samples that window actually spanned (the readout's
 *                   "N pings"), and `target` the pinged pod IP.
 * `t` is converted to epoch MS for the chart's time-based axis labels.
 */
export function deriveChartSamples(
  raw: RawSample[],
  lossWindow: number,
  target: string | null,
): ChartSample[] {
  return raw.map((s, i) => {
    const start = Math.max(0, i - lossWindow + 1);
    const window = raw.slice(start, i + 1);
    const fails = window.reduce((acc, w) => acc + (w.ok ? 0 : 1), 0);
    const lossPercent = window.length === 0 ? null : Math.round((fails / window.length) * 100);
    return {
      t: s.t * 1000,
      lossPercent,
      rttMs: s.ok ? s.rtt : null,
      sampled: window.length,
      target,
    };
  });
}
