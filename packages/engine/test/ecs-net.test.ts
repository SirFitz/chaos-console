// packages/engine/test/ecs-net.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { ECSClient, ListTasksCommand, DescribeTasksCommand } from "@aws-sdk/client-ecs";
import {
  EC2Client, DescribeNetworkAclsCommand, CreateNetworkAclEntryCommand, DeleteNetworkAclEntryCommand,
} from "@aws-sdk/client-ec2";
import { ecsAct } from "../src/handlers/ecs.js";

const ecs = mockClient(ECSClient);
const ec2 = mockClient(EC2Client);
beforeEach(() => { ecs.reset(); ec2.reset(); });
const noCreds = () => undefined as any;
const p: any = { id: "mi", layer: "MI", kind: "ecs", region: "us-east-1", creds: { mode: "default" },
  identifiers: { cluster: "c1" }, restore: 1 };

// Tasks in two subnets, each guarded by one NACL.
const seedNacls = () => {
  ecs.on(ListTasksCommand).resolves({ taskArns: ["arn:task1"] });
  ecs.on(DescribeTasksCommand).resolves({ tasks: [
    { attachments: [{ type: "ElasticNetworkInterface", details: [{ name: "subnetId", value: "subnet-a" }] }] },
    { attachments: [{ type: "ElasticNetworkInterface", details: [{ name: "subnetId", value: "subnet-b" }] }] },
  ] });
  ec2.on(DescribeNetworkAclsCommand, { Filters: [{ Name: "association.subnet-id", Values: ["subnet-a"] }] })
    .resolves({ NetworkAcls: [{ NetworkAclId: "acl-1" }] });
  ec2.on(DescribeNetworkAclsCommand, { Filters: [{ Name: "association.subnet-id", Values: ["subnet-b"] }] })
    .resolves({ NetworkAcls: [{ NetworkAclId: "acl-2" }] });
};

describe("ecsAct net-block", () => {
  it("adds a DENY entry (egress+ingress) on each NACL at rule 1", async () => {
    seedNacls();
    ec2.on(CreateNetworkAclEntryCommand).resolves({});
    ec2.on(DeleteNetworkAclEntryCommand).resolves({});
    const r = await ecsAct(p, noCreds, "net-block", { cidr: "203.0.113.10/32" });
    const creates = ec2.commandCalls(CreateNetworkAclEntryCommand).map((c) => c.args[0].input as any);
    // 2 NACLs × {egress,ingress} = 4 create calls
    expect(creates).toHaveLength(4);
    for (const c of creates) {
      expect(c).toMatchObject({ RuleNumber: 1, Protocol: "-1", RuleAction: "deny", CidrBlock: "203.0.113.10/32" });
    }
    expect(creates.some((c) => c.Egress === true)).toBe(true);
    expect(creates.some((c) => c.Egress === false)).toBe(true);
    expect(new Set(creates.map((c) => c.NetworkAclId))).toEqual(new Set(["acl-1", "acl-2"]));
    // each create is preceded by a delete of the same rule (idempotent replace)
    expect(ec2.commandCalls(DeleteNetworkAclEntryCommand)).toHaveLength(4);
    expect(r).toMatchObject({ action: "net-block", target: "203.0.113.10/32", dryRun: false });
  });
  it("honors a custom naclRule", async () => {
    seedNacls();
    ec2.on(CreateNetworkAclEntryCommand).resolves({});
    ec2.on(DeleteNetworkAclEntryCommand).resolves({});
    await ecsAct({ ...p, naclRule: 90 }, noCreds, "net-block", { cidr: "203.0.113.10/32" });
    for (const c of ec2.commandCalls(CreateNetworkAclEntryCommand)) {
      expect((c.args[0].input as any).RuleNumber).toBe(90);
    }
  });
  it("refuses 0.0.0.0/0", async () => {
    await expect(ecsAct(p, noCreds, "net-block", { cidr: "0.0.0.0/0" })).rejects.toThrow(/0\.0\.0\.0\/0/);
    expect(ec2.calls()).toHaveLength(0);
    expect(ecs.calls()).toHaveLength(0);
  });
  it("requires a cidr", async () => {
    await expect(ecsAct(p, noCreds, "net-block", {})).rejects.toThrow(/requires .*cidr/i);
  });
  it("rejects a malformed cidr", async () => {
    await expect(ecsAct(p, noCreds, "net-block", { cidr: "not-a-cidr" })).rejects.toThrow(/invalid .*cidr/i);
  });
  it("errors when no NACLs are discoverable (no running tasks)", async () => {
    ecs.on(ListTasksCommand).resolves({ taskArns: [] });
    await expect(ecsAct(p, noCreds, "net-block", { cidr: "203.0.113.10/32" })).rejects.toThrow(/no .*NACL|running tasks/i);
  });
  it("dry-run returns a plan and writes nothing", async () => {
    seedNacls();
    const r = await ecsAct(p, noCreds, "net-block", { cidr: "203.0.113.10/32", dryRun: true });
    expect(ec2.commandCalls(CreateNetworkAclEntryCommand)).toHaveLength(0);
    expect(ec2.commandCalls(DeleteNetworkAclEntryCommand)).toHaveLength(0);
    expect(r.dryRun).toBe(true);
    expect(r.plan?.awsCall).toBe("ec2:CreateNetworkAclEntry");
    expect(r.plan?.params).toMatchObject({ rule: 1, cidr: "203.0.113.10/32" });
    expect(r.plan?.params.nacls).toEqual(["acl-1", "acl-2"]);
  });
});

describe("ecsAct net-clear (ecs)", () => {
  it("deletes the DENY entries (egress+ingress) on each NACL", async () => {
    seedNacls();
    ec2.on(DeleteNetworkAclEntryCommand).resolves({});
    const r = await ecsAct(p, noCreds, "net-clear", {});
    const dels = ec2.commandCalls(DeleteNetworkAclEntryCommand).map((c) => c.args[0].input as any);
    expect(dels).toHaveLength(4);
    for (const d of dels) expect(d.RuleNumber).toBe(1);
    expect(r).toMatchObject({ action: "net-clear", dryRun: false });
  });
});

describe("ecsAct net-status (ecs)", () => {
  it("describes the rule entries on each NACL", async () => {
    seedNacls();
    ec2.on(DescribeNetworkAclsCommand, { NetworkAclIds: ["acl-1"] })
      .resolves({ NetworkAcls: [{ Entries: [{ RuleNumber: 1, Egress: true, RuleAction: "deny", CidrBlock: "203.0.113.10/32", Protocol: "-1" }] }] });
    ec2.on(DescribeNetworkAclsCommand, { NetworkAclIds: ["acl-2"] })
      .resolves({ NetworkAcls: [{ Entries: [] }] });
    const r = await ecsAct(p, noCreds, "net-status", {});
    expect(r.action).toBe("net-status");
    const entries = (r.result as any).entries as any[];
    expect(entries.some((e) => e.nacl === "acl-1" && e.cidr === "203.0.113.10/32")).toBe(true);
  });
});
