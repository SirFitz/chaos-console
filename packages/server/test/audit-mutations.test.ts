// packages/server/test/audit-mutations.test.ts
//
// Guards the audit contract the user reported as broken ("only stop/start get
// logged"): EVERY non-read action through POST /actions/:action is recorded,
// and the read action net-status is NOT. The route audits on isMutating(action),
// so this pins both sides — a read writes no record, a chaos mutation does — and
// covers a chaos mutation (net-block) in addition to the scaling stop already
// covered in actions.test.ts.
import { describe, it, expect, beforeEach } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { ECSClient, ListTasksCommand, DescribeTasksCommand } from "@aws-sdk/client-ecs";
import {
  EC2Client, DescribeNetworkAclsCommand, CreateNetworkAclEntryCommand, DeleteNetworkAclEntryCommand,
} from "@aws-sdk/client-ec2";
import bcrypt from "bcryptjs";
import { buildServer } from "../src/server.js";
import type { AuditSink } from "../src/audit.js";
import type { AuditRecord } from "@chaos/shared";

const ecs = mockClient(ECSClient);
const ec2 = mockClient(EC2Client);
beforeEach(() => { ecs.reset(); ec2.reset(); });

const users = [{ username: "o", passwordHash: bcrypt.hashSync("pw", 4), role: "operator" as const }];
const platforms: any = [{ id: "mi", layer: "MI", kind: "ecs", region: "us-east-1",
  creds: { mode: "profile", profile: "p" }, identifiers: { cluster: "c1" }, restore: 1 }];

class MemSink implements AuditSink {
  rows: AuditRecord[] = [];
  record(r: any) { const f = { ...r, id: String(this.rows.length + 1), ts: "t" }; this.rows.push(f); return f; }
  query() { return this.rows; }
}
const mk = () => { const audit = new MemSink(); return { app: buildServer({ platforms, users, jwtSecret: "t", catalog: { groups: {}, flows: {} }, audit }), audit }; };
async function cookie(app: any) {
  const r = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "o", password: "pw" } });
  return r.headers["set-cookie"];
}

// Tasks in one subnet guarded by one NACL — enough for net-block to discover a
// target and write a deny entry.
function seedNacls() {
  ecs.on(ListTasksCommand).resolves({ taskArns: ["arn:task1"] });
  ecs.on(DescribeTasksCommand).resolves({ tasks: [
    { attachments: [{ type: "ElasticNetworkInterface", details: [{ name: "subnetId", value: "subnet-a" }] }] },
  ] });
  ec2.on(DescribeNetworkAclsCommand, { Filters: [{ Name: "association.subnet-id", Values: ["subnet-a"] }] })
    .resolves({ NetworkAcls: [{ NetworkAclId: "acl-1" }] });
}

describe("audit contract · POST /api/platforms/:id/actions/:action", () => {
  it("does NOT audit net-status (a read): success, no record, no auditId", async () => {
    const { app, audit } = mk();
    const c = await cookie(app);
    // No running tasks => clusterNacls() returns [] => net-status succeeds with
    // empty entries and makes no EC2 calls.
    ecs.on(ListTasksCommand).resolves({ taskArns: [] });
    const r = await app.inject({ method: "POST", url: "/api/platforms/mi/actions/net-status",
      headers: { cookie: c }, payload: {} });
    expect(r.statusCode).toBe(200);
    expect(r.json().auditId).toBeNull();
    expect(audit.rows).toHaveLength(0);
  });

  it("DOES audit net-block (a chaos mutation): success record with the action + an auditId", async () => {
    const { app, audit } = mk();
    const c = await cookie(app);
    seedNacls();
    ec2.on(DeleteNetworkAclEntryCommand).resolves({});
    ec2.on(CreateNetworkAclEntryCommand).resolves({});
    const r = await app.inject({ method: "POST", url: "/api/platforms/mi/actions/net-block",
      headers: { cookie: c }, payload: { cidr: "203.0.113.10/32", confirm: true } });
    expect(r.statusCode).toBe(200);
    expect(r.json().auditId).toBeTruthy();
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({
      action: "net-block", platform: "mi", user: "o", result: "success", confirm: true, awsIdentity: "profile:p",
    });
  });

  it("audits a FAILED mutation too (net-block with no discoverable NACLs => error record)", async () => {
    const { app, audit } = mk();
    const c = await cookie(app);
    // No running tasks => no NACLs => the engine throws => the route records an error.
    ecs.on(ListTasksCommand).resolves({ taskArns: [] });
    const r = await app.inject({ method: "POST", url: "/api/platforms/mi/actions/net-block",
      headers: { cookie: c }, payload: { cidr: "203.0.113.10/32", confirm: true } });
    expect(r.statusCode).toBe(502);
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({ action: "net-block", result: "error" });
    expect(audit.rows[0].error).toBeTruthy();
  });
});
