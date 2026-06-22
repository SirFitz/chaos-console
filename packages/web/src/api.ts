import type {
  ActionName,
  ActionOutcome,
  ActionRequest,
  AuditRecord,
  CapabilityStatus,
  IngressStatus,
  Kind,
  PlatformChaos,
  Role,
  ServiceStatus,
} from "@chaos/shared";

/** Platform summary as returned by GET /api/platforms (no secrets). */
export interface PlatformSummary {
  id: string;
  layer: "API" | "MI" | "RULES";
  kind: "eks_ssm" | "ecs";
  region: string;
  cluster?: string;
  managerInstance?: string;
  namespace?: string;
}

export interface SessionUser {
  username: string;
  role: Role;
}

/**
 * Per-platform chaos state for the Active chaos view. The server summarizes each
 * platform's net-status into plain-language `items` (raw kept for Details).
 */
export type ChaosActive = PlatformChaos;

/**
 * Backend health for one platform, from GET /api/platforms/:id/health (a read
 * over net-preflight). For non-EKS platforms `applicable` is false and the
 * pumba/ingress probes are absent — the chip only renders for EKS.
 */
export interface BackendHealthSummary {
  platform: string;
  kind: Kind;
  applicable: boolean;
  pumba?: CapabilityStatus;
  ingress?: IngressStatus;
}

export interface AuditQuery {
  platform?: string;
  user?: string;
  limit?: number;
}

/** Typed error thrown for any non-success response. */
export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
  }
}

type Envelope<T> =
  | { ok: true; data: T; auditId?: string | null }
  | { ok: false; error: { code: string; message: string }; auditId?: string | null };

function isEnvelope<T>(b: unknown): b is Envelope<T> {
  return typeof b === "object" && b !== null && "ok" in b;
}

async function request<T>(path: string, init?: RequestInit): Promise<{ data: T; auditId: string | null }> {
  const res = await fetch(path, {
    credentials: "include",
    ...init,
    headers:
      init?.body !== undefined
        ? { "Content-Type": "application/json", ...(init?.headers ?? {}) }
        : init?.headers,
  });
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = undefined;
  }
  if (isEnvelope<T>(body)) {
    if (body.ok) return { data: body.data, auditId: body.auditId ?? null };
    throw new ApiError(body.error.code, body.error.message, res.status);
  }
  // Non-envelope (proxy error, HTML, empty) → synthesize from the status.
  throw new ApiError(`HTTP_${res.status}`, res.statusText || `request failed (${res.status})`, res.status);
}

const jsonBody = (b: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(b) });

export async function login(username: string, password: string): Promise<SessionUser> {
  return (await request<SessionUser>("/api/auth/login", jsonBody({ username, password }))).data;
}
export async function logout(): Promise<void> {
  await request<{ loggedOut: boolean }>("/api/auth/logout", { method: "POST" });
}
export async function me(): Promise<SessionUser> {
  return (await request<SessionUser>("/api/auth/me")).data;
}
export async function listPlatforms(): Promise<PlatformSummary[]> {
  return (await request<PlatformSummary[]>("/api/platforms")).data;
}
export async function services(id: string): Promise<ServiceStatus[]> {
  return (await request<ServiceStatus[]>(`/api/platforms/${encodeURIComponent(id)}/services`)).data;
}
export async function act(
  id: string,
  action: ActionName,
  body: ActionRequest,
): Promise<{ outcome: ActionOutcome; auditId: string | null }> {
  const r = await request<ActionOutcome>(
    `/api/platforms/${encodeURIComponent(id)}/actions/${encodeURIComponent(action)}`,
    jsonBody(body),
  );
  return { outcome: r.data, auditId: r.auditId };
}
export async function chaosActive(): Promise<ChaosActive[]> {
  return (await request<ChaosActive[]>("/api/chaos/active")).data;
}
export async function health(id: string): Promise<BackendHealthSummary> {
  return (await request<BackendHealthSummary>(`/api/platforms/${encodeURIComponent(id)}/health`)).data;
}
export async function audit(query: AuditQuery = {}): Promise<AuditRecord[]> {
  const qs = new URLSearchParams();
  if (query.platform) qs.set("platform", query.platform);
  if (query.user) qs.set("user", query.user);
  if (query.limit !== undefined) qs.set("limit", String(query.limit));
  const suffix = qs.toString();
  return (await request<AuditRecord[]>(`/api/audit${suffix ? `?${suffix}` : ""}`)).data;
}
