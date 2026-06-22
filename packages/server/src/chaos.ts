// packages/server/src/chaos.ts
//
// Turn a platform's raw net-status result into plain-language chaos items
// (DESIGN.md / Active chaos: "a plain sentence first, raw behind Details").
// This runs server-side so the web client stays dumb; the unparsed result is
// preserved as `raw` for the disclosure.
import type { Kind, ChaosItem } from "@chaos/shared";

/** ECS net-status result shape: subnet-ACL deny entries at a rule number. */
interface EcsNetStatus {
  rule?: number;
  nacls?: string[];
  entries?: Array<{ nacl?: string; cidr?: string; egress?: boolean; action?: string; protocol?: string }>;
}
/** EKS net-status result shape: the raw `kubectl get ...` table text. */
interface EksNetStatus {
  output?: string;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** Join a list of CIDRs into prose: "a", "a and b", "a, b and c". */
function listCidrs(cidrs: string[]): string {
  const u = [...new Set(cidrs)];
  if (u.length === 0) return "traffic";
  if (u.length === 1) return u[0];
  if (u.length === 2) return `${u[0]} and ${u[1]}`;
  return `${u.slice(0, -1).join(", ")} and ${u[u.length - 1]}`;
}

/** Summarize an ECS net-status (NACL deny entries) into plain language. */
function summarizeEcs(result: unknown): ChaosItem[] {
  if (!isObj(result)) return [];
  const r = result as EcsNetStatus;
  const entries = Array.isArray(r.entries) ? r.entries : [];
  if (entries.length === 0) return []; // empty entries => no active chaos
  // Group blocked CIDRs by the NACL they sit on, so one line per subnet ACL.
  const byNacl = new Map<string, Set<string>>();
  for (const e of entries) {
    const nacl = e.nacl ?? (r.nacls && r.nacls[0]) ?? "unknown ACL";
    const set = byNacl.get(nacl) ?? new Set<string>();
    if (e.cidr) set.add(e.cidr);
    byNacl.set(nacl, set);
  }
  return [...byNacl.entries()].map(([nacl, cidrs]) => ({
    summary: `Blocking ${listCidrs([...cidrs])} on subnet ACL ${nacl}`,
    backend: "Subnet ACL",
  }));
}

const SVC_RE = /^chaos-(nc|pumba)-(.+)$/;
const ACTION_TOKENS = new Set(["loss", "delay", "partition", "corrupt", "duplicate", "bandwidth"]);
// Pod phases that mean the fault is no longer running.
const DONE_PHASES = new Set(["Completed", "Succeeded", "Failed", "Error", "Terminating", "Terminated", "Unknown"]);

/**
 * Parse a `kubectl get networkchaos|pods` table into chaos items. Robust to
 * column drift across Chaos Mesh / kubectl versions: we key off the resource
 * name prefix (chaos-nc-* = Chaos Mesh CR, chaos-pumba-* = Pumba pod), read the
 * AGE as the last token, and pick out an action/STATUS token from the middle.
 */
function summarizeEks(result: unknown): ChaosItem[] {
  if (!isObj(result)) return [];
  const out = (result as EksNetStatus).output;
  if (typeof out !== "string") return [];
  // net-status appends any L7 path overlays after a marker; parse both halves.
  const [l4Text, pathText = ""] = out.split("---CHAOS-PATHS---");
  return [...parseEksL4(l4Text), ...parseEksPaths(pathText)];
}

function parseEksL4(out: string): ChaosItem[] {
  const lines = out.split("\n").map((l) => l.trim()).filter(Boolean);
  const items: ChaosItem[] = [];
  for (const line of lines) {
    // Skip header / "No resources found" noise.
    if (/^NAME(\s|$)/i.test(line) || /no resources found/i.test(line)) continue;
    const cols = line.split(/\s+/);
    const name = cols[0];
    const m = SVC_RE.exec(name);
    if (!m) continue;
    const isPumba = m[1] === "pumba";
    const svc = m[2];
    const backend = isPumba ? "Pumba" : "Chaos Mesh";
    const age = cols.length > 1 ? cols[cols.length - 1] : undefined;

    if (isPumba) {
      // Pod row: NAME READY STATUS RESTARTS AGE. Active = a non-terminal phase.
      const status = cols[2];
      if (status && DONE_PHASES.has(status)) continue;
      items.push({ service: svc, backend, summary: sentence(svc, backend, undefined, age) });
    } else {
      // NetworkChaos CR row: an action token (loss/delay/...) may appear mid-row.
      const action = cols.slice(1, -1).find((c) => ACTION_TOKENS.has(c.toLowerCase()));
      items.push({ service: svc, backend, summary: sentence(svc, backend, action, age) });
    }
  }
  return items;
}

// L7 path overlays: `kubectl get ingress -l chaos-overlay=path` rows named chaos-path-<svc>-<hash>.
const PATH_RE = /^chaos-path-(.+)-[a-z0-9]{1,6}$/;
function parseEksPaths(out: string): ChaosItem[] {
  const items: ChaosItem[] = [];
  const seen = new Set<string>();
  for (const line of out.split("\n").map((l) => l.trim()).filter(Boolean)) {
    if (/^NAME(\s|$)/i.test(line) || /no resources found/i.test(line)) continue;
    const cols = line.split(/\s+/);
    const m = PATH_RE.exec(cols[0]);
    if (!m || seen.has(m[1])) continue;
    seen.add(m[1]);
    const age = cols.length > 1 ? cols[cols.length - 1] : undefined;
    items.push({ service: m[1], backend: "ingress-nginx",
      summary: `${m[1]} · path fault injected (ingress-nginx)${age ? `, active ${age}` : ""}` });
  }
  return items;
}

/**
 * Build the per-service sentence, folding in the fault type + age when known.
 * Uses the middle-dot separator (the console's convention) — no em dashes in UI
 * copy (DESIGN.md ban).
 */
function sentence(svc: string, backend: string, action: string | undefined, age: string | undefined): string {
  const kindWord = action ? `${describeAction(action)} ` : "network fault ";
  const aged = age ? `, active ${age}` : "";
  return `${svc} · ${kindWord}injected (${backend})${aged}`;
}

function describeAction(action: string): string {
  switch (action.toLowerCase()) {
    case "loss": return "packet loss";
    case "delay": return "latency";
    case "partition": return "partition";
    case "corrupt": return "corruption";
    case "duplicate": return "duplication";
    case "bandwidth": return "bandwidth limit";
    default: return action;
  }
}

/**
 * Summarize a platform's net-status result into plain-language chaos items.
 * Returns [] when there is no active chaos. The caller keeps `raw` separately.
 */
export function summarizeNetStatus(kind: Kind, result: unknown): ChaosItem[] {
  return kind === "ecs" ? summarizeEcs(result) : summarizeEks(result);
}
