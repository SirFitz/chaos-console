// packages/engine/test/engine-net.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { SSMClient, SendCommandCommand, GetCommandInvocationCommand } from "@aws-sdk/client-ssm";
import { ECSClient, ListTasksCommand } from "@aws-sdk/client-ecs";
import { Engine } from "../src/engine.js";

const ssm = mockClient(SSMClient);
const ecs = mockClient(ECSClient);
beforeEach(() => { ssm.reset(); ecs.reset(); });
const okSsm = () => {
  ssm.on(SendCommandCommand).resolves({ Command: { CommandId: "c" } });
  ssm.on(GetCommandInvocationCommand).resolves({ Status: "Success", StandardOutputContent: "ok", StandardErrorContent: "" });
};
const platforms: any = [
  { id: "api", layer: "API", kind: "eks_ssm", region: "us-east-1", creds: { mode: "default" }, identifiers: { managerInstance: "i-1", namespace: "ns1" }, restore: 2 },
  { id: "mi", layer: "MI", kind: "ecs", region: "us-east-1", creds: { mode: "default" }, identifiers: { cluster: "c1" }, restore: 1 },
];

describe("Engine net-* routing", () => {
  it("routes net-loss to the eks handler", async () => {
    okSsm();
    const r = await new Engine(platforms).act("api", "net-loss", { service: "dep" });
    expect(r.action).toBe("net-loss");
    expect((ssm.commandCalls(SendCommandCommand)[0].args[0].input as any).Parameters.commands[0]).toContain("kubectl apply -f -");
  });
  it("routes net-block to the ecs handler", async () => {
    ecs.on(ListTasksCommand).resolves({ taskArns: [] }); // → no-NACL error path proves it reached ecs
    await expect(new Engine(platforms).act("mi", "net-block", { cidr: "203.0.113.10/32" }))
      .rejects.toThrow(/NACL|running tasks/i);
  });
  it("rejects net-block on an eks platform", async () => {
    await expect(new Engine(platforms).act("api", "net-block", { cidr: "203.0.113.10/32" }))
      .rejects.toThrow(/net-block.*not.*eks|not supported.*eks/i);
  });
  it("rejects net-loss on an ecs platform", async () => {
    await expect(new Engine(platforms).act("mi", "net-loss", { service: "dep" }))
      .rejects.toThrow(/net-loss.*not.*ecs|not supported.*ecs/i);
  });
  it("rejects net-verify on an ecs platform (empirical verification is eks-only)", async () => {
    await expect(new Engine(platforms).act("mi", "net-verify", { service: "dep" }))
      .rejects.toThrow(/net-verify.*not.*ecs|not supported.*ecs|eks-only/i);
  });
  it("routes net-verify to the eks handler (resolves a pod IP, runs a probe)", async () => {
    ssm.on(SendCommandCommand).resolves({ Command: { CommandId: "c" } });
    ssm.on(GetCommandInvocationCommand).resolves({ Status: "Success",
      StandardOutputContent: "TARGET_IP=10.0.0.5\n20 packets transmitted, 10 packets received, 50% packet loss\nround-trip min/avg/max = 1/9/20 ms", StandardErrorContent: "" });
    const r = await new Engine(platforms).act("api", "net-verify", { service: "dep" });
    expect(r.action).toBe("net-verify");
    expect(r.result).toMatchObject({ lossPercent: 50, rttMs: 9, target: "10.0.0.5" });
  });
  it("routes the streaming probe actions to the eks handler", async () => {
    okSsm();
    const r = await new Engine(platforms).act("api", "net-probe-stop", { service: "dep" });
    expect(r.action).toBe("net-probe-stop");
    expect((ssm.commandCalls(SendCommandCommand)[0].args[0].input as any).Parameters.commands[0])
      .toContain("kubectl delete pod chaos-streamprobe-dep");
  });
  it("rejects the streaming probe actions on an ecs platform (eks-only)", async () => {
    for (const a of ["net-probe-start", "net-probe-tail", "net-probe-stop"] as const)
      await expect(new Engine(platforms).act("mi", a, { service: "dep" }))
        .rejects.toThrow(/not supported.*ecs|eks-only/i);
  });
  it("platformIds lists configured ids", () => {
    expect(new Engine(platforms).platformIds()).toEqual(["api", "mi"]);
  });
});
