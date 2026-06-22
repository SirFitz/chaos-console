// packages/server/test/static.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import bcrypt from "bcryptjs";
import { buildServer } from "../src/server.js";
import type { AuditSink } from "../src/audit.js";
import type { AuditRecord } from "@chaos/shared";

class MemSink implements AuditSink {
  rows: AuditRecord[] = [];
  record(r: any) { const f = { ...r, id: String(this.rows.length + 1), ts: "t" }; this.rows.push(f); return f; }
  query() { return this.rows; }
}

let dir: string;
const INDEX = "<!doctype html><title>Chaos Console</title><div id=root>SPA-INDEX</div>";

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "chaos-web-"));
  writeFileSync(join(dir, "index.html"), INDEX);
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "assets", "app.js"), "console.log('app')");
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function mk() {
  const users = [{ username: "o", passwordHash: bcrypt.hashSync("pw", 4), role: "operator" as const }];
  return buildServer({
    platforms: [], users, jwtSecret: "t",
    catalog: { groups: {}, flows: {} }, audit: new MemSink(),
    webRoot: dir,
  } as any);
}

describe("static SPA serving", () => {
  it("serves index.html at /", async () => {
    const app = mk();
    const r = await app.inject({ method: "GET", url: "/" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain("SPA-INDEX");
    expect(r.headers["content-type"]).toMatch(/text\/html/);
  });

  it("serves built assets verbatim", async () => {
    const app = mk();
    const r = await app.inject({ method: "GET", url: "/assets/app.js" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain("console.log('app')");
  });

  it("falls back to index.html for a client route (deep link)", async () => {
    const app = mk();
    const r = await app.inject({ method: "GET", url: "/inventory" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain("SPA-INDEX");
  });

  it("does NOT shadow /api/* — unknown api path returns JSON 404, not the SPA", async () => {
    const app = mk();
    const r = await app.inject({ method: "GET", url: "/api/does-not-exist" });
    expect(r.statusCode).toBe(404);
    expect(r.body).not.toContain("SPA-INDEX");
    const body = r.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("still serves the JSON API (login) when a webRoot is configured", async () => {
    const app = mk();
    const r = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "o", password: "pw" } });
    expect(r.statusCode).toBe(200);
    expect(r.json().data).toMatchObject({ username: "o", role: "operator" });
  });

  it("when no webRoot is set, / is a plain JSON 404 (no static plugin)", async () => {
    const app = buildServer({
      platforms: [], users: [], jwtSecret: "t",
      catalog: { groups: {}, flows: {} }, audit: new MemSink(),
    });
    const r = await app.inject({ method: "GET", url: "/" });
    expect(r.statusCode).toBe(404);
    expect(r.json().ok).toBe(false);
  });
});
