// packages/engine/test/credentials.test.ts
import { describe, it, expect, vi } from "vitest";
import { resolveCredentials } from "../src/credentials.js";

vi.mock("@aws-sdk/credential-providers", () => ({
  fromIni: vi.fn((o) => ({ kind: "ini", o })),
  fromTemporaryCredentials: vi.fn((o) => ({ kind: "temp", o })),
  fromNodeProviderChain: vi.fn(() => ({ kind: "chain" })),
}));

describe("resolveCredentials", () => {
  it("profile -> fromIni with profile name", () => {
    const c: any = resolveCredentials({ mode: "profile", profile: "p1" } as any, "us-east-1");
    expect(c).toMatchObject({ kind: "ini", o: { profile: "p1" } });
  });
  it("default -> node provider chain", () => {
    expect((resolveCredentials({ mode: "default" } as any, "us-east-1") as any).kind).toBe("chain");
  });
  it("assumeRole -> fromTemporaryCredentials with roleArn + externalId", () => {
    const c: any = resolveCredentials({ mode: "assumeRole", roleArn: "arn:r", externalId: "x" } as any, "us-east-1");
    expect(c.kind).toBe("temp");
    expect(c.o.params).toMatchObject({ RoleArn: "arn:r", ExternalId: "x" });
  });
});
