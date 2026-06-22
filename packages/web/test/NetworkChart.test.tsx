// packages/web/test/NetworkChart.test.tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { NetworkChart, sampleFromMeasurement, type ChartSample } from "../src/components/NetworkChart.js";

const sample = (o: Partial<ChartSample>): ChartSample => ({
  t: 1_700_000_000_000,
  lossPercent: 0,
  rttMs: 5,
  sampled: 20,
  target: "10.0.0.1",
  ...o,
});

describe("<NetworkChart/>", () => {
  it("shows a teaching empty state before the first sample", () => {
    render(<NetworkChart samples={[]} />);
    expect(screen.getByText(/no measurements yet/i)).toBeInTheDocument();
    // No SVG plotted yet.
    expect(screen.queryByRole("img", { name: /network chart/i })).not.toBeInTheDocument();
  });

  it("plots an SVG and a numeric readout once a sample exists", () => {
    render(<NetworkChart samples={[sample({ lossPercent: 60, rttMs: 204, sampled: 20 })]} />);
    expect(screen.getByRole("img", { name: /network chart/i })).toBeInTheDocument();
    expect(screen.getByText(/loss 60% · 204 ms · 20 pings/)).toBeInTheDocument();
  });

  it("reads out the latest sample when several are present", () => {
    render(
      <NetworkChart
        samples={[
          sample({ lossPercent: 0, rttMs: 5 }),
          sample({ lossPercent: 47, rttMs: 205.1 }),
          sample({ lossPercent: 100, rttMs: null, sampled: 20 }),
        ]}
      />,
    );
    // Latest point: total loss, no replies.
    expect(screen.getByText(/loss 100% · no replies · 20 pings/)).toBeInTheDocument();
  });

  it("sampleFromMeasurement lifts a measurement into a timestamped point", () => {
    const s = sampleFromMeasurement(
      { service: "payments", target: "10.1.2.3", sampled: 20, lossPercent: 30, rttMs: 88 },
      12345,
    );
    expect(s).toEqual({ t: 12345, lossPercent: 30, rttMs: 88, sampled: 20, target: "10.1.2.3" });
  });
});
