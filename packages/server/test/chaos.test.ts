// packages/server/test/chaos.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { SSMClient, SendCommandCommand, GetCommandInvocationCommand } from "@aws-sdk/client-ssm";
import { ECSClient, ListTasksCommand } from "@aws-sdk/client-ecs";
import { EC2Client } from "@aws-sdk/client-ec2";
import bcrypt from "bcryptjs";
import { buildServer } from "../src/server.js";
import type { AuditSink } from "../src/audit.js";
import type { AuditRecord } from "@chaos/shared";

const ssm = mockClient(SSMClient);
const ecs = mockClient(ECSClient);
const ec2 = mockClient(EC2Client);
beforeEach(() => { ssm.reset(); ecs.reset(); ec2.reset(); });

const users = [
  { username: "v", passwordHash: bcrypt.hashSync("pw", 4), role: "viewer" as const },
  { username: "o", passwordHash: bcrypt.hashSync("pw", 4), role: "operator" as const },
];
const platforms: any = [
  { id: "api", layer: "API", kind: "eks_ssm", region: "us-east-1", creds: { mode: "profile", profile: "p" }, identifiers: { managerInstance: "i-1", namespace: "ns1" }, restore: 2 },
  { id: "mi", layer: "MI", kind: "ecs", region: "us-east-1", creds: { mode: "profile", profile: "p" }, identifiers: { cluster: "c1" }, restore: 1 },
];
class MemSink implements AuditSink {
  rows: AuditRecord[] = [];
  record(r: any) { const f = { ...r, id: String(this.rows.length + 1), ts: "t" }; this.rows.push(f); return f; }
  query() { return this.rows; }
}
const mk = () => { const audit = new MemSink(); return { app: buildServer({ platforms, users, jwtSecret: "t", catalog: { groups: {}, flows: {} }, audit }), audit }; };
async function cookie(app: any, who: string) {
  const r = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: who, password: "pw" } });
  return r.headers["set-cookie"];
}

describe("net-* via the action route", () => {
  it("net-loss without confirm => 400 CONFIRM_REQUIRED", async () => {
    const { app } = mk(); const c = await cookie(app, "o");
    const r = await app.inject({ method: "POST", url: "/api/platforms/api/actions/net-loss", headers: { cookie: c }, payload: { service: "dep" } });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe("CONFIRM_REQUIRED");
  });
  it("net-block without confirm => 400 CONFIRM_REQUIRED", async () => {
    const { app } = mk(); const c = await cookie(app, "o");
    const r = await app.inject({ method: "POST", url: "/api/platforms/mi/actions/net-block", headers: { cookie: c }, payload: { cidr: "203.0.113.10/32" } });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe("CONFIRM_REQUIRED");
  });
  it("net-clear does not require confirm", async () => {
    const { app } = mk(); const c = await cookie(app, "o");
    ssm.on(SendCommandCommand).resolves({ Command: { CommandId: "c" } });
    ssm.on(GetCommandInvocationCommand).resolves({ Status: "Success", StandardOutputContent: "", StandardErrorContent: "" });
    const r = await app.inject({ method: "POST", url: "/api/platforms/api/actions/net-clear", headers: { cookie: c }, payload: { service: "dep" } });
    expect(r.statusCode).toBe(200);
  });
  it("net-loss with confirm succeeds and is audited", async () => {
    const { app, audit } = mk(); const c = await cookie(app, "o");
    ssm.on(SendCommandCommand).resolves({ Command: { CommandId: "c" } });
    ssm.on(GetCommandInvocationCommand).resolves({ Status: "Success", StandardOutputContent: "ok", StandardErrorContent: "" });
    const r = await app.inject({ method: "POST", url: "/api/platforms/api/actions/net-loss", headers: { cookie: c }, payload: { service: "dep", confirm: true } });
    expect(r.statusCode).toBe(200);
    expect(audit.rows[0]).toMatchObject({ action: "net-loss", target: "dep", result: "success", confirm: true });
  });
  it("viewer cannot run net-status", async () => {
    const { app } = mk(); const c = await cookie(app, "v");
    const r = await app.inject({ method: "POST", url: "/api/platforms/api/actions/net-status", headers: { cookie: c }, payload: {} });
    expect(r.statusCode).toBe(403);
  });
  it("net-verify is operator-gated (viewer forbidden) and needs no confirm", async () => {
    const { app } = mk();
    const v = await cookie(app, "v");
    const forbidden = await app.inject({ method: "POST", url: "/api/platforms/api/actions/net-verify", headers: { cookie: v }, payload: { service: "dep" } });
    expect(forbidden.statusCode).toBe(403);
    // operator: no CONFIRM_REQUIRED (it is a read/measurement, not destructive)
    ssm.on(SendCommandCommand).resolves({ Command: { CommandId: "c" } });
    ssm.on(GetCommandInvocationCommand).resolves({ Status: "Success",
      StandardOutputContent: "TARGET_IP=10.0.0.5\n20 packets transmitted, 11 packets received, 45% packet loss\nround-trip min/avg/max = 1/205/640 ms", StandardErrorContent: "" });
    const o = await cookie(app, "o");
    const r = await app.inject({ method: "POST", url: "/api/platforms/api/actions/net-verify", headers: { cookie: o }, payload: { service: "dep" } });
    expect(r.statusCode).toBe(200);
    expect(r.json().data.result).toMatchObject({ lossPercent: 45, rttMs: 205, target: "10.0.0.5", sampled: 20 });
  });
  it("net-verify on an ecs platform is rejected (eks-only)", async () => {
    const { app } = mk(); const c = await cookie(app, "o");
    const r = await app.inject({ method: "POST", url: "/api/platforms/mi/actions/net-verify", headers: { cookie: c }, payload: { service: "svc" } });
    expect(r.statusCode).toBe(502);
    expect(r.json().error.message).toMatch(/eks-only|not supported.*ecs/i);
  });
});

describe("audit policy: reads are not audited, mutations are", () => {
  const okSsm = () => {
    ssm.on(SendCommandCommand).resolves({ Command: { CommandId: "c" } });
    ssm.on(GetCommandInvocationCommand).resolves({ Status: "Success", StandardOutputContent: "", StandardErrorContent: "" });
  };

  it("net-status via the action route is NOT audited and returns auditId:null", async () => {
    const { app, audit } = mk(); const c = await cookie(app, "o");
    okSsm();
    const r = await app.inject({ method: "POST", url: "/api/platforms/api/actions/net-status", headers: { cookie: c }, payload: {} });
    expect(r.statusCode).toBe(200);
    expect(r.json().auditId).toBeNull();
    expect(audit.rows).toHaveLength(0);
  });

  it("net-verify via the action route is NOT audited and returns auditId:null (it only measures)", async () => {
    const { app, audit } = mk(); const c = await cookie(app, "o");
    ssm.on(SendCommandCommand).resolves({ Command: { CommandId: "c" } });
    ssm.on(GetCommandInvocationCommand).resolves({ Status: "Success",
      StandardOutputContent: "TARGET_IP=10.0.0.5\n20 packets transmitted, 20 packets received, 0% packet loss\nround-trip min/avg/max = 1/2/3 ms", StandardErrorContent: "" });
    const r = await app.inject({ method: "POST", url: "/api/platforms/api/actions/net-verify", headers: { cookie: c }, payload: { service: "dep" } });
    expect(r.statusCode).toBe(200);
    expect(r.json().auditId).toBeNull();
    expect(audit.rows).toHaveLength(0);
  });

  it("status (a read) is NOT audited", async () => {
    const { app, audit } = mk(); const c = await cookie(app, "o");
    ecs.on(ListTasksCommand).resolves({ taskArns: [] }); // status path is harmless here
    await app.inject({ method: "POST", url: "/api/platforms/mi/actions/status", headers: { cookie: c }, payload: { service: "svc" } });
    expect(audit.rows.filter((x) => x.action === "status")).toHaveLength(0);
  });

  it("net-clear IS audited (clear is a state change)", async () => {
    const { app, audit } = mk(); const c = await cookie(app, "o");
    okSsm();
    const r = await app.inject({ method: "POST", url: "/api/platforms/api/actions/net-clear", headers: { cookie: c }, payload: { service: "dep" } });
    expect(r.statusCode).toBe(200);
    expect(r.json().auditId).toBeTruthy();
    expect(audit.rows.some((x) => x.action === "net-clear" && x.result === "success")).toBe(true);
  });

  it("the GET /api/chaos/active aggregator records no audit rows (pure reads)", async () => {
    const { app, audit } = mk(); const c = await cookie(app, "o");
    okSsm();
    ecs.on(ListTasksCommand).resolves({ taskArns: [] });
    await app.inject({ method: "GET", url: "/api/chaos/active", headers: { cookie: c } });
    expect(audit.rows).toHaveLength(0);
  });
});

describe("GET /api/chaos/active", () => {
  it("aggregates net-status across platforms, summarizing items + keeping raw, tolerating per-platform errors", async () => {
    const { app } = mk(); const c = await cookie(app, "o");
    // api (eks) net-status → kubectl get networkchaos returns one active row
    ssm.on(SendCommandCommand).resolves({ Command: { CommandId: "c" } });
    ssm.on(GetCommandInvocationCommand).resolves({ Status: "Success", StandardOutputContent: "NAME        ACTION   AGE\nchaos-nc-dep   loss   5s", StandardErrorContent: "" });
    // mi (ecs) net-status → make NACL discovery throw to prove fault isolation
    ecs.on(ListTasksCommand).rejects(new Error("AccessDenied"));
    const r = await app.inject({ method: "GET", url: "/api/chaos/active", headers: { cookie: c } });
    expect(r.statusCode).toBe(200);
    const data = r.json().data as Array<{ platform: string; kind?: string; active: boolean; items: Array<{ summary: string }>; raw: unknown; error?: string }>;
    const api = data.find((d) => d.platform === "api")!;
    const mi = data.find((d) => d.platform === "mi")!;
    // kind is surfaced so the UI can gate the EKS-only verify probe.
    expect(api.kind).toBe("eks_ssm");
    expect(mi.kind).toBe("ecs");
    expect(api.error).toBeUndefined();
    expect(api.active).toBe(true);
    expect(api.items[0].summary).toBe("dep · packet loss injected (Chaos Mesh), active 5s");
    expect((api.raw as { output: string }).output).toContain("chaos-nc-dep"); // raw preserved for Details
    expect(mi.error).toMatch(/AccessDenied/);
    expect(mi.active).toBe(false);
  });
  it("requires an authenticated session", async () => {
    const { app } = mk();
    const r = await app.inject({ method: "GET", url: "/api/chaos/active" });
    expect(r.statusCode).toBe(401);
  });
});
