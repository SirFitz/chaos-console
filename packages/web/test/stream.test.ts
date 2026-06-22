// packages/web/test/stream.test.ts
import { describe, it, expect } from "vitest";
import {
  appendRawSamples,
  deriveChartSamples,
  parseProbeStart,
  parseProbeTail,
  type RawSample,
} from "../src/lib/stream.js";

const raw = (t: number, ok: boolean, rtt: number | null = ok ? 1 : null): RawSample => ({ t, ok, rtt });

describe("parseProbeStart", () => {
  it("reads the resolved target IP", () => {
    expect(parseProbeStart({ service: "p", probePod: "x", target: "10.0.0.5", started: true })).toEqual({ target: "10.0.0.5" });
  });
  it("returns null target for a missing/garbage result", () => {
    expect(parseProbeStart(undefined)).toEqual({ target: null });
    expect(parseProbeStart({ started: true })).toEqual({ target: null });
  });
});

describe("parseProbeTail", () => {
  it("coerces samples, mapping ok 1/true → reply and dropping rtt on a lost ping", () => {
    const { samples, podMissing } = parseProbeTail({
      service: "p",
      samples: [
        { t: 1, ok: 1, rtt: 0.8 },
        { t: 2, ok: 0 },
        { t: 3, ok: true, rtt: 2.5 },
        { t: 4, ok: false, rtt: 99 }, // stray rtt on a failure is ignored
      ],
    });
    expect(podMissing).toBe(false);
    expect(samples).toEqual([
      { t: 1, ok: true, rtt: 0.8 },
      { t: 2, ok: false, rtt: null },
      { t: 3, ok: true, rtt: 2.5 },
      { t: 4, ok: false, rtt: null },
    ]);
  });
  it("reports podMissing with empty samples (the pod isn't up yet / just stopped)", () => {
    expect(parseProbeTail({ service: "p", samples: [], podMissing: true })).toEqual({ samples: [], podMissing: true });
  });
  it("tolerates a missing/garbage result", () => {
    expect(parseProbeTail(undefined)).toEqual({ samples: [], podMissing: false });
    expect(parseProbeTail({})).toEqual({ samples: [], podMissing: false });
    expect(parseProbeTail({ samples: "nope" })).toEqual({ samples: [], podMissing: false });
  });
  it("skips individual malformed samples", () => {
    expect(parseProbeTail({ samples: [{ t: 1, ok: 1, rtt: 5 }, { ok: 1 }, null, 7] }).samples).toEqual([
      { t: 1, ok: true, rtt: 5 },
    ]);
  });
});

describe("appendRawSamples", () => {
  it("dedupes by t (overlapping tail windows) and keeps ascending order", () => {
    const prev = [raw(1, true, 2), raw(2, true, 3)];
    const incoming = [raw(2, true, 3), raw(3, false), raw(4, true, 5)]; // t=2 overlaps
    expect(appendRawSamples(prev, incoming, 100)).toEqual([raw(1, true, 2), raw(2, true, 3), raw(3, false), raw(4, true, 5)]);
  });
  it("newer wins on a t collision", () => {
    const out = appendRawSamples([raw(1, true, 2)], [raw(1, false)], 100);
    expect(out).toEqual([raw(1, false)]);
  });
  it("caps to the last `max` samples (oldest dropped)", () => {
    const prev = [raw(1, true), raw(2, true), raw(3, true)];
    expect(appendRawSamples(prev, [raw(4, true)], 2)).toEqual([raw(3, true), raw(4, true)]);
  });
  it("returns prev unchanged when nothing came in", () => {
    const prev = [raw(1, true)];
    expect(appendRawSamples(prev, [], 100)).toBe(prev);
  });
});

describe("deriveChartSamples", () => {
  it("maps rtt to latency (null on a lost ping) and converts t to epoch ms", () => {
    const out = deriveChartSamples([raw(1700000001, true, 4), raw(1700000002, false)], 10, "10.0.0.5");
    expect(out[0]).toMatchObject({ t: 1700000001000, rttMs: 4, lossPercent: 0, target: "10.0.0.5" });
    expect(out[1]).toMatchObject({ t: 1700000002000, rttMs: null });
  });
  it("computes a TRAILING-WINDOW loss% (fails/total over the last N up to each point)", () => {
    // window=2: point0 = [ok] -> 0%; point1 = [ok, fail] -> 50%; point2 = [fail, fail] -> 100%.
    const out = deriveChartSamples([raw(1, true, 2), raw(2, false), raw(3, false)], 2, null);
    expect(out.map((s) => s.lossPercent)).toEqual([0, 50, 100]);
    // `sampled` reflects how many samples that window actually spanned.
    expect(out.map((s) => s.sampled)).toEqual([1, 2, 2]);
  });
  it("a fully healthy buffer reads 0% loss everywhere", () => {
    const out = deriveChartSamples([raw(1, true, 1), raw(2, true, 1), raw(3, true, 1)], 10, null);
    expect(out.every((s) => s.lossPercent === 0)).toBe(true);
  });
  it("an empty buffer yields no points", () => {
    expect(deriveChartSamples([], 10, null)).toEqual([]);
  });
});
