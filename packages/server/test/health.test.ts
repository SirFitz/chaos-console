// packages/server/test/health.test.ts
import { describe, it, expect } from "vitest";
import { buildServer } from "../src/server.js";

const deps = { platforms: [] as any, users: [] as any, jwtSecret: "t", catalog: { groups: {}, flows: {} } };

describe("GET /healthz", () => {
  it("returns 200 and {status:'ok'} without any auth cookie", async () => {
    const app = buildServer(deps);
    const r = await app.inject({ method: "GET", url: "/healthz" });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ status: "ok" });
  });

  it("is exempt from the auth hook even when other api routes 401", async () => {
    const app = buildServer(deps);
    const guarded = await app.inject({ method: "GET", url: "/api/platforms" });
    expect(guarded.statusCode).toBe(401); // proves the auth hook is active
    const health = await app.inject({ method: "GET", url: "/healthz" });
    expect(health.statusCode).toBe(200);
  });
});
