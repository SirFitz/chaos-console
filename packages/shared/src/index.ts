export const LAYERS = ["API", "MI", "RULES"] as const;
export type Layer = (typeof LAYERS)[number];
export type Kind = "eks_ssm" | "ecs";
export type CredMode = "assumeRole" | "profile" | "default";

export interface CredConfig { mode: CredMode; roleArn?: string; profile?: string; externalId?: string; }
export interface EcsIdentifiers { cluster: string; }
export interface EksIdentifiers {
  managerInstance: string; namespace: string; asg?: string; asgRestoreCap?: number;
  /**
   * Path to the kubeconfig on the manager box. Optional — the engine ALWAYS runs
   * each kubectl over SSM with `export HOME=/root; export KUBECONFIG=<this>` so
   * both kubectl and the `aws eks get-token` exec plugin resolve their config.
   * SSM Run Command runs as root in a bare shell ($HOME unset), so without this a
   * plain kubectl can't find ~/.kube/config and falls back to localhost:8080.
   * Defaults to "/root/.kube/config" when omitted; set this only to override.
   */
  kubeconfig?: string;
}
export interface PlatformConfig {
  id: string; layer: Layer; kind: Kind; region: string; creds: CredConfig;
  identifiers: EcsIdentifiers | EksIdentifiers; restore?: number;
  chaosBackend?: "chaos-mesh" | "pumba"; chaosLabel?: string; naclRule?: number;
  /** Pumba images — override to point at your registry mirror (e.g. JFrog) when ghcr.io is blocked. */
  chaosImage?: string; chaosNetToolsImage?: string;
  /** Image for the L7 path-cut 503 sink (must be nginx-compatible; override for a registry mirror). Default nginx:alpine. */
  chaosSinkImage?: string;
}
export interface ServiceStatus {
  platformId: string; layer: Layer; name: string;
  desired?: number; running?: number; pending?: number; state?: string;
  group?: string; flow?: string; mapped: boolean; raw?: unknown;
}
export type ApiOk<T> = { ok: true; data: T; auditId: string | null };
export type ApiErr = { ok: false; error: { code: string; message: string }; auditId: string | null };
export type ApiEnvelope<T> = ApiOk<T> | ApiErr;
export const ok = <T>(data: T, auditId: string | null = null): ApiOk<T> => ({ ok: true, data, auditId });
export const fail = (code: string, message: string, auditId: string | null = null): ApiErr => ({ ok: false, error: { code, message }, auditId });

export type Role = "viewer" | "operator";
export interface User { username: string; passwordHash: string; role: Role; }
export interface AuditRecord {
  id: string; ts: string; user: string; role: Role; platform: string; action: string;
  target: string | null; params: Record<string, unknown>; dryRun: boolean; confirm: boolean;
  result: "success" | "error"; error?: string; awsIdentity?: string;
}

export const ACTIONS = [
  "status","stop","start","restart","stop-all","start-all",
  "net-loss","net-delay","net-partition","net-clear","net-status","net-block","net-verify",
  "net-path-cut","net-path-degrade","net-path-clear","net-preflight",
  "net-probe-start","net-probe-tail","net-probe-stop",
] as const;
export type ActionName = (typeof ACTIONS)[number];
export const DESTRUCTIVE: ActionName[] = ["stop","restart","stop-all","net-loss","net-delay","net-partition","net-block","net-path-cut","net-path-degrade"];
export const isDestructive = (a: string) => (DESTRUCTIVE as string[]).includes(a);
// Read-only actions observe state without changing it; everything else mutates.
// Reads must NOT be audited (the audit log records who changed what, not who looked).
// net-verify spins up a short-lived probe pod but only *measures* the in-flight
// chaos (it changes nothing about the system under test), so it is a read.
// The net-probe-* trio is the near-live streaming variant of net-verify: a
// continuous ping pod (start), a log tail (tail), and its teardown (stop). They
// only measure the in-flight chaos — they change nothing about the system under
// test — so they are reads too and must NOT be audited.
export const READ_ONLY: ActionName[] = ["status","net-status","net-verify","net-preflight","net-probe-start","net-probe-tail","net-probe-stop"];
export const isReadOnly = (a: string) => (READ_ONLY as string[]).includes(a);
// A mutation is any action that is not a read (incl. net-clear, which is a state change).
export const isMutating = (a: string) => !isReadOnly(a);
export interface ActionRequest {
  service?: string; count?: number; dryRun?: boolean; confirm?: boolean;
  loss?: number; delay?: string; cidr?: string;
  backend?: "chaos-mesh" | "pumba"; duration?: string; direction?: "to" | "from" | "both";
  /** L7 path chaos (EKS ingress-nginx): target host + path. net-path-degrade reuses `loss` as the percentage of requests on the path to fail. */
  host?: string; path?: string;
  /** net-probe-tail only: how many trailing seconds of probe logs to read (kubectl logs --since). Defaults to ~6s. */
  sinceSeconds?: number;
  /**
   * Prior desired count for a scale, sent purely for the audit trail so a
   * start/stop reads as "scaled svc 2 -> 3" instead of a bare start/stop.
   * The engine ignores it; only the audit record + AuditView consume it.
   */
  from?: number;
}
export interface ActionOutcome {
  action: ActionName; target: string | null; dryRun: boolean;
  plan?: { awsCall: string; params: Record<string, unknown> };
  result?: Record<string, unknown>;
}

/**
 * Result of running one free-text command on a platform's manager box over SSM
 * (the in-app terminal). `exit` is the command's own exit code (SSM ResponseCode);
 * `status` is SSM's invocation status ("Success" | "Failed" | …). A non-zero exit
 * is a normal terminal outcome, not an engine error — both streams are returned.
 */
export interface ExecResult {
  command: string;
  stdout: string;
  stderr: string;
  exit: number | null;
  status: string;
}

/**
 * One injected network fault, parsed from a platform's net-status into plain
 * language so the UI is dumb. `raw` keeps the unparsed result for the Details
 * disclosure (DESIGN.md: sentence first, raw behind a fold).
 */
export interface ChaosItem {
  /** Affected service, when known (EKS rows carry it; ECS NACL blocks may not). */
  service?: string;
  /** One-sentence plain-language summary, e.g. "payments · network fault injected (Pumba), active 113m". */
  summary: string;
  /** "Pumba" | "Chaos Mesh" | "Subnet ACL": the mechanism, for a small backend tag. */
  backend?: string;
}
/** Per-platform chaos state for the Active chaos view (server-summarized). */
export interface PlatformChaos {
  platform: string;
  /**
   * The platform's kind, so the UI can gate empirical verification: only EKS
   * (eks_ssm) supports the net-verify probe; ECS chaos is NACL-based and its
   * evidence is the rule presence, not a live measurement.
   */
  kind?: Kind;
  /** True when at least one fault is live on this platform. */
  active: boolean;
  /** Plain-language items (empty when not active). */
  items: ChaosItem[];
  /** The unparsed net-status result, kept for the Details disclosure. */
  raw: unknown;
  /** Set instead of the above when this platform's probe failed (isolated). */
  error?: string;
}

/**
 * Addressable error taxonomy: every engine failure maps to one of these so the
 * UI (and audit) can show a human sentence + a concrete remediation instead of a
 * raw kubectl/SSM dump. See @chaos/engine `classifyKubectlError`.
 */
export type ChaosErrorCode =
  | "RBAC_FORBIDDEN" | "NOT_FOUND" | "IMAGE_UNREACHABLE" | "PRIVILEGED_BLOCKED"
  | "NO_INGRESS" | "NO_RUNNING_PODS" | "MANAGER_UNREACHABLE" | "NGINX_ABSENT"
  | "OVERLAY_FAILED" | "KUBECONFIG_MISSING" | "UNKNOWN";

/** Readiness of the on-demand Pumba pod (image pullable + privileged permitted). */
export interface CapabilityStatus {
  ready: boolean;
  state: "ready" | "image-unreachable" | "privileged-blocked" | "manager-unreachable" | "unknown";
  detail: string;
  remediation?: string;
}
/** Health of the ingress-nginx layer that L7 path chaos rides on. */
export interface IngressStatus {
  present: boolean;
  healthy: boolean;
  controller?: string;
  detail: string;
  remediation?: string;
}
/** Per-platform backend health, surfaced as a chip in the UI (from net-preflight). */
export interface BackendHealth {
  platform: string;
  pumba: CapabilityStatus;
  ingress: IngressStatus;
}
/** A discovered ingress path that routes to a service (auto-discovery — nothing hand-named). */
export interface PathTarget {
  service: string;
  host: string;
  path: string;
  pathType: string;
  ingress: string;
  ingressNamespace: string;
  /** The primary ingress's class, so the canary overlay attaches to the same controller. */
  ingressClassName?: string;
  /** The backend service port the rule routes to (needed when degrade re-targets the real service). */
  port?: number | string;
}

