// packages/server/test/auth.test.ts
import { describe, it, expect } from "vitest";
import bcrypt from "bcryptjs";
import { buildServer } from "../src/server.js";

const users = [
  { username: "v", passwordHash: bcrypt.hashSync("pw", 4), role: "viewer" as const },
  { username: "o", passwordHash: bcrypt.hashSync("pw", 4), role: "operator" as const },
];
const app = () => buildServer({ platforms: [], users, jwtSecret: "test", catalog: { groups: {}, flows: {} } });

describe("auth", () => {
  it("rejects bad credentials", async () => {
    const r = await app().inject({ method: "POST", url: "/api/auth/login", payload: { username: "v", password: "nope" } });
    expect(r.statusCode).toBe(401);
  });
  it("logs in and returns the user", async () => {
    const r = await app().inject({ method: "POST", url: "/api/auth/login", payload: { username: "v", password: "pw" } });
    expect(r.statusCode).toBe(200);
    expect(r.json().data).toMatchObject({ username: "v", role: "viewer" });
    expect(r.headers["set-cookie"]).toBeTruthy();
  });
  it("blocks unauthenticated reads", async () => {
    const r = await app().inject({ method: "GET", url: "/api/platforms" });
    expect(r.statusCode).toBe(401);
  });
  it("sets a Secure session cookie by default", async () => {
    const r = await app().inject({ method: "POST", url: "/api/auth/login", payload: { username: "v", password: "pw" } });
    expect(String(r.headers["set-cookie"])).toContain("Secure");
  });
  it("omits Secure when cookieSecure is false (HTTP-only demo)", async () => {
    const insecure = buildServer({ platforms: [], users, jwtSecret: "test", catalog: { groups: {}, flows: {} }, cookieSecure: false });
    const r = await insecure.inject({ method: "POST", url: "/api/auth/login", payload: { username: "v", password: "pw" } });
    expect(r.statusCode).toBe(200);
    expect(String(r.headers["set-cookie"])).not.toContain("Secure");
  });
});
