// packages/engine/src/errors.ts
import type { ChaosErrorCode } from "@chaos/shared";

export interface ClassifiedError {
  code: ChaosErrorCode;
  message: string;
  remediation?: string;
  /** The original kubectl/SSM text, kept for a Details disclosure in the UI. */
  raw?: string;
}

/**
 * A pre-classified, addressable error thrown by handlers for *semantic* conditions
 * that aren't visible in kubectl stderr (e.g. "no ingress fronts this service").
 * classifyKubectlError passes it straight through.
 */
export class ChaosError extends Error {
  constructor(public code: ChaosErrorCode, message: string, public remediation?: string) {
    super(message);
    this.name = "ChaosError";
  }
}

function text(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Map a raw kubectl/SSM failure to an addressable {code, message, remediation}.
 * Order matters: infrastructure (SSM) and the most *specific* Kubernetes rejections
 * are checked before the generic "forbidden" / "not found" substrings they contain
 * (a PodSecurity denial literally says "is forbidden", so PSA must win over RBAC).
 */
export function classifyKubectlError(err: unknown): ClassifiedError {
  if (err instanceof ChaosError)
    return { code: err.code, message: err.message, remediation: err.remediation, raw: err.message };

  const raw = text(err);
  const s = raw.toLowerCase();
  const at = (...needles: string[]) => needles.some((n) => s.includes(n));

  // kubectl fell back to its localhost:8080 default — SSM delivered the command and
  // it RAN, but kubectl found no usable kubeconfig. Must precede the SSM/manager
  // check below, because the wrapper text ("SSM status Failed: ...") contains "ssm".
  if (at("localhost:8080", "current server api group list"))
    return { code: "KUBECONFIG_MISSING", raw,
      message: "kubectl on the manager box has no usable kubeconfig — it fell back to localhost:8080 (connection refused).",
      remediation: "SSM runs kubectl as root in a bare shell (no $HOME). Ensure the manager's kubeconfig exists and is readable by root (default /root/.kube/config); the engine exports HOME=/root and KUBECONFIG before each kubectl. See the CHAOS_DIAG lines in the output for the path, readability, and a directory listing." };

  if (at("invocationdoesnotexist", "not in a valid state", "ssm", "sendcommand", "instanceid", "no instances"))
    return { code: "MANAGER_UNREACHABLE", raw,
      message: "The chaos manager could not be reached over SSM.",
      remediation: "Confirm the manager instance is running and its SSM agent is online." };

  if (at("imagepullbackoff", "errimagepull", "errimageneverpull", "pull access denied", "manifest unknown", "manifest for", "no such host"))
    return { code: "IMAGE_UNREACHABLE", raw,
      message: "The chaos image could not be pulled by the cluster.",
      remediation: "Mirror the Pumba image to your registry (e.g. JFrog) and set `chaosImage` to that path." };

  if (at("podsecurity", "pod security", "privileged", "psp"))
    return { code: "PRIVILEGED_BLOCKED", raw,
      message: "The privileged chaos pod was rejected by Pod Security Admission.",
      remediation: "Allow privileged on the chaos namespace (label pod-security.kubernetes.io/enforce=privileged) or use a permitted namespace." };

  if (at("ingressclass") && at("not found", "no matches", "no resources"))
    return { code: "NGINX_ABSENT", raw,
      message: "No ingress-nginx controller / IngressClass was found.",
      remediation: "Install ingress-nginx, or use L4 chaos (net-loss/net-delay) which needs no ingress." };

  if (at("forbidden", "cannot get", "cannot list", "cannot create", "cannot delete", "cannot patch", "rbac"))
    return { code: "RBAC_FORBIDDEN", raw,
      message: "The action was denied by Kubernetes RBAC (insufficient permission).",
      remediation: "Grant the manager kubeconfig identity get/list/create/delete/patch on the resource in the target namespace." };

  if (at("notfound", "not found", "doesn't exist", "does not exist"))
    return { code: "NOT_FOUND", raw,
      message: "The target resource was not found.",
      remediation: "Check the service/namespace name and that the resource exists." };

  return { code: "UNKNOWN", raw, message: raw.trim() || "Unknown chaos engine error." };
}
