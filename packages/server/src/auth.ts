// packages/server/src/auth.ts
import type { FastifyReply, FastifyRequest } from "fastify";
import jwt from "jsonwebtoken";
import type { Role, User } from "@chaos/shared";

export interface Session { username: string; role: Role; }
export const signSession = (s: Session, secret: string) => jwt.sign(s, secret, { expiresIn: "8h" });
export const verifySession = (t: string, secret: string): Session => jwt.verify(t, secret) as Session;

export function authPlugin(secret: string) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const token = (req.cookies as Record<string, string> | undefined)?.chaos;
    if (!token) return reply.code(401).send({ ok: false, error: { code: "UNAUTH", message: "login required" }, auditId: null });
    try { req.session = verifySession(token, secret); }
    catch { return reply.code(401).send({ ok: false, error: { code: "UNAUTH", message: "invalid session" }, auditId: null }); }
  };
}
export function requireRole(role: Role) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const s = req.session;
    if (!s || (role === "operator" && s.role !== "operator"))
      return reply.code(403).send({ ok: false, error: { code: "FORBIDDEN", message: "operator role required" }, auditId: null });
  };
}
export const findUser = (users: User[], username: string) => users.find((u) => u.username === username);
