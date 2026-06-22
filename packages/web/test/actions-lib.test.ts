// packages/web/test/actions-lib.test.ts
import { describe, it, expect } from "vitest";
import { actionsForKind, needsConfirm } from "../src/lib/actions.js";

describe("actionsForKind", () => {
  it("eks_ssm offers scale/restart/stop-all/start-all + eks net-* (no net-block, no net-status)", () => {
    const a = actionsForKind("eks_ssm");
    expect(a).toContain("stop");
    expect(a).toContain("start");
    expect(a).toContain("restart");
    expect(a).toContain("stop-all");
    expect(a).toContain("start-all");
    expect(a).toContain("net-loss");
    expect(a).toContain("net-delay");
    expect(a).toContain("net-partition");
    expect(a).toContain("net-clear");
    expect(a).not.toContain("net-block");
    // net-status is a read (lives in the Active Chaos panel), never a drawer action.
    expect(a).not.toContain("net-status");
  });
  it("ecs offers scale/restart + net-block/clear (no stop-all/start-all, no net-loss, no net-status)", () => {
    const a = actionsForKind("ecs");
    expect(a).toContain("stop");
    expect(a).toContain("start");
    expect(a).toContain("restart");
    expect(a).toContain("net-block");
    expect(a).toContain("net-clear");
    expect(a).not.toContain("stop-all");
    expect(a).not.toContain("net-loss");
    expect(a).not.toContain("net-status");
  });

  it("eks_ssm offers the L7 path actions (cut/degrade/clear) but never net-preflight (a read)", () => {
    const a = actionsForKind("eks_ssm");
    expect(a).toContain("net-path-cut");
    expect(a).toContain("net-path-degrade");
    expect(a).toContain("net-path-clear");
    // net-preflight backs the health chip; it is a read, never a drawer action.
    expect(a).not.toContain("net-preflight");
  });

  it("ecs offers none of the L7 path actions (no ingress controller to overlay)", () => {
    const a = actionsForKind("ecs");
    expect(a).not.toContain("net-path-cut");
    expect(a).not.toContain("net-path-degrade");
    expect(a).not.toContain("net-path-clear");
    expect(a).not.toContain("net-preflight");
  });
});

describe("needsConfirm", () => {
  it("matches the server DESTRUCTIVE set", () => {
    expect(needsConfirm("stop")).toBe(true);
    expect(needsConfirm("restart")).toBe(true);
    expect(needsConfirm("stop-all")).toBe(true);
    expect(needsConfirm("net-loss")).toBe(true);
    expect(needsConfirm("net-block")).toBe(true);
    expect(needsConfirm("start")).toBe(false);
    expect(needsConfirm("net-clear")).toBe(false);
    expect(needsConfirm("net-status")).toBe(false);
  });

  it("the destructive L7 path faults need confirm; clearing one does not", () => {
    expect(needsConfirm("net-path-cut")).toBe(true);
    expect(needsConfirm("net-path-degrade")).toBe(true);
    expect(needsConfirm("net-path-clear")).toBe(false);
  });
});
