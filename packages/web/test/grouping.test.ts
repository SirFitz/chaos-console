// packages/web/test/grouping.test.ts
import { describe, it, expect } from "vitest";
import { groupByLayerAndGroup, matchesFilter } from "../src/lib/grouping.js";
import type { ServiceStatus } from "@chaos/shared";

const svc = (over: Partial<ServiceStatus>): ServiceStatus => ({
  platformId: "p", layer: "MI", name: "x", mapped: true, ...over,
});

describe("groupByLayerAndGroup", () => {
  it("groups by layer then by group, with Unmapped last", () => {
    const rows = [
      svc({ layer: "API", name: "a1", group: "Gamma" }),
      svc({ layer: "MI", name: "m1", group: "Alpha" }),
      svc({ layer: "MI", name: "m2", mapped: false }),
      svc({ layer: "MI", name: "m3", group: "Alpha" }),
      svc({ layer: "RULES", name: "r1", group: "Beta" }),
    ];
    const out = groupByLayerAndGroup(rows);
    expect(out.map((l) => l.layer)).toEqual(["API", "MI", "RULES"]);
    const mi = out.find((l) => l.layer === "MI")!;
    expect(mi.groups.map((g) => g.group)).toEqual(["Alpha", "Unmapped"]);
    expect(mi.groups[0].services.map((s) => s.name)).toEqual(["m1", "m3"]);
    expect(mi.groups[1].services.map((s) => s.name)).toEqual(["m2"]);
  });

  it("omits layers with no services", () => {
    const out = groupByLayerAndGroup([svc({ layer: "API", name: "a1", group: "G" })]);
    expect(out.map((l) => l.layer)).toEqual(["API"]);
  });
});

describe("matchesFilter", () => {
  it("matches on name, group, and flow case-insensitively", () => {
    const s = svc({ name: "payments-api", group: "Settlement", flow: "FX-LEG" });
    expect(matchesFilter(s, "")).toBe(true);
    expect(matchesFilter(s, "PAY")).toBe(true);
    expect(matchesFilter(s, "settle")).toBe(true);
    expect(matchesFilter(s, "fx-leg")).toBe(true);
    expect(matchesFilter(s, "nope")).toBe(false);
  });
});
