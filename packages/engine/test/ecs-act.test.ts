// packages/engine/test/ecs-act.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { ECSClient, UpdateServiceCommand, ListTasksCommand, StopTaskCommand } from "@aws-sdk/client-ecs";
import { ecsAct } from "../src/handlers/ecs.js";
const ecs = mockClient(ECSClient);
beforeEach(() => ecs.reset());
const p: any = { id: "mi", layer: "MI", kind: "ecs", region: "us-east-1", creds: { mode: "default" }, identifiers: { cluster: "c1" }, restore: 1 };
const noCreds = () => undefined as any;

describe("ecsAct", () => {
  it("stop sets desiredCount 0", async () => {
    ecs.on(UpdateServiceCommand).resolves({ service: { serviceName: "svc", desiredCount: 0 } });
    const r = await ecsAct(p, noCreds, "stop", { service: "svc" });
    const call = ecs.commandCalls(UpdateServiceCommand)[0].args[0].input as any;
    expect(call).toMatchObject({ cluster: "c1", service: "svc", desiredCount: 0 });
    expect(r).toMatchObject({ action: "stop", target: "svc", dryRun: false });
  });
  it("start uses count, else restore default", async () => {
    ecs.on(UpdateServiceCommand).resolves({});
    await ecsAct(p, noCreds, "start", { service: "svc", count: 3 });
    expect((ecs.commandCalls(UpdateServiceCommand)[0].args[0].input as any).desiredCount).toBe(3);
  });
  it("restart stops the running task", async () => {
    ecs.on(ListTasksCommand).resolves({ taskArns: ["arn:task1"] });
    ecs.on(StopTaskCommand).resolves({ task: { taskArn: "arn:task1", lastStatus: "STOPPING" } });
    const r = await ecsAct(p, noCreds, "restart", { service: "svc" });
    expect(ecs.commandCalls(StopTaskCommand)[0].args[0].input).toMatchObject({ cluster: "c1", task: "arn:task1" });
    expect(r.target).toBe("svc");
  });
  it("dry-run makes no AWS calls and returns a plan", async () => {
    const r = await ecsAct(p, noCreds, "stop", { service: "svc", dryRun: true });
    expect(ecs.calls()).toHaveLength(0);
    expect(r.dryRun).toBe(true);
    expect(r.plan).toMatchObject({ awsCall: "ecs:UpdateService", params: { cluster: "c1", service: "svc", desiredCount: 0 } });
  });
  it("stop-all is rejected for ecs", async () => {
    await expect(ecsAct(p, noCreds, "stop-all", {})).rejects.toThrow(/not supported/i);
  });
});
