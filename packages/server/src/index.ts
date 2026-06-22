// packages/server/src/index.ts
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parsePlatforms } from "@chaos/engine";
import { buildServer } from "./server.js";
import { SqliteAuditSink } from "./audit.js";

const dir = process.env.CHAOS_CONFIG_DIR ?? "./config";
// Config is supplied at runtime (mounted at CHAOS_CONFIG_DIR); the image ships generic.
// Tolerate missing files so the container boots before it's configured.
function readJson<T>(file: string, fallback: T): T {
  const p = join(dir, file);
  if (!existsSync(p)) { console.warn(`[chaos] ${file} not found in ${dir} — using empty default`); return fallback; }
  return JSON.parse(readFileSync(p, "utf8")) as T;
}
const platforms = parsePlatforms(readJson("platforms.json", []));
const users = readJson("users.json", []);
const catalog = readJson("catalog.json", { groups: {}, flows: {} });
const audit = new SqliteAuditSink(process.env.CHAOS_AUDIT_DB ?? "./chaos-audit.sqlite");

const __dir = dirname(fileURLToPath(import.meta.url));
// packages/server/dist -> packages/web/dist
const webDist = resolve(__dir, "../../web/dist");
const webRoot = existsSync(webDist) ? webDist : undefined;

// Secure cookie by default; opt out only for an HTTP-only DEV/sandbox demo.
const cookieSecure = process.env.CHAOS_COOKIE_INSECURE !== "true";
const app = buildServer({ platforms, users, jwtSecret: process.env.CHAOS_JWT_SECRET ?? "dev", catalog, audit, webRoot, cookieSecure });
app.listen({ port: Number(process.env.PORT ?? 8080), host: "0.0.0.0" }).then((a) => console.log(`chaos-console on ${a}`));
