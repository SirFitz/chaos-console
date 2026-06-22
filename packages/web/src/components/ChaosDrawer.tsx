// packages/web/src/components/ChaosDrawer.tsx
import React, { useMemo, useState } from "react";
import type { ActionName, ActionOutcome, ActionRequest, Kind, Role, ServiceStatus } from "@chaos/shared";
import * as api from "../api.js";
import { ApiError } from "../api.js";
import { actionsForKind, needsConfirm } from "../lib/actions.js";
import { isOperator } from "../auth.js";
import { ConfirmModal } from "./ConfirmModal.js";
import { PlanView } from "./PlanView.js";
import { ServiceStatusPill } from "./StatusPill.js";
import { ReplicaMeter } from "./ReplicaMeter.js";
import { Button } from "./ui.js";
import { Field, TextInput, Select, Checkbox } from "./form.js";

// Throttle (packet-shaping) injects carry direction + optional duration.
const INJECT = new Set<ActionName>(["net-loss", "net-delay", "net-partition"]);
// L7 path-fault actions (ingress-nginx) carry an optional host + path; degrade
// additionally carries a fail-percentage (reuses `loss`). They share the host/path block.
const PATH = new Set<ActionName>(["net-path-cut", "net-path-degrade"]);
const isNet = (a: ActionName): boolean => a.startsWith("net-");

// Human labels for the action picker (no raw "net-loss" in the UI).
const LABEL: Record<ActionName, string> = {
  status: "Status",
  start: "Start / scale",
  stop: "Stop",
  restart: "Restart",
  "stop-all": "Stop all",
  "start-all": "Start all",
  "net-loss": "Packet loss",
  "net-delay": "Latency / delay",
  "net-partition": "Partition",
  "net-block": "Blackhole CIDR",
  "net-clear": "Clear network chaos",
  "net-status": "Network status",
  // Not a drawer-selectable action: the Active chaos view runs net-verify
  // directly. Labeled here only to keep this exhaustive map total.
  "net-verify": "Verify packet chaos",
  // L7 (ingress-nginx) path chaos — EKS only. See lib/actions.ts.
  "net-path-cut": "Cut path",
  "net-path-degrade": "Degrade path",
  "net-path-clear": "Clear path chaos",
  // A read that backs the backend-health chip; never drawer-selectable (like
  // net-verify). Labeled here only to keep this exhaustive map total.
  "net-preflight": "Backend preflight",
  // The near-live streaming probe (started/tailed/stopped by the service detail
  // chart, not the drawer). Reads only. Labeled here to keep this map total.
  "net-probe-start": "Start network stream",
  "net-probe-tail": "Tail network stream",
  "net-probe-stop": "Stop network stream",
};

// One line of plain language under the picker: what the selected action does, so
// an operator never has to guess. Empty string = no help line for that action.
const HELP: Partial<Record<ActionName, string>> = {
  start: "Set the service's desired replica count.",
  stop: "Scale the service to zero replicas.",
  restart: "Roll the service's tasks / pods without changing the count.",
  "stop-all": "Scale the whole platform down to zero.",
  "start-all": "Restore the whole platform to its configured capacity.",
  "net-loss": "Drop a percentage of the service's packets.",
  "net-delay": "Add latency to the service's traffic.",
  "net-partition": "Isolate the service: drop ~all traffic in the chosen direction (full cut-off).",
  "net-block": "Deny traffic to/from a CIDR at the subnet NACL.",
  "net-clear": "Remove active network chaos for this service.",
  "net-path-cut": "Return 503 for this ingress path (additive canary overlay; reversible).",
  "net-path-degrade": "Fail a percentage of requests on this ingress path (partial outage; reversible).",
  "net-path-clear": "Remove the path overlay and restore normal routing.",
};

export function ChaosDrawer({
  service,
  kind,
  role,
  mode,
  onClose,
  onDone,
}: {
  service: ServiceStatus;
  kind: Kind;
  role: Role;
  /** "network" = packet-chaos only; "actions" = the full action menu. */
  mode: "actions" | "network";
  onClose: () => void;
  onDone: () => void;
}): React.ReactElement {
  const actions = useMemo(() => {
    const all = actionsForKind(kind);
    return mode === "network" ? all.filter(isNet) : all;
  }, [kind, mode]);

  // Default to a non-destructive action so opening the drawer is inert. In
  // network mode that's "Clear" (net-status is no longer a selectable action —
  // status discovery lives in the live Active Chaos panel).
  const initial =
    mode === "network" ? (actions.find((a) => a === "net-clear") ?? actions[0]) : actions[0];
  const [action, setAction] = useState<ActionName>(initial);
  const [count, setCount] = useState("");
  const [loss, setLoss] = useState("100");
  const [delay, setDelay] = useState("200ms");
  const [duration, setDuration] = useState("");
  const [direction, setDirection] = useState<"to" | "from" | "both">("to");
  const [cidr, setCidr] = useState("");
  const [host, setHost] = useState("");
  const [path, setPath] = useState("");
  const [degradePct, setDegradePct] = useState("50");
  const [dryRun, setDryRun] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ outcome: ActionOutcome; auditId: string | null } | null>(null);

  const heading = mode === "network" ? `Network · ${service.name}` : service.name;
  const selectLabel = mode === "network" ? "Network chaos" : "Action";

  function buildRequest(): ActionRequest {
    const req: ActionRequest = { service: service.name, dryRun };
    if (action === "start" && count.trim()) req.count = Number(count);
    if (action === "net-loss") req.loss = Number(loss);
    if (action === "net-delay") req.delay = delay;
    if (INJECT.has(action)) {
      req.direction = direction;
      if (duration.trim()) req.duration = duration;
    }
    if (action === "net-block") req.cidr = cidr;
    if (PATH.has(action)) {
      // Empty host/path = "all paths for this service" — only send when set.
      if (path.trim()) req.path = path.trim();
      if (host.trim()) req.host = host.trim();
      if (action === "net-path-degrade" && degradePct.trim()) req.loss = Number(degradePct);
    }
    if (needsConfirm(action) && !dryRun) req.confirm = true;
    return req;
  }

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const out = await api.act(service.platformId, action, buildRequest());
      setResult(out);
      setConfirmOpen(false);
      onDone();
    } catch (e) {
      setError(e instanceof ApiError ? `${e.code}: ${e.message}` : "action failed");
      setConfirmOpen(false);
    } finally {
      setBusy(false);
    }
  }

  function onRun() {
    if (needsConfirm(action) && !dryRun) setConfirmOpen(true);
    else void submit();
  }

  const destructive = needsConfirm(action) && !dryRun;

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <button
        type="button"
        aria-label="Close panel"
        className="absolute inset-0 bg-ink/30 animate-fade-in"
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={heading}
        className="scroll-quiet relative flex h-full w-[440px] max-w-[92vw] flex-col overflow-y-auto border-l border-border bg-panel shadow-2xl animate-drawer-in"
      >
        {/* Header */}
        <div className="sticky top-0 z-10 flex items-start justify-between gap-3 border-b border-border bg-panel px-5 py-4">
          <div className="min-w-0">
            <h2 className="truncate text-base font-semibold text-ink">{heading}</h2>
            <p className="tnum mt-0.5 truncate font-mono text-xs text-ink-faint">
              {service.platformId} · {kind}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="-mr-1 -mt-1 grid h-7 w-7 shrink-0 place-items-center rounded-md text-ink-faint hover:bg-rail hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M3 3l10 10M13 3L3 13" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        {!isOperator(role) ? (
          <div className="px-5 py-6">
            <p className="rounded-md border border-border bg-rail/60 px-3 py-2.5 text-sm text-ink-soft">
              Read-only. Viewers cannot run {mode === "network" ? "network chaos" : "actions"}.
            </p>
            <div className="mt-4">
              <Button variant="secondary" onClick={onClose}>
                Close
              </Button>
            </div>
          </div>
        ) : (
          <>
            <div className="px-5 py-4">
              {/* Current state */}
              <div className="mb-4 flex items-center gap-3 rounded-md border border-border bg-rail/50 px-3 py-2.5">
                <ServiceStatusPill s={service} />
                <ReplicaMeter s={service} />
              </div>

              <Field label={selectLabel} htmlFor="chaos-action">
                <Select
                  id="chaos-action"
                  value={action}
                  onChange={(e) => {
                    setAction(e.target.value as ActionName);
                    setResult(null);
                    setError(null);
                  }}
                >
                  {actions.map((a) => (
                    <option key={a} value={a}>
                      {LABEL[a]}
                    </option>
                  ))}
                </Select>
              </Field>

              {/* Plain-language explanation of the selected action. */}
              {HELP[action] && (
                <p className="-mt-1.5 mb-3.5 text-xs leading-relaxed text-ink-soft">{HELP[action]}</p>
              )}

              {action === "start" && (
                <Field label="Replicas / desired count" htmlFor="chaos-count" hint="Leave blank for the platform default.">
                  <TextInput
                    id="chaos-count"
                    inputMode="numeric"
                    value={count}
                    onChange={(e) => setCount(e.target.value)}
                    placeholder="default"
                  />
                </Field>
              )}

              {action === "net-loss" && (
                <Field label="Loss %" htmlFor="chaos-loss">
                  <div className="flex items-center gap-3">
                    <input
                      aria-label="Packet drop slider"
                      type="range"
                      min="0"
                      max="100"
                      value={loss}
                      onChange={(e) => setLoss(e.target.value)}
                      className="h-1.5 flex-1 cursor-pointer appearance-none rounded-full bg-border-strong accent-[var(--chaos)]"
                    />
                    <TextInput
                      id="chaos-loss"
                      inputMode="numeric"
                      value={loss}
                      onChange={(e) => setLoss(e.target.value)}
                      className="w-16 text-center"
                    />
                  </div>
                </Field>
              )}

              {action === "net-delay" && (
                <Field label="Delay" htmlFor="chaos-delay" hint="e.g. 200ms, 1s">
                  <TextInput id="chaos-delay" value={delay} onChange={(e) => setDelay(e.target.value)} />
                </Field>
              )}

              {INJECT.has(action) && (
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Direction" htmlFor="chaos-direction">
                    <Select
                      id="chaos-direction"
                      value={direction}
                      onChange={(e) => setDirection(e.target.value as "to" | "from" | "both")}
                    >
                      <option value="to">to</option>
                      <option value="from">from</option>
                      <option value="both">both</option>
                    </Select>
                  </Field>
                  <Field label="Duration" htmlFor="chaos-duration" hint="optional, e.g. 5m">
                    <TextInput
                      id="chaos-duration"
                      value={duration}
                      onChange={(e) => setDuration(e.target.value)}
                      placeholder="none"
                    />
                  </Field>
                </div>
              )}

              {action === "net-block" && (
                <Field label="CIDR to blackhole" htmlFor="chaos-cidr" hint="e.g. 203.0.113.10/32">
                  <TextInput id="chaos-cidr" value={cidr} onChange={(e) => setCidr(e.target.value)} />
                </Field>
              )}

              {PATH.has(action) && (
                <>
                  <Field
                    label="Path"
                    htmlFor="chaos-path"
                    hint="Dry-run first to preview exactly which host/path will be hit."
                  >
                    <TextInput
                      id="chaos-path"
                      value={path}
                      onChange={(e) => setPath(e.target.value)}
                      placeholder="/charge — leave blank for all paths"
                    />
                  </Field>
                  <Field label="Host" htmlFor="chaos-host" hint="optional — restrict to one ingress host">
                    <TextInput
                      id="chaos-host"
                      value={host}
                      onChange={(e) => setHost(e.target.value)}
                      placeholder="any host"
                    />
                  </Field>
                  {action === "net-path-degrade" && (
                    <Field label="Percent of requests to fail" htmlFor="chaos-degrade-pct" hint="Send this % of the path's requests to a 503 sink (partial outage).">
                      <TextInput
                        id="chaos-degrade-pct"
                        inputMode="numeric"
                        value={degradePct}
                        onChange={(e) => setDegradePct(e.target.value)}
                        className="w-24"
                      />
                    </Field>
                  )}
                </>
              )}

              <div className="mt-1 flex items-center justify-between rounded-md border border-border bg-rail/40 px-3 py-2">
                <Checkbox
                  label="Dry-run (preview only)"
                  checked={dryRun}
                  onChange={(e) => setDryRun(e.target.checked)}
                />
                {destructive && (
                  <span className="text-xs font-medium text-bad">requires confirm</span>
                )}
              </div>

              {error && (
                <p
                  className="mt-3 rounded-md border border-bad/40 bg-bad-soft px-3 py-2 text-xs text-bad"
                  role="alert"
                >
                  {error}
                </p>
              )}

              {result && (
                <div className="mt-4">
                  <PlanView outcome={result.outcome} auditId={result.auditId} />
                </div>
              )}
            </div>

            {/* Footer actions */}
            <div className="sticky bottom-0 mt-auto flex gap-2 border-t border-border bg-panel px-5 py-3">
              <Button variant={destructive ? "danger" : "primary"} busy={busy} onClick={onRun}>
                Run
              </Button>
              <Button variant="ghost" onClick={onClose} disabled={busy}>
                Close
              </Button>
            </div>
          </>
        )}

        {confirmOpen && (
          <ConfirmModal
            title={`Confirm ${LABEL[action]}`}
            message={`Run ${LABEL[action].toLowerCase()} on "${service.name}" (${service.platformId})? This is a destructive action and will be audited.`}
            busy={busy}
            confirmLabel={`Run ${LABEL[action].toLowerCase()}`}
            onConfirm={() => void submit()}
            onCancel={() => setConfirmOpen(false)}
          />
        )}
      </div>
    </div>
  );
}
