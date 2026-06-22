import { describe, it, expect } from "vitest";
import { ok, fail, LAYERS } from "../src/index.js";

describe("api envelope", () => {
  it("ok() wraps data", () => {
    expect(ok({ a: 1 }, "aud1")).toEqual({ ok: true, data: { a: 1 }, auditId: "aud1" });
  });
  it("fail() wraps an error", () => {
    expect(fail("NOT_FOUND", "missing")).toEqual({ ok: false, error: { code: "NOT_FOUND", message: "missing" }, auditId: null });
  });
  it("exposes the three layers", () => {
    expect(LAYERS).toEqual(["API", "MI", "RULES"]);
  });
});
