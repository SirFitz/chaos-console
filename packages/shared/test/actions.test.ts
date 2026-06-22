// packages/shared/test/actions.test.ts
import { describe, it, expect } from "vitest";
import { ACTIONS, isDestructive, isReadOnly, isMutating, type ActionRequest } from "../src/index.js";
describe("actions", () => {
  it("lists the M2 actions", () => {
    expect(ACTIONS.slice(0, 6)).toEqual(["status","stop","start","restart","stop-all","start-all"]);
  });
  it("marks stop/restart/stop-all destructive", () => {
    expect(["stop","restart","stop-all"].every(isDestructive)).toBe(true);
    expect(["start","start-all","status"].some(isDestructive)).toBe(false);
  });
  it("lists the M3 net actions, the L7 path + preflight actions, and the streaming probe trio", () => {
    expect(ACTIONS).toEqual([
      "status","stop","start","restart","stop-all","start-all",
      "net-loss","net-delay","net-partition","net-clear","net-status","net-block","net-verify",
      "net-path-cut","net-path-degrade","net-path-clear","net-preflight",
      "net-probe-start","net-probe-tail","net-probe-stop",
    ]);
  });
  it("marks the injecting net actions destructive but not net-clear/net-status/net-verify", () => {
    expect(["net-loss","net-delay","net-partition","net-block"].every(isDestructive)).toBe(true);
    expect(["net-clear","net-status","net-verify"].some(isDestructive)).toBe(false);
  });
  it("classifies the L7 path + preflight actions", () => {
    // path cut/degrade inject an L7 fault -> destructive (need confirm), mutating, audited.
    expect(["net-path-cut","net-path-degrade"].every(isDestructive)).toBe(true);
    expect(["net-path-cut","net-path-degrade"].every(isMutating)).toBe(true);
    // path-clear removes the overlay: a state change (mutation) but not destructive.
    expect(isDestructive("net-path-clear")).toBe(false);
    expect(isMutating("net-path-clear")).toBe(true);
    // preflight only measures backend capability -> a read, never audited.
    expect(isReadOnly("net-preflight")).toBe(true);
    expect(isMutating("net-preflight")).toBe(false);
  });
  it("net-verify is read-only (it measures; must not be audited)", () => {
    expect(isReadOnly("net-verify")).toBe(true);
    expect(isMutating("net-verify")).toBe(false);
    // sanity: status/net-status are reads; net-clear is a mutation
    expect(isReadOnly("net-status")).toBe(true);
    expect(isMutating("net-clear")).toBe(true);
  });
  it("the streaming probe trio is read-only (measures only; never audited; not destructive)", () => {
    for (const a of ["net-probe-start", "net-probe-tail", "net-probe-stop"]) {
      expect(isReadOnly(a)).toBe(true);
      expect(isMutating(a)).toBe(false);
      expect(isDestructive(a)).toBe(false);
    }
  });
  it("carries the net action request fields (incl. L7 path)", () => {
    const r: ActionRequest = { service: "svc", loss: 50, delay: "200ms", cidr: "203.0.113.10/32",
      backend: "pumba", duration: "5m", direction: "from", host: "api.example", path: "/charge" };
    expect(r.loss).toBe(50); expect(r.backend).toBe("pumba"); expect(r.direction).toBe("from");
    expect(r.host).toBe("api.example"); expect(r.path).toBe("/charge");
  });
});
