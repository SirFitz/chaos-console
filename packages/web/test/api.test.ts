import { describe, it, expect, vi, beforeEach } from "vitest";
import * as api from "../src/api.js";
import { ApiError } from "../src/api.js";

function mockFetch(status: number, body: unknown) {
  const fn = vi.fn().mockResolvedValue({
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  } as unknown as Response);
  globalThis.fetch = fn as unknown as typeof fetch;
  return fn;
}

beforeEach(() => vi.restoreAllMocks());

describe("api client", () => {
  it("login posts credentials and returns unwrapped data", async () => {
    const f = mockFetch(200, { ok: true, data: { username: "o", role: "operator" }, auditId: null });
    const out = await api.login("o", "pw");
    expect(out).toEqual({ username: "o", role: "operator" });
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/auth/login");
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("include");
    expect(JSON.parse(init.body as string)).toEqual({ username: "o", password: "pw" });
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
  });

  it("throws a typed ApiError on a failure envelope (carrying code + status)", async () => {
    mockFetch(401, { ok: false, error: { code: "UNAUTH", message: "invalid credentials" }, auditId: null });
    await expect(api.login("o", "bad")).rejects.toBeInstanceOf(ApiError);
    try {
      await api.login("o", "bad");
    } catch (e) {
      const err = e as ApiError;
      expect(err.code).toBe("UNAUTH");
      expect(err.message).toBe("invalid credentials");
      expect(err.status).toBe(401);
    }
  });

  it("throws ApiError with an HTTP fallback code when the body is not an envelope", async () => {
    mockFetch(500, "Internal Server Error");
    await expect(api.me()).rejects.toMatchObject({ code: "HTTP_500", status: 500 });
  });

  it("me() GETs /api/auth/me with credentials", async () => {
    const f = mockFetch(200, { ok: true, data: { username: "v", role: "viewer" }, auditId: null });
    const out = await api.me();
    expect(out).toEqual({ username: "v", role: "viewer" });
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/auth/me");
    expect(init.method ?? "GET").toBe("GET");
  });

  it("logout POSTs /api/auth/logout", async () => {
    const f = mockFetch(200, { ok: true, data: { loggedOut: true }, auditId: null });
    await api.logout();
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/auth/logout");
    expect(init.method).toBe("POST");
  });

  it("listPlatforms GETs /api/platforms", async () => {
    const f = mockFetch(200, { ok: true, data: [{ id: "api", layer: "API", kind: "eks_ssm", region: "us-east-1" }], auditId: null });
    const out = await api.listPlatforms();
    expect(out[0].id).toBe("api");
    expect((f.mock.calls[0] as [string])[0]).toBe("/api/platforms");
  });

  it("services(id) GETs the platform services", async () => {
    const f = mockFetch(200, { ok: true, data: [{ platformId: "mi", layer: "MI", name: "svc", mapped: true }], auditId: null });
    const out = await api.services("mi");
    expect(out[0].name).toBe("svc");
    expect((f.mock.calls[0] as [string])[0]).toBe("/api/platforms/mi/services");
  });

  it("act(id,action,body) POSTs the action with the body and returns {outcome,auditId}", async () => {
    const f = mockFetch(200, {
      ok: true,
      data: { action: "stop", target: "svc", dryRun: false, result: { ok: 1 } },
      auditId: "a1",
    });
    const out = await api.act("mi", "stop", { service: "svc", confirm: true });
    expect(out.outcome.action).toBe("stop");
    expect(out.auditId).toBe("a1");
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/platforms/mi/actions/stop");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ service: "svc", confirm: true });
  });

  it("act surfaces CONFIRM_REQUIRED as an ApiError", async () => {
    mockFetch(400, { ok: false, error: { code: "CONFIRM_REQUIRED", message: "needs confirm" }, auditId: null });
    await expect(api.act("mi", "stop", { service: "svc" })).rejects.toMatchObject({ code: "CONFIRM_REQUIRED", status: 400 });
  });

  it("chaosActive GETs /api/chaos/active", async () => {
    const f = mockFetch(200, { ok: true, data: [{ platform: "api", active: false, items: [], raw: null }], auditId: null });
    const out = await api.chaosActive();
    expect(out[0].platform).toBe("api");
    expect((f.mock.calls[0] as [string])[0]).toBe("/api/chaos/active");
  });

  it("health(id) GETs the platform health endpoint and unwraps the summary", async () => {
    const f = mockFetch(200, {
      ok: true,
      data: { platform: "api", kind: "eks_ssm", applicable: true, pumba: { ready: true, state: "ready", detail: "ok" }, ingress: { present: true, healthy: true, detail: "ok" } },
      auditId: null,
    });
    const out = await api.health("api");
    expect(out.applicable).toBe(true);
    expect(out.pumba?.state).toBe("ready");
    expect((f.mock.calls[0] as [string])[0]).toBe("/api/platforms/api/health");
  });

  it("audit(query) builds the querystring from set filters only", async () => {
    const f = mockFetch(200, { ok: true, data: [], auditId: null });
    await api.audit({ platform: "mi", limit: 50 });
    const [url] = f.mock.calls[0] as [string];
    expect(url).toBe("/api/audit?platform=mi&limit=50");
  });

  it("audit() with no filters hits the bare path", async () => {
    const f = mockFetch(200, { ok: true, data: [], auditId: null });
    await api.audit();
    expect((f.mock.calls[0] as [string])[0]).toBe("/api/audit");
  });
});
