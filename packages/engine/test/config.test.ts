// packages/engine/test/config.test.ts
import { describe, it, expect } from "vitest";
import { parsePlatforms } from "../src/config.js";

describe("parsePlatforms", () => {
  it("parses a valid ecs + eks config", () => {
    const cfg = parsePlatforms([
      { id: "mi", layer: "MI", kind: "ecs", region: "us-east-1",
        creds: { mode: "profile", profile: "aws-profile-b" }, identifiers: { cluster: "c1" } },
      { id: "api", layer: "API", kind: "eks_ssm", region: "us-east-1",
        creds: { mode: "default" }, identifiers: { managerInstance: "i-1", namespace: "ns1" } },
    ]);
    expect(cfg.map((p) => p.id)).toEqual(["mi", "api"]);
  });
  it("rejects an ecs platform missing cluster", () => {
    expect(() => parsePlatforms([{ id: "mi", layer: "MI", kind: "ecs", region: "us-east-1",
      creds: { mode: "default" }, identifiers: {} }])).toThrow(/cluster/i);
  });
  it("rejects assumeRole without roleArn", () => {
    expect(() => parsePlatforms([{ id: "mi", layer: "MI", kind: "ecs", region: "us-east-1",
      creds: { mode: "assumeRole" }, identifiers: { cluster: "c1" } }])).toThrow(/roleArn/i);
  });
});
