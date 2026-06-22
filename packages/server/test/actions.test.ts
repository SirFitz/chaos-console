// packages/server/test/actions.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { ECSClient, UpdateServiceCommand } from "@aws-sdk/client-ecs";
import bcrypt from "bcryptjs";
import { buildServer } from "../src/server.js";
import type { AuditSink } from "../src/audit.js";
import type { AuditRecord } from "@chaos/shared";

const ecs = mockClient(ECSClient); beforeEach(() => ecs.reset());
const users = [ { username: "v", passwordHash: bcrypt.hashSync("pw", 4), role: "viewer" as const },
  { username: "o", passwordHash: bcrypt.hashSync("pw", 4), role: "operator" as const } ];
const platforms: any = [{ id: "mi", layer: "MI", kind: "ecs", region: "us-east-1", creds: { mode: "profile", profile: "p" }, identifiers: { cluster: "c1" }, restore: 1 }];
class MemSink implements AuditSink { rows: AuditRecord[] = [];
  record(r: any) { const f = { ...r, id: String(this.rows.length + 1), ts: "t" }; this.rows.push(f); return f; }
  query() { return this.rows; } }
const mk = () => { const audit = new MemSink(); return { app: buildServer({ platforms, users, jwtSecret: "t", catalog: { groups: {}, flows: {} }, audit }), audit }; };
async function cookie(app: any, who: string) { const r = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: who, password: "pw" } }); return r.headers["set-cookie"]; }

describe("POST /api/platforms/:id/actions/:action", () => {
  it("viewer is forbidden", async () => { const { app } = mk(); const c = await cookie(app, "v");
    const r = await app.inject({ method: "POST", url: "/api/platforms/mi/actions/stop", headers: { cookie: c }, payload: { service: "svc", confirm: true } });
    expect(r.statusCode).toBe(403); });
  it("operator stop without confirm => 400 CONFIRM_REQUIRED", async () => { const { app } = mk(); const c = await cookie(app, "o");
    const r = await app.inject({ method: "POST", url: "/api/platforms/mi/actions/stop", headers: { cookie: c }, payload: { service: "svc" } });
    expect(r.statusCode).toBe(400); expect(r.json().error.code).toBe("CONFIRM_REQUIRED"); });
  it("operator stop with confirm succeeds + audits", async () => { const { app, audit } = mk(); const c = await cookie(app, "o");
    ecs.on(UpdateServiceCommand).resolves({ service: { desiredCount: 0 } });
    const r = await app.inject({ method: "POST", url: "/api/platforms/mi/actions/stop", headers: { cookie: c }, payload: { service: "svc", confirm: true } });
    expect(r.statusCode).toBe(200); expect(r.json().auditId).toBeTruthy();
    expect(audit.rows[0]).toMatchObject({ action: "stop", target: "svc", result: "success", confirm: true, awsIdentity: "profile:p" }); });
  it("dry-run bypasses confirm and makes no AWS calls", async () => { const { app } = mk(); const c = await cookie(app, "o");
    const r = await app.inject({ method: "POST", url: "/api/platforms/mi/actions/stop", headers: { cookie: c }, payload: { service: "svc", dryRun: true } });
    expect(r.statusCode).toBe(200); expect(r.json().data.dryRun).toBe(true); expect(ecs.calls()).toHaveLength(0); });
});
