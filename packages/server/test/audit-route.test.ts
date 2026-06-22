// packages/server/test/audit-route.test.ts
import { describe, it, expect } from "vitest";
import bcrypt from "bcryptjs";
import { buildServer } from "../src/server.js";
import type { AuditSink } from "../src/audit.js";
const users = [{ username: "v", passwordHash: bcrypt.hashSync("pw", 4), role: "viewer" as const }];
class MemSink implements AuditSink { record(r: any){ return { ...r, id: "1", ts: "t" }; } query(){ return [{ id: "1", ts: "t", user: "o", role: "operator", platform: "mi", action: "stop", target: "svc", params: {}, dryRun: false, confirm: true, result: "success" }] as any; } }
describe("GET /api/audit", () => {
  it("returns records for an authenticated session", async () => {
    const app = buildServer({ platforms: [], users, jwtSecret: "t", catalog: { groups: {}, flows: {} }, audit: new MemSink() });
    const lr = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "v", password: "pw" } });
    const r = await app.inject({ method: "GET", url: "/api/audit?platform=mi&limit=5", headers: { cookie: lr.headers["set-cookie"] } });
    expect(r.statusCode).toBe(200); expect(r.json().data[0]).toMatchObject({ action: "stop", result: "success" });
  });
});
