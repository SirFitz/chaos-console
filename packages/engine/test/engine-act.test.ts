// packages/engine/test/engine-act.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { ECSClient, UpdateServiceCommand } from "@aws-sdk/client-ecs";
import { Engine } from "../src/engine.js";
const ecs = mockClient(ECSClient); beforeEach(() => ecs.reset());
const platforms: any = [{ id: "mi", layer: "MI", kind: "ecs", region: "us-east-1", creds: { mode: "profile", profile: "aws-profile-b" }, identifiers: { cluster: "c1" }, restore: 1 }];
describe("Engine.act", () => {
  it("routes ecs stop", async () => {
    ecs.on(UpdateServiceCommand).resolves({ service: { desiredCount: 0 } });
    const r = await new Engine(platforms).act("mi", "stop", { service: "svc" });
    expect(r).toMatchObject({ action: "stop", target: "svc" });
  });
  it("rejects invalid service names", async () => {
    await expect(new Engine(platforms).act("mi", "stop", { service: "bad name;rm" })).rejects.toThrow(/invalid service/i);
  });
  it("describeCreds returns a descriptor", () => {
    expect(new Engine(platforms).describeCreds("mi")).toBe("profile:aws-profile-b");
  });
});
