// packages/engine/test/eks-act.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { SSMClient, SendCommandCommand, GetCommandInvocationCommand } from "@aws-sdk/client-ssm";
import { AutoScalingClient, UpdateAutoScalingGroupCommand } from "@aws-sdk/client-auto-scaling";
import { eksAct } from "../src/handlers/eks.js";
const ssm = mockClient(SSMClient); const asg = mockClient(AutoScalingClient);
beforeEach(() => { ssm.reset(); asg.reset(); });
const p: any = { id: "api", layer: "API", kind: "eks_ssm", region: "us-east-1", creds: { mode: "default" },
  identifiers: { managerInstance: "i-1", namespace: "ns1", asg: "asg-1", asgRestoreCap: 2 }, restore: 2 };
const noCreds = () => undefined as any;
const okSsm = () => { ssm.on(SendCommandCommand).resolves({ Command: { CommandId: "c" } });
  ssm.on(GetCommandInvocationCommand).resolves({ Status: "Success", StandardOutputContent: "ok", StandardErrorContent: "" }); };

describe("eksAct", () => {
  it("stop scales deployment to 0", async () => {
    okSsm(); await eksAct(p, noCreds, "stop", { service: "dep" });
    expect((ssm.commandCalls(SendCommandCommand)[0].args[0].input as any).Parameters.commands[0]).toBe("kubectl scale deployment dep --replicas=0 -n ns1");
  });
  it("start uses count else restore", async () => {
    okSsm(); await eksAct(p, noCreds, "start", { service: "dep", count: 5 });
    expect((ssm.commandCalls(SendCommandCommand)[0].args[0].input as any).Parameters.commands[0]).toContain("--replicas=5");
  });
  it("restart rolls the deployment", async () => {
    okSsm(); await eksAct(p, noCreds, "restart", { service: "dep" });
    expect((ssm.commandCalls(SendCommandCommand)[0].args[0].input as any).Parameters.commands[0]).toBe("kubectl rollout restart deployment dep -n ns1");
  });
  it("stop-all sets ASG to 0", async () => {
    asg.on(UpdateAutoScalingGroupCommand).resolves({});
    await eksAct(p, noCreds, "stop-all", {});
    expect(asg.commandCalls(UpdateAutoScalingGroupCommand)[0].args[0].input).toMatchObject({ AutoScalingGroupName: "asg-1", MinSize: 0, DesiredCapacity: 0 });
  });
  it("start-all restores ASG to cap", async () => {
    asg.on(UpdateAutoScalingGroupCommand).resolves({});
    await eksAct(p, noCreds, "start-all", {});
    expect(asg.commandCalls(UpdateAutoScalingGroupCommand)[0].args[0].input).toMatchObject({ AutoScalingGroupName: "asg-1", MinSize: 2, DesiredCapacity: 2 });
  });
  it("dry-run makes no calls", async () => {
    const r = await eksAct(p, noCreds, "stop", { service: "dep", dryRun: true });
    expect(ssm.calls()).toHaveLength(0); expect(r.plan?.params).toMatchObject({ kubectl: "kubectl scale deployment dep --replicas=0 -n ns1" });
  });
});
