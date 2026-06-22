// packages/server/src/fastify.d.ts
// Module augmentation: type the request session set by authPlugin and the
// engine/catalog/requireRole handles stashed on the app for later tasks (M2+).
import type { Engine } from "@chaos/engine";
import type { Role } from "@chaos/shared";
import type { Session } from "./auth.js";
import type { Catalog } from "./server.js";

declare module "fastify" {
  interface FastifyRequest {
    session?: Session;
  }
  interface FastifyInstance {
    __engine?: Engine;
    __catalog?: Catalog;
    __requireRole?: (
      role: Role,
    ) => (
      req: import("fastify").FastifyRequest,
      reply: import("fastify").FastifyReply,
    ) => Promise<unknown>;
  }
}
