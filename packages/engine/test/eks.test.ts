// packages/engine/test/eks.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { SSMClient, SendCommandCommand, GetCommandInvocationCommand } from "@aws-sdk/client-ssm";
import { eksStatus } from "../src/handlers/eks.js";

const ssm = mockClient(SSMClient);
beforeEach(() => ssm.reset());
const platform: any = { id: "api", layer: "API", kind: "eks_ssm", region: "us-east-1",
  creds: { mode: "default" }, identifiers: { managerInstance: "i-1", namespace: "ns1" } };

describe("eksStatus", () => {
  it("sends kubectl get deployments and returns parsed names", async () => {
    ssm.on(SendCommandCommand).resolves({ Command: { CommandId: "cmd-1" } });
    ssm.on(GetCommandInvocationCommand).resolves({ Status: "Success",
      StandardOutputContent: "NAME    READY\nservice-connect 2/2\nservice-wapi 2/2\n", StandardErrorContent: "" });
    const r = await eksStatus(platform, () => undefined as any, undefined);
    const cmd = ssm.commandCalls(SendCommandCommand)[0].args[0].input as any;
    expect(cmd.Parameters.commands[0]).toContain("kubectl get deployments -n ns1");
    expect(r.map((s) => s.name)).toEqual(["service-connect", "service-wapi"]);
  });

  it("parses the READY column into running/desired counts", async () => {
    ssm.on(SendCommandCommand).resolves({ Command: { CommandId: "cmd-1" } });
    ssm.on(GetCommandInvocationCommand).resolves({ Status: "Success",
      StandardOutputContent: "NAME           READY   UP-TO-DATE   AVAILABLE   AGE\nservice-connect   2/2     2            2           5d\nservice-wapi      0/3     0            0           5d\n", StandardErrorContent: "" });
    const r = await eksStatus(platform, () => undefined as any, undefined);
    expect(r[0]).toMatchObject({ name: "service-connect", running: 2, desired: 2 });
    expect(r[1]).toMatchObject({ name: "service-wapi", running: 0, desired: 3 });
  });

  it("retries past SSM eventual-consistency (InvocationDoesNotExist) then returns output", async () => {
    ssm.on(SendCommandCommand).resolves({ Command: { CommandId: "cmd-1" } });
    ssm.on(GetCommandInvocationCommand)
      .rejectsOnce(Object.assign(new Error("Invocation does not exist."), { name: "InvocationDoesNotExist" }))
      .resolves({ Status: "Success", StandardOutputContent: "NAME    READY\nservice-connect 2/2\n", StandardErrorContent: "" });
    const r = await eksStatus(platform, () => undefined as any, undefined);
    expect(r.map((s) => s.name)).toEqual(["service-connect"]);
  });

  it("tolerates a missing/odd READY column without throwing", async () => {
    ssm.on(SendCommandCommand).resolves({ Command: { CommandId: "cmd-1" } });
    ssm.on(GetCommandInvocationCommand).resolves({ Status: "Success",
      StandardOutputContent: "NAME\nservice-connect\n", StandardErrorContent: "" });
    const r = await eksStatus(platform, () => undefined as any, undefined);
    expect(r[0]).toMatchObject({ name: "service-connect" });
    expect(r[0].running).toBeUndefined();
    expect(r[0].desired).toBeUndefined();
  });
});
