// packages/server/test/exec.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { SSMClient, SendCommandCommand, GetCommandInvocationCommand } from "@aws-sdk/client-ssm";
import bcrypt from "bcryptjs";
import { buildServer } from "../src/server.js";
import type { AuditSink } from "../src/audit.js";
import type { AuditRecord } from "@chaos/shared";

const ssm = mockClient(SSMClient); beforeEach(() => ssm.reset());
const users = [ { username: "v", passwordHash: bcrypt.hashSync("pw", 4), role: "viewer" as const },
  { username: "o", passwordHash: bcrypt.hashSync("pw", 4), role: "operator" as const } ];
const platforms: any = [
  { id: "api", layer: "API", kind: "eks_ssm", region: "us-east-1", creds: { mode: "profile", profile: "p" }, identifiers: { managerInstance: "i-1", namespace: "ns1" } },
  { id: "mi", layer: "MI", kind: "ecs", region: "us-east-1", creds: { mode: "profile", profile: "p" }, identifiers: { cluster: "c1" } },
];
class MemSink implements AuditSink { rows: AuditRecord[] = [];
  record(r: any) { const f = { ...r, id: String(this.rows.length + 1), ts: "t" }; this.rows.push(f); return f; }
  query() { return this.rows; } }
const mk = () => { const audit = new MemSink(); return { app: buildServer({ platforms, users, jwtSecret: "t", catalog: { groups: {}, flows: {} }, audit }), audit }; };
async function cookie(app: any, who: string) { const r = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: who, password: "pw" } }); return r.headers["set-cookie"]; }
const okSsm = (out: string, err = "", code = 0, status = "Success") => {
  ssm.on(SendCommandCommand).resolves({ Command: { CommandId: "c" } });
  ssm.on(GetCommandInvocationCommand).resolves({ Status: status, ResponseCode: code, StandardOutputContent: out, StandardErrorContent: err });
};
const exec = (app: any, c: string, id: string, command: unknown) =>
  app.inject({ method: "POST", url: `/api/platforms/${id}/exec`, headers: { cookie: c }, payload: { command } });

describe("POST /api/platforms/:id/exec", () => {
  it("viewer is forbidden (operator only)", async () => {
    const { app } = mk(); const c = await cookie(app, "v");
    expect((await exec(app, c, "api", "whoami")).statusCode).toBe(403);
  });
  it("unauthenticated is 401", async () => {
    const { app } = mk();
    const r = await app.inject({ method: "POST", url: "/api/platforms/api/exec", payload: { command: "whoami" } });
    expect(r.statusCode).toBe(401);
  });
  it("operator runs a command, gets stdout/exit, and it is audited", async () => {
    const { app, audit } = mk(); const c = await cookie(app, "o");
    okSsm("root\n");
    const r = await exec(app, c, "api", "whoami");
    expect(r.statusCode).toBe(200);
    expect(r.json().data).toMatchObject({ command: "whoami", stdout: "root\n", exit: 0, status: "Success" });
    expect(r.json().auditId).toBeTruthy();
    expect(audit.rows[0]).toMatchObject({ action: "exec", result: "success", user: "o", params: { command: "whoami" } });
    expect((ssm.commandCalls(SendCommandCommand)[0].args[0].input as any).Parameters.commands[0]).toBe("whoami"); // raw
  });
  it("a non-zero exit is still 200 (normal terminal outcome)", async () => {
    const { app } = mk(); const c = await cookie(app, "o");
    okSsm("", "no such file\n", 2, "Failed");
    const r = await exec(app, c, "api", "ls /nope");
    expect(r.statusCode).toBe(200);
    expect(r.json().data).toMatchObject({ exit: 2, status: "Failed", stderr: "no such file\n" });
  });
  it("an empty command is rejected with 400", async () => {
    const { app } = mk(); const c = await cookie(app, "o");
    expect((await exec(app, c, "api", "   ")).statusCode).toBe(400);
  });
  it("an ecs platform has no manager box => 400 NO_MANAGER", async () => {
    const { app } = mk(); const c = await cookie(app, "o");
    const r = await exec(app, c, "mi", "whoami");
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe("NO_MANAGER");
  });
  it("an unknown platform => 404", async () => {
    const { app } = mk(); const c = await cookie(app, "o");
    expect((await exec(app, c, "nope", "whoami")).statusCode).toBe(404);
  });
  it("an SSM/infra failure is audited as an error and 502s", async () => {
    const { app, audit } = mk(); const c = await cookie(app, "o");
    ssm.on(SendCommandCommand).rejects(Object.assign(new Error("InvalidInstanceId"), { name: "InvalidInstanceId" }));
    const r = await exec(app, c, "api", "whoami");
    expect(r.statusCode).toBe(502);
    expect(audit.rows[0]).toMatchObject({ action: "exec", result: "error" });
  });
});
