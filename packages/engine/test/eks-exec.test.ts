// packages/engine/test/eks-exec.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { SSMClient, SendCommandCommand, GetCommandInvocationCommand } from "@aws-sdk/client-ssm";
import { execOnManager } from "../src/handlers/eks.js";
import { Engine } from "../src/engine.js";

const ssm = mockClient(SSMClient);
beforeEach(() => ssm.reset());
const p: any = { id: "api", layer: "API", kind: "eks_ssm", region: "us-east-1", creds: { mode: "default" },
  identifiers: { managerInstance: "i-1", namespace: "ns1" } };
const noCreds = () => undefined as any;
const cmd = () => (ssm.commandCalls(SendCommandCommand)[0].args[0].input as { Parameters?: { commands?: string[] } }).Parameters!.commands![0];

describe("execOnManager", () => {
  it("runs the command RAW (no env wrapping) and returns stdout/stderr/exit", async () => {
    ssm.on(SendCommandCommand).resolves({ Command: { CommandId: "c" } });
    ssm.on(GetCommandInvocationCommand).resolves({ Status: "Success", ResponseCode: 0, StandardOutputContent: "HOME=\n", StandardErrorContent: "" });
    const r = await execOnManager(p, noCreds, "echo HOME=$HOME");
    expect(cmd()).toBe("echo HOME=$HOME"); // exactly as typed — the operator sees the bare shell
    expect(r).toEqual({ command: "echo HOME=$HOME", stdout: "HOME=\n", stderr: "", exit: 0, status: "Success" });
  });
  it("does NOT throw on a non-zero exit — that's a normal terminal outcome", async () => {
    ssm.on(SendCommandCommand).resolves({ Command: { CommandId: "c" } });
    ssm.on(GetCommandInvocationCommand).resolves({ Status: "Failed", ResponseCode: 2, StandardOutputContent: "", StandardErrorContent: "ls: /nope: No such file or directory\n" });
    const r = await execOnManager(p, noCreds, "ls /nope");
    expect(r.exit).toBe(2);
    expect(r.status).toBe("Failed");
    expect(r.stderr).toContain("No such file or directory");
  });
  it("throws on an infrastructure failure (no CommandId)", async () => {
    ssm.on(SendCommandCommand).resolves({});
    await expect(execOnManager(p, noCreds, "whoami")).rejects.toThrow(/CommandId/);
  });
});

describe("Engine.exec", () => {
  it("rejects a platform that has no manager box (ecs)", async () => {
    const eng = new Engine([{ id: "mi", layer: "MI", kind: "ecs", region: "us-east-1", creds: { mode: "default" }, identifiers: { cluster: "c" } } as any]);
    await expect(eng.exec("mi", "whoami")).rejects.toThrow(/no manager box/i);
  });
});
