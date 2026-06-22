// packages/web/src/lib/verify.ts
//
// The net-verify probe (engine: eks.ts) returns a measurement of the in-flight
// packet chaos. These helpers shape that result and turn it into the one-line
// plain-language sentence shown in the Active chaos view, so the component stays
// presentational. No em dashes (DESIGN.md ban); middle-dot separators.

/** Parsed result of a net-verify probe (mirrors the engine's ActionOutcome.result). */
export interface Measurement {
  service: string;
  /** Resolved pod IP that was pinged, or null if it could not be read back. */
  target: string | null;
  /** How many ICMP echoes the probe sent. */
  sampled: number;
  /** Measured packet loss %, or null if the summary was unparseable. */
  lossPercent: number | null;
  /** Measured average round-trip in ms, or null when no replies came back. */
  rttMs: number | null;
}

/** Coerce an arbitrary ActionOutcome.result into a Measurement (defensive). */
export function toMeasurement(result: unknown): Measurement | null {
  if (typeof result !== "object" || result === null) return null;
  const r = result as Record<string, unknown>;
  if (typeof r.service !== "string") return null;
  return {
    service: r.service,
    target: typeof r.target === "string" ? r.target : null,
    sampled: typeof r.sampled === "number" ? r.sampled : 0,
    lossPercent: typeof r.lossPercent === "number" ? r.lossPercent : null,
    rttMs: typeof r.rttMs === "number" ? r.rttMs : null,
  };
}

/** Round to at most one decimal, dropping a trailing ".0" (e.g. 205.0 -> "205"). */
function num(n: number): string {
  return String(Math.round(n * 10) / 10);
}

/**
 * Build the measurement sentence, e.g.
 *   "Measured: 47% packet loss · ~205 ms avg (20 pings to 10.0.0.1)"
 * Falls back gracefully when loss / rtt / target are unknown.
 */
export function formatMeasurement(m: Measurement): string {
  const loss = m.lossPercent === null ? "packet loss unknown" : `${num(m.lossPercent)}% packet loss`;
  const rtt = m.rttMs === null ? "no replies" : `~${num(m.rttMs)} ms avg`;
  const pings = `${m.sampled} ping${m.sampled === 1 ? "" : "s"}`;
  const to = m.target ? ` to ${m.target}` : "";
  return `Measured: ${loss} · ${rtt} (${pings}${to})`;
}
