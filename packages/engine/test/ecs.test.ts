// packages/engine/test/ecs.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { ECSClient, ListServicesCommand, DescribeServicesCommand } from "@aws-sdk/client-ecs";
import { ecsStatus } from "../src/handlers/ecs.js";

const ecs = mockClient(ECSClient);
beforeEach(() => ecs.reset());

const platform: any = { id: "mi", layer: "MI", kind: "ecs", region: "us-east-1",
  creds: { mode: "default" }, identifiers: { cluster: "c1" } };

describe("ecsStatus", () => {
  it("lists service names with running/desired counts when no service filter", async () => {
    ecs.on(ListServicesCommand).resolves({ serviceArns: ["arn:.../c1/svc-a", "arn:.../c1/svc-b"] });
    ecs.on(DescribeServicesCommand).resolves({ services: [
      { serviceName: "svc-a", status: "ACTIVE", desiredCount: 2, runningCount: 2, pendingCount: 0 },
      { serviceName: "svc-b", status: "ACTIVE", desiredCount: 1, runningCount: 0, pendingCount: 0 },
    ] });
    const r = await ecsStatus(platform, () => undefined as any, undefined);
    expect(r.map((s) => s.name)).toEqual(["svc-a", "svc-b"]);
    expect(r[0]).toMatchObject({ platformId: "mi", layer: "MI", mapped: false, desired: 2, running: 2 });
    expect(r[1]).toMatchObject({ name: "svc-b", desired: 1, running: 0 });
  });

  it("returns names only (no counts) when the cluster has no services", async () => {
    ecs.on(ListServicesCommand).resolves({ serviceArns: [] });
    const r = await ecsStatus(platform, () => undefined as any, undefined);
    expect(r).toEqual([]);
    expect(ecs.commandCalls(DescribeServicesCommand)).toHaveLength(0);
  });
  it("returns counts for a specific service", async () => {
    ecs.on(DescribeServicesCommand).resolves({ services: [
      { serviceName: "svc-a", status: "ACTIVE", desiredCount: 2, runningCount: 1, pendingCount: 0 }] });
    const r = await ecsStatus(platform, () => undefined as any, "svc-a");
    expect(r[0]).toMatchObject({ name: "svc-a", desired: 2, running: 1, pending: 0, state: "ACTIVE" });
  });
});
