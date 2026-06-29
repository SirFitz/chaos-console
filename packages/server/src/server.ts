// packages/server/src/server.ts
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import bcrypt from "bcryptjs";
import { Engine, classifyKubectlError } from "@chaos/engine";
import { ok, fail, isDestructive, isMutating, type PlatformConfig, type User, type ActionName, type ActionRequest } from "@chaos/shared";
import { summarizeNetStatus } from "./chaos.js";
import { authPlugin, requireRole, signSession, findUser } from "./auth.js";
import type { AuditSink } from "./audit.js";
import fastifyStatic from "@fastify/static";
import { resolve } from "node:path";

export interface Catalog { groups: Record<string, Record<string, string[]>>; flows: Record<string, unknown>; }
export interface Deps { platforms: PlatformConfig[]; users: User[]; jwtSecret: string; catalog: Catalog; audit: AuditSink; webRoot?: string; cookieSecure?: boolean; }

function safeDescribe(engine: Engine, id: string): string { try { return engine.describeCreds(id); } catch { return "unknown"; } }

export function buildServer(deps: Deps) {
  const app = Fastify({ logger: false });
  const engine = new Engine(deps.platforms);
  app.register(cookie);

  app.post("/api/auth/login", async (req, reply) => {
    const { username, password } = (req.body ?? {}) as { username?: string; password?: string };
    const u = username ? findUser(deps.users, username) : undefined;
    if (!u || !password || !bcrypt.compareSync(password, u.passwordHash))
      return reply.code(401).send(fail("UNAUTH", "invalid credentials"));
    const token = signSession({ username: u.username, role: u.role }, deps.jwtSecret);
    // Secure by default (prod = HTTPS). For an HTTP-only DEV/sandbox demo, set
    // cookieSecure:false (via CHAOS_COOKIE_INSECURE) so the session cookie is sent over http.
    reply.setCookie("chaos", token, { httpOnly: true, sameSite: "strict", secure: deps.cookieSecure ?? true, path: "/" });
    return ok({ username: u.username, role: u.role });
  });
  app.post("/api/auth/logout", async (_req, reply) => { reply.clearCookie("chaos", { path: "/" }); return ok({ loggedOut: true }); });

  // Unauthenticated liveness probe for container HEALTHCHECK + ALB target group.
  app.get("/healthz", async () => ({ status: "ok" }));

  app.register(async (api) => {
    api.addHook("preHandler", authPlugin(deps.jwtSecret));
    api.get("/api/auth/me", async (req) => ok(req.session));
    api.get("/api/platforms", async () => ok(engine.listPlatforms()));
    api.get<{ Params: { id: string }; Querystring: { service?: string } }>(
      "/api/platforms/:id/services", async (req, reply) => {
        try {
          const svcs = await engine.status(req.params.id, req.query.service);
          const { joinCatalog } = await import("./catalog.js");
          return ok(joinCatalog(svcs, deps.catalog));
        } catch (e) {
          const c = classifyKubectlError(e);
          return reply.code(502).send(fail(c.code, c.remediation ? `${c.message} ${c.remediation}` : c.message));
        }
      });
    api.post<{ Params: { id: string; action: string }; Body: ActionRequest }>(
      "/api/platforms/:id/actions/:action",
      { preHandler: requireRole("operator") },
      async (req, reply) => {
        const { id, action } = req.params;
        const body = (req.body ?? {}) as ActionRequest;
        const sess = req.session ?? { username: "unknown", role: "operator" as const };
        if (isDestructive(action) && !body.dryRun && body.confirm !== true)
          return reply.code(400).send(fail("CONFIRM_REQUIRED", `action '${action}' requires confirm:true`));
        // Audit records who *changed* what, never reads (status / net-status).
        // Every mutation is recorded, including net-clear (a state change).
        const audited = isMutating(action);
        const base = { user: sess.username, role: sess.role, platform: id, action, target: body.service ?? null,
          params: { ...body }, dryRun: !!body.dryRun, confirm: !!body.confirm, awsIdentity: safeDescribe(engine, id) };
        try {
          const outcome = await engine.act(id, action as ActionName, body);
          const rec = audited ? deps.audit.record({ ...base, result: "success" }) : null;
          return reply.send(ok(outcome, rec?.id ?? null));
        } catch (e) {
          // Map raw kubectl/SSM failures to an addressable {code, message + remediation}.
          const c = classifyKubectlError(e);
          const msg = c.remediation ? `${c.message} ${c.remediation}` : c.message;
          const rec = audited ? deps.audit.record({ ...base, result: "error", error: msg }) : null;
          return reply.code(502).send(fail(c.code, msg, rec?.id ?? null));
        }
      });
    api.get<{ Querystring: { platform?: string; user?: string; limit?: string } }>(
      "/api/audit", async (req) => ok(deps.audit.query({ platform: req.query.platform, user: req.query.user,
        limit: req.query.limit ? Number(req.query.limit) : undefined })));
    api.get("/api/chaos/active", async () => {
      // net-status is a READ — engine.act runs it directly, unaudited (the action
      // route would also skip audit for it, but we call the engine to avoid the HTTP hop).
      const kinds = new Map(engine.listPlatforms().map((p) => [p.id, p.kind] as const));
      const results = await Promise.all(
        engine.platformIds().map(async (pid) => {
          try {
            const outcome = await engine.act(pid, "net-status", {});
            const raw = outcome.result ?? null;
            const kind = kinds.get(pid) ?? "ecs";
            const items = summarizeNetStatus(kind, raw);
            // `kind` lets the Active chaos view gate the EKS-only net-verify probe.
            return { platform: pid, kind, active: items.length > 0, items, raw };
          } catch (e) {
            return { platform: pid, kind: kinds.get(pid), active: false, items: [], raw: null, error: (e as Error).message };
          }
        }),
      );
      return ok(results);
    });
    // Backend health for an EKS platform (the net-preflight read): can Pumba run here,
    // and is ingress-nginx available? Surfaced as the UI's backend-health chip. ECS has
    // no such backends, so it returns applicable:false. A read — never audited.
    api.get<{ Params: { id: string } }>("/api/platforms/:id/health", async (req, reply) => {
      const id = req.params.id;
      const plat = engine.listPlatforms().find((p) => p.id === id);
      if (!plat) return reply.code(404).send(fail("NOT_FOUND", `unknown platform '${id}'`));
      if (plat.kind !== "eks_ssm") return ok({ platform: id, kind: plat.kind, applicable: false });
      try {
        const outcome = await engine.act(id, "net-preflight", {});
        const r = (outcome.result ?? {}) as { pumba?: unknown; ingress?: unknown };
        return ok({ platform: id, kind: plat.kind, applicable: true, pumba: r.pumba, ingress: r.ingress });
      } catch (e) {
        const c = classifyKubectlError(e);
        return reply.code(502).send(fail(c.code, c.remediation ? `${c.message} ${c.remediation}` : c.message));
      }
    });
    // Free-text command runner on an eks_ssm platform's manager box (the in-app SSM
    // terminal). Operator-only and AUDITED — it runs arbitrary shell as root on the
    // box over the same SSM SendCommand path the engine already uses, so every command
    // + outcome is recorded. The command runs RAW (no env wrapping), so the operator
    // sees the box's true state. A non-zero exit is a normal result, not an error;
    // only infrastructure failures (SSM unreachable, timeout) 502.
    api.post<{ Params: { id: string }; Body: { command?: string } }>(
      "/api/platforms/:id/exec",
      { preHandler: requireRole("operator") },
      async (req, reply) => {
        const { id } = req.params;
        const plat = engine.listPlatforms().find((p) => p.id === id);
        if (!plat) return reply.code(404).send(fail("NOT_FOUND", `unknown platform '${id}'`));
        if (plat.kind !== "eks_ssm")
          return reply.code(400).send(fail("NO_MANAGER", `platform '${id}' has no manager box (terminal is for eks_ssm platforms)`));
        const command = String((req.body as { command?: string } | undefined)?.command ?? "").trim();
        if (!command) return reply.code(400).send(fail("BAD_REQUEST", "command is required"));
        if (command.length > 4000) return reply.code(400).send(fail("BAD_REQUEST", "command too long (max 4000 chars)"));
        const sess = req.session ?? { username: "unknown", role: "operator" as const };
        const base = { user: sess.username, role: sess.role, platform: id, action: "exec", target: null,
          params: { command }, dryRun: false, confirm: false, awsIdentity: safeDescribe(engine, id) };
        try {
          const result = await engine.exec(id, command);
          const rec = deps.audit.record({ ...base, result: "success" });
          return reply.send(ok(result, rec.id));
        } catch (e) {
          const msg = (e as Error).message;
          const rec = deps.audit.record({ ...base, result: "error", error: msg });
          return reply.code(502).send(fail("EXEC_FAILED", msg, rec.id));
        }
      });
    app.__engine = engine; app.__catalog = deps.catalog; app.__requireRole = requireRole;
  });

  const webRoot = deps.webRoot;
  if (webRoot) {
    app.register(fastifyStatic, { root: resolve(webRoot), wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      // Never let the SPA fallback shadow the API or non-GET verbs.
      if (req.method !== "GET" || req.url.startsWith("/api/"))
        return reply.code(404).send(fail("NOT_FOUND", `not found: ${req.method} ${req.url}`));
      return reply.sendFile("index.html");
    });
  } else {
    app.setNotFoundHandler((req, reply) =>
      reply.code(404).send(fail("NOT_FOUND", `not found: ${req.method} ${req.url}`)),
    );
  }

  return app;
}
