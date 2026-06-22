// packages/web/src/lib/health.ts
//
// Reduce a platform's BackendHealthSummary (GET /api/platforms/:id/health, a
// read over net-preflight) into the one chip the Inventory header shows: a
// tone + a short label, with the server's `detail` + `remediation` carried
// through for the hover/expand. The component stays presentational; the
// state -> label/tone mapping (DESIGN.md semantic tokens, color-for-state-only)
// lives here so it is unit-testable in isolation, like lib/status.ts.
import type { BackendHealthSummary } from "../api.js";
import type { Tone } from "./status.js";

export interface BackendHealthChip {
  tone: Tone;
  /** Short chip word, e.g. "Backends ready", "Privileged blocked". */
  label: string;
  /** The server's plain-language detail sentence (always present). */
  detail: string;
  /** A concrete fix, when the server offered one. */
  remediation?: string;
}

/**
 * Map a backend-health summary to a chip. Pumba problems outrank an ingress
 * problem (a manager we can't reach can't host either backend), and the
 * everything-ready case is the only `ok`; anything else is a problem tone so the
 * operator notices before they try to inject chaos.
 *
 * Returns null when there is nothing to show (non-EKS / not applicable / no
 * probe data) — the chip simply does not render for those platforms.
 */
export function deriveBackendHealth(summary: BackendHealthSummary): BackendHealthChip | null {
  if (!summary.applicable) return null;
  const { pumba, ingress } = summary;
  if (!pumba && !ingress) return null;

  // Pumba (the on-demand chaos pod) first: its failure modes are the loud ones.
  if (pumba && pumba.state !== "ready") {
    const label =
      pumba.state === "image-unreachable"
        ? "Chaos image not mirrored"
        : pumba.state === "privileged-blocked"
          ? "Privileged blocked"
          : pumba.state === "manager-unreachable"
            ? "Manager unreachable"
            : "Backends unavailable"; // "unknown"
    return { tone: "bad", label, detail: pumba.detail, remediation: pumba.remediation };
  }

  // Pumba is ready (or absent): the ingress layer that L7 path chaos rides on.
  if (ingress && (!ingress.present || !ingress.healthy)) {
    return {
      tone: "chaos",
      label: "Ingress unavailable",
      detail: ingress.detail,
      remediation: ingress.remediation,
    };
  }

  // Everything we know about is healthy.
  const detail = pumba?.detail ?? ingress?.detail ?? "Backends ready.";
  return { tone: "ok", label: "Backends ready", detail };
}
