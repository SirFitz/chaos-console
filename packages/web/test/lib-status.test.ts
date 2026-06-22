// packages/web/test/lib-status.test.ts
import { describe, it, expect } from "vitest";
import type { ServiceStatus } from "@chaos/shared";
import {
  deriveStatus,
  deriveMeter,
  countsUnknown,
  statusSignature,
} from "../src/lib/status.js";

const svc = (o: Partial<ServiceStatus>): ServiceStatus => ({
  platformId: "mi",
  layer: "MI",
  name: "x",
  mapped: true,
  ...o,
});

describe("deriveStatus", () => {
  it("running === desired (>0) => Running / ok", () => {
    expect(deriveStatus(svc({ running: 2, desired: 2 }))).toMatchObject({ word: "Running", tone: "ok", pulse: false });
  });

  it("running === 0 && desired > 0 => Stopped / bad", () => {
    expect(deriveStatus(svc({ running: 0, desired: 2 }))).toMatchObject({ word: "Stopped", tone: "bad" });
  });

  it("0 < running < desired => Scaling / warn with a pulsing dot", () => {
    expect(deriveStatus(svc({ running: 1, desired: 3 }))).toMatchObject({ word: "Scaling", tone: "warn", pulse: true });
  });

  it("pending tasks => Pending / warn with a pulsing dot", () => {
    expect(deriveStatus(svc({ running: 1, desired: 1, pending: 1 }))).toMatchObject({ word: "Pending", tone: "warn", pulse: true });
  });

  it("a STOPPED provider state forces Stopped even if counts look ok", () => {
    expect(deriveStatus(svc({ running: 1, desired: 1, state: "STOPPED" }))).toMatchObject({ word: "Stopped", tone: "bad" });
  });

  it("running > 0 with no desired known => Running", () => {
    expect(deriveStatus(svc({ running: 2 }))).toMatchObject({ word: "Running", tone: "ok" });
  });

  it("no counts at all => Unknown / neutral", () => {
    expect(deriveStatus(svc({ mapped: false }))).toMatchObject({ word: "Unknown", tone: "neutral" });
  });
});

describe("deriveMeter — the no-0/2 rules", () => {
  it("running === desired colors ok and labels 'N / N'", () => {
    const m = deriveMeter(svc({ running: 2, desired: 2 }));
    expect(m.tone).toBe("ok");
    expect(m.label).toBe("2 / 2");
  });

  it("0 < running < desired colors warn", () => {
    expect(deriveMeter(svc({ running: 1, desired: 3 })).tone).toBe("warn");
  });

  it("running === 0 && desired > 0 colors bad and labels '0 / N'", () => {
    const m = deriveMeter(svc({ running: 0, desired: 2 }));
    expect(m.tone).toBe("bad");
    expect(m.label).toBe("0 / 2");
  });

  it("unknown counts -> label '—', never '0/0'", () => {
    const m = deriveMeter(svc({}));
    expect(m.running).toBeNull();
    expect(m.desired).toBeNull();
    expect(m.label).toBe("—");
    expect(m.label).not.toMatch(/0\s*\/\s*0/);
  });

  it("one count known but not the other never renders '1/0' or '0/0'", () => {
    // desired known, running unknown
    expect(deriveMeter(svc({ desired: 2 })).label).not.toMatch(/\/\s*0/);
    // running known, desired unknown
    const onlyRunning = deriveMeter(svc({ running: 1 }));
    expect(onlyRunning.label).not.toBe("1 / 0");
    expect(onlyRunning.label).not.toBe("0 / 0");
  });

  it("filled never exceeds the segment count", () => {
    const m = deriveMeter(svc({ running: 50, desired: 50 }));
    expect(m.filled).toBeLessThanOrEqual(m.segments);
    expect(m.filled).toBe(m.segments);
  });
});

describe("countsUnknown", () => {
  it("true only when both running and desired are absent", () => {
    expect(countsUnknown(svc({}))).toBe(true);
    expect(countsUnknown(svc({ running: 0 }))).toBe(false);
    expect(countsUnknown(svc({ desired: 0 }))).toBe(false);
  });
});

describe("statusSignature", () => {
  it("changes when live counts change, stable when only static fields change", () => {
    const a = statusSignature(svc({ running: 1, desired: 2, name: "a" }));
    const b = statusSignature(svc({ running: 2, desired: 2, name: "a" }));
    const c = statusSignature(svc({ running: 1, desired: 2, name: "z", group: "other" }));
    expect(a).not.toBe(b);
    expect(a).toBe(c);
  });
});
