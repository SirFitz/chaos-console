// packages/web/test/verify-lib.test.ts
import { describe, it, expect } from "vitest";
import { formatMeasurement, toMeasurement } from "../src/lib/verify.js";

describe("toMeasurement", () => {
  it("coerces a well-formed probe result", () => {
    expect(toMeasurement({ service: "payments", target: "10.0.0.1", sampled: 20, lossPercent: 47, rttMs: 205.1 }))
      .toEqual({ service: "payments", target: "10.0.0.1", sampled: 20, lossPercent: 47, rttMs: 205.1 });
  });
  it("defaults missing/odd fields (null target + rtt, 0 sampled)", () => {
    expect(toMeasurement({ service: "payments" }))
      .toEqual({ service: "payments", target: null, sampled: 0, lossPercent: null, rttMs: null });
  });
  it("returns null for a non-measurement payload", () => {
    expect(toMeasurement(null)).toBeNull();
    expect(toMeasurement({ output: "kubectl text" })).toBeNull();
  });
});

describe("formatMeasurement", () => {
  it("builds the plain-language sentence with tabular numbers", () => {
    expect(formatMeasurement({ service: "payments", target: "10.0.0.1", sampled: 20, lossPercent: 47, rttMs: 205.1 }))
      .toBe("Measured: 47% packet loss · ~205.1 ms avg (20 pings to 10.0.0.1)");
  });
  it("rounds rtt to one decimal and drops a trailing .0", () => {
    expect(formatMeasurement({ service: "s", target: "1.2.3.4", sampled: 20, lossPercent: 0, rttMs: 205.04 }))
      .toBe("Measured: 0% packet loss · ~205 ms avg (20 pings to 1.2.3.4)");
  });
  it("says 'no replies' when rtt is null (total loss)", () => {
    expect(formatMeasurement({ service: "s", target: "1.2.3.4", sampled: 20, lossPercent: 100, rttMs: null }))
      .toBe("Measured: 100% packet loss · no replies (20 pings to 1.2.3.4)");
  });
  it("degrades gracefully when loss/target are unknown", () => {
    expect(formatMeasurement({ service: "s", target: null, sampled: 1, lossPercent: null, rttMs: 5 }))
      .toBe("Measured: packet loss unknown · ~5 ms avg (1 ping)");
  });
});
