// packages/web/src/components/NetworkChart.tsx
//
// A hand-rolled SVG line chart (NO charting dependency) that visualises packet
// chaos taking effect over time. It plots two series collected from repeated
// net-verify samples while the detail page is open:
//   - packet loss %   (violet, the "chaos" hue — fixed 0..100 left axis)
//   - latency ms      (indigo accent — right axis auto-scaled to the data)
// Tokens + tabular-nums per DESIGN.md; middle-dot separators; no em dashes.
import React from "react";
import { formatMeasurement, type Measurement } from "../lib/verify.js";

/** One plotted point: a measurement plus the wall-clock time it was taken. */
export interface ChartSample {
  /** Epoch ms the sample was collected (used for the elapsed-time axis labels). */
  t: number;
  /** Measured packet loss %, or null when the summary was unparseable. */
  lossPercent: number | null;
  /** Measured average round-trip in ms, or null when no replies came back. */
  rttMs: number | null;
  /** ICMP echoes the probe sent (for the readout). */
  sampled: number;
  /** Resolved pod IP that was pinged, for the readout/title. */
  target: string | null;
}

/** Lift a verify Measurement into a timestamped chart sample. */
export function sampleFromMeasurement(m: Measurement, t: number = Date.now()): ChartSample {
  return { t, lossPercent: m.lossPercent, rttMs: m.rttMs, sampled: m.sampled, target: m.target };
}

// Viewbox geometry. The chart is drawn in a fixed coordinate space and scaled to
// fit its container via width=100%; padding leaves room for the two axes.
const W = 640;
const H = 200;
const PAD = { top: 14, right: 44, bottom: 22, left: 36 };
const PLOT_W = W - PAD.left - PAD.right;
const PLOT_H = H - PAD.top - PAD.bottom;

/** Round to one decimal, dropping a trailing ".0". */
function num(n: number): string {
  return String(Math.round(n * 10) / 10);
}

/** A "nice" upper bound for the latency axis (>= max, rounded up to 50/100/...). */
function niceMax(max: number): number {
  if (max <= 0) return 100;
  const pow = Math.pow(10, Math.floor(Math.log10(max)));
  const steps = [1, 2, 2.5, 5, 10];
  for (const s of steps) {
    const candidate = s * pow;
    if (candidate >= max) return candidate;
  }
  return 10 * pow;
}

/** Map sample index -> x within the plot (single point sits at the left edge). */
function xAt(i: number, n: number): number {
  if (n <= 1) return PAD.left;
  return PAD.left + (i / (n - 1)) * PLOT_W;
}

/** Map a value in [0,max] -> y within the plot (inverted; clamped). */
function yAt(value: number, max: number): number {
  const clamped = Math.max(0, Math.min(value, max));
  return PAD.top + PLOT_H * (1 - clamped / max);
}

/** Build an SVG polyline `points` string for one series, skipping null gaps. */
function pointsFor(
  samples: ChartSample[],
  pick: (s: ChartSample) => number | null,
  max: number,
): string {
  const n = samples.length;
  return samples
    .map((s, i) => {
      const v = pick(s);
      if (v === null) return null;
      return `${xAt(i, n).toFixed(1)},${yAt(v, max).toFixed(1)}`;
    })
    .filter((p): p is string => p !== null)
    .join(" ");
}

/** A small legend swatch + label. */
function LegendItem({ color, label }: { color: string; label: string }): React.ReactElement {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="h-0.5 w-3 rounded-full" style={{ backgroundColor: color }} aria-hidden="true" />
      <span className="text-ink-soft">{label}</span>
    </span>
  );
}

export function NetworkChart({ samples }: { samples: ChartSample[] }): React.ReactElement {
  // Empty state: a teaching line before the first sample lands (DESIGN.md empty).
  if (samples.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border bg-panel px-6 py-10 text-center">
        <p className="text-sm font-medium text-ink">No measurements yet.</p>
        <p className="mt-1 text-xs text-ink-faint">
          Each sample pings a pod of this service and plots packet loss and latency over time. Inject
          packet chaos, then watch loss climb and replies slow as it takes effect.
        </p>
      </div>
    );
  }

  const lossColor = "var(--chaos)";
  const rttColor = "var(--accent)";

  // Latency axis scales to the data (loss is always 0..100). Floor it at 50ms so a
  // healthy sub-millisecond baseline sits near the bottom instead of pinned to the
  // top; a real delay injection (100ms+) rescales the axis upward.
  const MIN_RTT_AXIS = 50;
  const rttValues = samples.map((s) => s.rttMs).filter((v): v is number => v !== null);
  const rttMax = niceMax(Math.max(rttValues.length ? Math.max(...rttValues) : 0, MIN_RTT_AXIS));

  const lossPoints = pointsFor(samples, (s) => s.lossPercent, 100);
  const rttPoints = pointsFor(samples, (s) => s.rttMs, rttMax);

  const latest = samples[samples.length - 1];
  // Readout, e.g. "loss 60% · 204 ms · 20 pings". Falls back per-field.
  const readout = [
    latest.lossPercent === null ? "loss unknown" : `loss ${num(latest.lossPercent)}%`,
    latest.rttMs === null ? "no replies" : `${num(latest.rttMs)} ms`,
    `${latest.sampled} ping${latest.sampled === 1 ? "" : "s"}`,
  ].join(" · ");

  // Horizontal gridlines for the loss axis at 0 / 50 / 100.
  const lossTicks = [0, 50, 100];

  return (
    <div className="rounded-lg border border-border bg-panel p-3">
      <div className="mb-1.5 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-1">
        <div className="flex items-center gap-3 text-xs">
          <LegendItem color={lossColor} label="packet loss %" />
          <LegendItem color={rttColor} label="latency ms" />
        </div>
        <span className="tnum text-xs font-medium text-ink" role="status" aria-label="latest sample">
          {readout}
        </span>
      </div>

      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="block w-full"
        role="img"
        aria-label={`Network chart: ${samples.length} samples, latest ${readout}`}
        preserveAspectRatio="none"
      >
        {/* Loss gridlines + left-axis labels (0..100). */}
        {lossTicks.map((t) => {
          const y = yAt(t, 100);
          return (
            <g key={`loss-${t}`}>
              <line
                x1={PAD.left}
                x2={W - PAD.right}
                y1={y}
                y2={y}
                stroke="var(--border)"
                strokeWidth={1}
                strokeDasharray={t === 0 ? undefined : "2 3"}
              />
              <text
                x={PAD.left - 6}
                y={y + 3}
                textAnchor="end"
                className="tnum"
                fontSize={9}
                fill="var(--ink-faint)"
              >
                {t}
              </text>
            </g>
          );
        })}

        {/* Right-axis labels for latency (0 / mid / max). */}
        {[0, rttMax / 2, rttMax].map((t, i) => (
          <text
            key={`rtt-${i}`}
            x={W - PAD.right + 6}
            y={yAt(t, rttMax) + 3}
            textAnchor="start"
            className="tnum"
            fontSize={9}
            fill={rttColor}
          >
            {num(t)}
          </text>
        ))}

        {/* Latency series (under loss so the disruption line reads on top). */}
        {rttPoints && (
          <polyline
            points={rttPoints}
            fill="none"
            stroke={rttColor}
            strokeWidth={1.5}
            strokeLinejoin="round"
            strokeLinecap="round"
            opacity={0.9}
          />
        )}

        {/* Loss series. */}
        {lossPoints && (
          <polyline
            points={lossPoints}
            fill="none"
            stroke={lossColor}
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        )}

        {/* Dot markers on the latest point of each series, so a single sample is
            still visible (a one-point polyline draws nothing). */}
        {latest.rttMs !== null && (
          <circle cx={xAt(samples.length - 1, samples.length)} cy={yAt(latest.rttMs, rttMax)} r={2.5} fill={rttColor} />
        )}
        {latest.lossPercent !== null && (
          <circle cx={xAt(samples.length - 1, samples.length)} cy={yAt(latest.lossPercent, 100)} r={2.5} fill={lossColor} />
        )}
      </svg>
    </div>
  );
}

/** Re-export the verify formatter so callers can render the long-form sentence too. */
export { formatMeasurement };
