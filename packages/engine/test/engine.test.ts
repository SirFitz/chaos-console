// packages/engine/test/engine.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { ECSClient, ListServicesCommand } from "@aws-sdk/client-ecs";
import { Engine } from "../src/engine.js";

const ecs = mockClient(ECSClient);
beforeEach(() => ecs.reset());

const platforms: any = [{ id: "mi", layer: "MI", kind: "ecs", region: "us-east-1",
  creds: { mode: "default" }, identifiers: { cluster: "c1" } }];

describe("Engine", () => {
  it("lists configured platforms without secrets", () => {
    const e = new Engine(platforms);
    expect(e.listPlatforms()).toEqual([{ id: "mi", layer: "MI", kind: "ecs", region: "us-east-1", cluster: "c1" }]);
  });
  it("routes status() to the ecs handler", async () => {
    ecs.on(ListServicesCommand).resolves({ serviceArns: ["a/c1/svc-x"] });
    const e = new Engine(platforms);
    const r = await e.status("mi");
    expect(r[0].name).toBe("svc-x");
  });
  it("throws on unknown platform", async () => {
    await expect(new Engine(platforms).status("nope")).rejects.toThrow(/unknown platform/i);
  });
});
