// packages/engine/src/handlers/eks.ts
import { SSMClient, SendCommandCommand, GetCommandInvocationCommand } from "@aws-sdk/client-ssm";
import { AutoScalingClient, UpdateAutoScalingGroupCommand } from "@aws-sdk/client-auto-scaling";
import type { PlatformConfig, ServiceStatus, EksIdentifiers, ActionName, ActionOutcome, ActionRequest, PathTarget, CapabilityStatus, IngressStatus, ExecResult } from "@chaos/shared";
import type { CredFactory } from "./ecs.js";
import { ChaosError, classifyKubectlError } from "../errors.js";

/**
 * Wrap a kubectl command for execution over SSM Run Command on the manager box.
 *
 * SSM Run Command runs as root but in a bare, non-login shell: $HOME is unset
 * (not /root). So a plain `kubectl` can't resolve ~/.kube/config — and the
 * `aws eks get-token` exec-credential plugin that EKS kubeconfigs use can't find
 * ~/.aws — and kubectl falls back to its localhost:8080 default ("connection
 * refused"). We therefore ALWAYS, before running the command:
 *   1. export HOME=/root (SSM runs as root) and KUBECONFIG (default
 *      /root/.kube/config, overridable via identifiers.kubeconfig), so that both
 *      kubectl and the aws exec plugin resolve their config.
 *   2. on failure, emit a CHAOS_DIAG block to stderr — exit code, HOME,
 *      KUBECONFIG, whether that file is readable, a listing of its directory, and
 *      kubectl/aws tool paths. The manager box isn't directly reachable, so this
 *      is the only way to see ground truth; it surfaces in the addressable error
 *      and the container logs without anyone shelling into the box.
 */
export function buildManagerCommand(eks: EksIdentifiers, kcmd: string): string {
  const kubeconfig = eks.kubeconfig && eks.kubeconfig.trim() ? eks.kubeconfig : "/root/.kube/config";
  const setup = `export HOME=/root; export KUBECONFIG=${kubeconfig};`;
  const diag =
    `rc=$?; ` +
    `{ echo "CHAOS_DIAG rc=$rc HOME=$HOME KUBECONFIG=$KUBECONFIG readable=$([ -r "$KUBECONFIG" ] && echo yes || echo no)"; ` +
    `ls -la "$(dirname "$KUBECONFIG")" 2>&1; ` +
    `for t in kubectl aws; do echo "CHAOS_DIAG $t=$(command -v "$t" 2>/dev/null || echo MISSING)"; done; ` +
    `} 1>&2; exit $rc`;
  return `${setup} { ${kcmd}; } || { ${diag}; }`;
}

export async function runKubectl(p: PlatformConfig, creds: CredFactory, kcmd: string, timeoutMs = 60_000): Promise<string> {
  const eks = p.identifiers as EksIdentifiers;
  const inst = eks.managerInstance;
  const command = buildManagerCommand(eks, kcmd);
  const client = new SSMClient({ region: p.region, credentials: creds(p) });
  const sent = await client.send(new SendCommandCommand({
    InstanceIds: [inst], DocumentName: "AWS-RunShellScript", Comment: "chaos-console",
    Parameters: { commands: [command] } }));
  const id = sent.Command?.CommandId;
  if (!id) throw new Error("SSM SendCommand returned no CommandId");
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let inv;
    try {
      inv = await client.send(new GetCommandInvocationCommand({ CommandId: id, InstanceId: inst }));
    } catch (e) {
      // SSM is eventually consistent: GetCommandInvocation can throw
      // InvocationDoesNotExist for a moment right after SendCommand. Treat that as
      // "not ready yet" and keep polling until the deadline (the command itself is fine).
      if ((e as { name?: string })?.name !== "InvocationDoesNotExist") throw e;
    }
    if (inv?.Status && !["Pending", "InProgress", "Delayed"].includes(inv.Status)) {
      if (inv.Status !== "Success") throw new Error(`SSM status ${inv.Status}: ${inv.StandardErrorContent ?? ""}`);
      return inv.StandardOutputContent ?? "";
    }
    if (Date.now() > deadline) throw new Error("SSM command timed out");
    await new Promise((r) => setTimeout(r, 1500));
  }
}

/**
 * Run a free-text command on the manager box over SSM and return BOTH output
 * streams + the exit code, WITHOUT throwing on a non-zero exit (that's a normal
 * terminal outcome). Powers the in-app SSM terminal. Unlike runKubectl this does
 * NOT wrap the command — it runs exactly what was typed, so the operator sees the
 * box's true bare-shell state ($HOME unset, etc.). Only infrastructure failures
 * (no CommandId, SSM API error, timeout) throw.
 */
export async function execOnManager(p: PlatformConfig, creds: CredFactory, command: string, timeoutMs = 60_000): Promise<ExecResult> {
  const inst = (p.identifiers as EksIdentifiers).managerInstance;
  const client = new SSMClient({ region: p.region, credentials: creds(p) });
  const sent = await client.send(new SendCommandCommand({
    InstanceIds: [inst], DocumentName: "AWS-RunShellScript", Comment: "chaos-console-terminal",
    Parameters: { commands: [command] } }));
  const id = sent.Command?.CommandId;
  if (!id) throw new Error("SSM SendCommand returned no CommandId");
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let inv;
    try {
      inv = await client.send(new GetCommandInvocationCommand({ CommandId: id, InstanceId: inst }));
    } catch (e) {
      if ((e as { name?: string })?.name !== "InvocationDoesNotExist") throw e;
    }
    if (inv?.Status && !["Pending", "InProgress", "Delayed"].includes(inv.Status)) {
      return { command, stdout: inv.StandardOutputContent ?? "", stderr: inv.StandardErrorContent ?? "",
        exit: inv.ResponseCode ?? null, status: inv.Status };
    }
    if (Date.now() > deadline) throw new Error("SSM command timed out");
    await new Promise((r) => setTimeout(r, 1500));
  }
}

// READY column is `running/desired` (e.g. "2/2"); tolerate a missing/odd value.
function parseReady(token: string | undefined): { running?: number; desired?: number } {
  if (!token) return {};
  const m = /^(\d+)\/(\d+)$/.exec(token);
  if (!m) return {};
  return { running: Number(m[1]), desired: Number(m[2]) };
}

export async function eksStatus(p: PlatformConfig, creds: CredFactory, _service?: string): Promise<ServiceStatus[]> {
  const ns = (p.identifiers as EksIdentifiers).namespace;
  const out = await runKubectl(p, creds, `kubectl get deployments -n ${ns}`);
  return out.split("\n").slice(1).map((l) => l.trim()).filter(Boolean)
    .map((l) => {
      const cols = l.split(/\s+/);
      return { platformId: p.id, layer: p.layer, name: cols[0], mapped: false, ...parseReady(cols[1]) };
    });
}

/** Minimal shape of `kubectl get ingress -A -o json` we read for discovery. */
interface IngressList {
  items?: Array<{
    metadata?: { name?: string; namespace?: string };
    spec?: {
      ingressClassName?: string;
      rules?: Array<{
        host?: string;
        http?: { paths?: Array<{
          path?: string; pathType?: string;
          backend?: { service?: { name?: string; port?: { number?: number; name?: string } }; serviceName?: string; servicePort?: number | string };
        }> };
      }>;
    };
  }>;
}

/**
 * Auto-discover the ingress paths that route to a service — the operator names a
 * *service* (as everywhere in the console), never a pod or ingress. Reads the
 * cluster-wide ingress list and matches each rule's backend (networking/v1
 * `backend.service.name` or legacy `backend.serviceName`). Throws an addressable
 * NO_INGRESS when nothing fronts the service (it isn't exposed north-south).
 */
export async function discoverPathTargets(p: PlatformConfig, creds: CredFactory, svc: string): Promise<PathTarget[]> {
  const out = await runKubectl(p, creds, "kubectl get ingress -A -o json");
  let parsed: IngressList;
  try { parsed = JSON.parse(out) as IngressList; }
  catch { throw new ChaosError("UNKNOWN", "could not parse the ingress list from the cluster", "Re-run; if it persists, check the manager's kubectl/kubeconfig."); }
  const targets: PathTarget[] = [];
  for (const ing of parsed.items ?? []) {
    const ingress = ing.metadata?.name ?? "";
    const ingressNamespace = ing.metadata?.namespace ?? "";
    const ingressClassName = ing.spec?.ingressClassName;
    for (const rule of ing.spec?.rules ?? []) {
      const host = rule.host ?? "";
      for (const pth of rule.http?.paths ?? []) {
        const b = pth.backend;
        const backend = b?.service?.name ?? b?.serviceName;
        if (backend === svc) {
          const port = b?.service?.port?.number ?? b?.service?.port?.name ?? b?.servicePort;
          targets.push({ service: svc, host, path: pth.path ?? "/", pathType: pth.pathType ?? "ImplementationSpecific", ingress, ingressNamespace, ingressClassName, port });
        }
      }
    }
  }
  if (targets.length === 0)
    throw new ChaosError("NO_INGRESS", `no ingress routes to service '${svc}'`,
      "This service isn't exposed north-south via ingress, so there's no path to cut. Use net-loss/net-delay for L4 chaos, or add an Ingress for it.");
  return targets;
}

const PATH_ACTIONS = ["net-path-cut", "net-path-degrade", "net-path-clear"] as const;

/** Short, deterministic, DNS-safe suffix from host+path so multiple cut paths on one service don't collide. */
function pathHash(t: PathTarget): string {
  let h = 2166136261 >>> 0;
  const s = `${t.host}|${t.path}`;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h.toString(36).slice(0, 6);
}
const overlayIngressName = (svc: string, t: PathTarget) => `chaos-path-${svc}-${pathHash(t)}`;
const overlaySinkName = (svc: string) => `chaos-sink-${svc}`;
const pathOverlayDeleteCmd = (ns: string, svc: string) =>
  `kubectl delete ingress,service,deployment -n ${ns} -l chaos-overlay=path,chaos-service=${svc} --ignore-not-found`;

/**
 * Build the *additive* overlay for one path. We never edit the real Ingress.
 * Both modes route a canary WEIGHT of the host+path to a 503 "sink" workload
 * (validated live: ingress-nginx ignores a canary whose backend has no endpoints
 * and falls back to production, so the sink must be a real pod that returns 503):
 *  - cut:     weight 100 -> every request on the path gets 503.
 *  - degrade: weight = `loss`% -> that fraction of requests fail (a partial outage).
 * Clearing = deleting these labelled objects (incl. the sink Deployment); the real
 * routing reverts instantly.
 */
function emitPathOverlayDocs(svc: string, ns: string, t: PathTarget, mode: "cut" | "degrade", req: ActionRequest, sinkImage: string): string[] {
  const ingName = overlayIngressName(svc, t);
  const sink = overlaySinkName(svc);
  const labels = `    chaos-overlay: path\n    chaos-service: "${svc}"`;
  const weight = mode === "cut" ? 100 : Math.max(1, Math.min(100, Math.round(req.loss ?? 50)));
  // A tiny nginx that returns 503 for everything — the canary's healthy alt-backend.
  const docs: string[] = [
`apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${sink}
  namespace: ${ns}
  labels:
${labels}
spec:
  replicas: 1
  selector:
    matchLabels:
      chaos.console/sink: "${svc}"
  template:
    metadata:
      labels:
        chaos.console/sink: "${svc}"
    spec:
      containers:
      - name: sink
        image: ${sinkImage}
        command: ["/bin/sh", "-c", "printf 'server{listen 80;location / {return 503;}}' > /etc/nginx/conf.d/default.conf; exec nginx -g 'daemon off;'"]
        ports:
        - { containerPort: 80 }`,
`apiVersion: v1
kind: Service
metadata:
  name: ${sink}
  namespace: ${ns}
  labels:
${labels}
spec:
  selector:
    chaos.console/sink: "${svc}"
  ports:
  - { port: 80, targetPort: 80 }`,
  ];
  const cls = t.ingressClassName ? `  ingressClassName: ${t.ingressClassName}\n` : "";
  docs.push(
`apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: ${ingName}
  namespace: ${ns}
  labels:
${labels}
  annotations:
    nginx.ingress.kubernetes.io/canary: "true"
    nginx.ingress.kubernetes.io/canary-weight: "${weight}"
spec:
${cls}  rules:
  - host: ${t.host}
    http:
      paths:
      - path: ${t.path}
        pathType: ${t.pathType || "ImplementationSpecific"}
        backend:
          service:
            name: ${sink}
            port:
              number: 80`);
  return docs;
}

async function eksPathAct(p: PlatformConfig, creds: CredFactory, action: ActionName, req: ActionRequest): Promise<ActionOutcome> {
  if (p.kind !== "eks_ssm") throw new ChaosError("UNKNOWN", "path chaos is EKS-only");
  const ns = (p.identifiers as EksIdentifiers).namespace;
  const dryRun = !!req.dryRun;
  const svc = req.service;

  if (action === "net-path-clear") {
    if (!svc) throw new ChaosError("NOT_FOUND", "net-path-clear requires a service");
    const kcmd = pathOverlayDeleteCmd(ns, svc);
    if (dryRun) return { action, target: svc, dryRun: true, plan: { awsCall: "ssm:SendCommand", params: { kubectl: kcmd } } };
    const out = await runKubectl(p, creds, kcmd);
    return { action, target: svc, dryRun: false, result: { output: out.trim() } };
  }

  if (!svc) throw new ChaosError("NOT_FOUND", `action '${action}' requires a service`);
  const mode: "cut" | "degrade" = action === "net-path-cut" ? "cut" : "degrade";
  let targets = await discoverPathTargets(p, creds, svc);
  if (req.path) targets = targets.filter((t) => t.path === req.path && (!req.host || t.host === req.host));
  if (targets.length === 0)
    throw new ChaosError("NO_INGRESS", `no ingress path '${req.path ?? "*"}' for service '${svc}'`,
      "Pick a path from the discovered set, or omit it to affect all of the service's paths.");
  // The canary overlay must live in the real ingress's namespace to pair with it.
  const foreign = targets.find((t) => t.ingressNamespace && t.ingressNamespace !== ns);
  if (foreign)
    throw new ChaosError("OVERLAY_FAILED", `ingress for '${svc}' is in namespace '${foreign.ingressNamespace}', not the configured chaos namespace '${ns}'`,
      "Point the platform's namespace at the ingress's namespace, or run path chaos there.");

  const sinkImg = chaosSinkImage(p);
  const manifest = targets.flatMap((t) => emitPathOverlayDocs(svc, ns, t, mode, req, sinkImg)).join("\n---\n") + "\n";
  const objects = targets.map((t) => overlayIngressName(svc, t));
  const paths = targets.map((t) => ({ host: t.host, path: t.path }));
  if (dryRun) return { action, target: svc, dryRun: true, plan: { awsCall: "ssm:SendCommand", params: { mode, objects, paths, manifest } } };

  const b64 = Buffer.from(manifest, "utf8").toString("base64").replace(/\n/g, "");
  // apply, then confirm the overlay ingress actually materialised (else surface OVERLAY_FAILED).
  const out = await runKubectl(p, creds, `echo ${b64} | base64 -d | kubectl apply -f - && kubectl get ingress ${objects[0]} -n ${ns} -o name`);
  if (!/ingress/i.test(out))
    throw new ChaosError("OVERLAY_FAILED", `applied the overlay but ingress '${objects[0]}' did not appear`,
      "Check ingress-nginx admission webhooks / RBAC on the namespace.");
  return { action, target: svc, dryRun: false, result: { mode, objects, paths, output: out.trim() } };
}

const NET_ACTIONS = ["net-loss", "net-delay", "net-partition", "net-clear", "net-status", "net-verify",
  "net-probe-start", "net-probe-tail", "net-probe-stop"] as const;

// How many ICMP echoes the probe sends. Enough to make the loss % meaningful
// without making the SSM round-trip drag (20 pings @ 1/s + 1s wait ≈ ~21s wall).
const PROBE_PINGS = 20;

/**
 * Parse a busybox `ping` summary out of arbitrary probe stdout.
 *   - loss:   "20 packets transmitted, 11 packets received, 45% packet loss"
 *   - avg rtt:"round-trip min/avg/max = 0.5/205.1/640.2 ms"  (busybox format)
 * rttMs is null when no replies came back (100% loss → no round-trip line).
 */
export function parsePingSummary(out: string): { lossPercent: number | null; rttMs: number | null } {
  const loss = /(\d+(?:\.\d+)?)% packet loss/.exec(out);
  const rtt = /round-trip\s+\S+\s*=\s*[\d.]+\/([\d.]+)\//.exec(out);
  return {
    lossPercent: loss ? Number(loss[1]) : null,
    rttMs: rtt ? Number(rtt[1]) : null,
  };
}

function chaosBackend(p: PlatformConfig): "chaos-mesh" | "pumba" {
  return p.chaosBackend ?? "chaos-mesh";
}

/** Pumba images, overridable per-platform so a locked-down cluster can point at its own registry mirror. */
const pumbaImage = (p: PlatformConfig) => p.chaosImage ?? "ghcr.io/alexei-led/pumba:latest";
const pumbaNetToolsImage = (p: PlatformConfig) => p.chaosNetToolsImage ?? "ghcr.io/alexei-led/pumba-alpine-nettools:latest";
/** Image for the L7 path 503 sink (must be nginx-compatible; override for a mirror). */
const chaosSinkImage = (p: PlatformConfig) => p.chaosSinkImage ?? "nginx:alpine";

// 1:1 port of emit_networkchaos(): Chaos Mesh NetworkChaos manifest.
function emitNetworkChaos(p: PlatformConfig, svc: string, kind: "loss" | "delay", req: ActionRequest): string {
  const ns = (p.identifiers as EksIdentifiers).namespace;
  const lkey = p.chaosLabel ?? "app";
  const dir = req.direction ?? "to";
  let m =
`apiVersion: chaos-mesh.org/v1alpha1
kind: NetworkChaos
metadata:
  name: chaos-nc-${svc}
  namespace: ${ns}
spec:
  action: ${kind}
  mode: all
  selector:
    namespaces:
    - ${ns}
    labelSelectors:
      ${lkey}: ${svc}
  direction: ${dir}
`;
  if (req.duration) m += `  duration: "${req.duration}"\n`;
  if (kind === "loss") m += `  loss:\n    loss: "${req.loss ?? 100}"\n    correlation: "0"\n`;
  else m += `  delay:\n    latency: "${req.delay ?? "200ms"}"\n    correlation: "0"\n    jitter: "0ms"\n`;
  return m;
}

// 1:1 port of emit_pumba_pod(): privileged Pod running `pumba netem`.
function emitPumbaPod(p: PlatformConfig, svc: string, kind: "loss" | "delay", req: ActionRequest): string {
  const ns = (p.identifiers as EksIdentifiers).namespace;
  const lkey = p.chaosLabel ?? "app";
  const img = pumbaImage(p);
  const tcimg = pumbaNetToolsImage(p);
  const dur = req.duration ?? "24h";
  const netargs =
    kind === "loss"
      ? `"loss", "--percent=${req.loss ?? 100}"`
      : `"delay", "--time=${(req.delay ?? "200ms").replace(/ms$/, "")}"`;
  return (
`apiVersion: v1
kind: Pod
metadata:
  name: chaos-pumba-${svc}
  namespace: ${ns}
  labels:
    chaos-backend: pumba
    chaos-service: "${svc}"
spec:
  hostPID: true
  restartPolicy: Never
  terminationGracePeriodSeconds: 25
  affinity:
    podAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
      - topologyKey: kubernetes.io/hostname
        labelSelector:
          matchLabels:
            ${lkey}: ${svc}
  containers:
  - name: pumba
    image: ${img}
    args: ["--log-level=info", "--runtime=containerd", "--containerd-namespace=k8s.io", "netem", "--tc-image=${tcimg}", "--duration=${dur}", "--interface=eth0", ${netargs}, "re2:${ns}/${svc}-.*"]
    securityContext:
      privileged: true
    volumeMounts:
    - { name: run, mountPath: /run/containerd }
    - { name: clib, mountPath: /var/lib/containerd }
    - { name: tmp, mountPath: /tmp }
  volumes:
  - { name: run, hostPath: { path: /run/containerd, type: Directory } }
  - { name: clib, hostPath: { path: /var/lib/containerd, type: Directory } }
  - { name: tmp, emptyDir: {} }
`
  );
}

/**
 * Apply the pumba Pod and CONFIRM it reaches Ready. Emits PUMBA_READY on success,
 * else PUMBA_NOT_READY followed by the container waiting-reason/phase + recent
 * events, so the engine can classify the failure (ImagePullBackOff, PodSecurity, …).
 * One SSM round-trip; `set -e`-free so we always fall through to diagnostics.
 */
function buildPumbaApplyScript(object: string, ns: string, apply: string): string {
  return [
    `kubectl delete pod ${object} -n ${ns} --ignore-not-found --grace-period=1 >/dev/null 2>&1`,
    `${apply} 2>&1`,
    `if kubectl wait --for=condition=Ready pod/${object} -n ${ns} --timeout=45s >/dev/null 2>&1; then echo PUMBA_READY; ` +
      `else echo PUMBA_NOT_READY; ` +
      `kubectl get pod ${object} -n ${ns} -o jsonpath='{range .status.containerStatuses[*]}{.state.waiting.reason}{": "}{.state.waiting.message}{end} phase={.status.phase}' 2>/dev/null; echo; ` +
      `kubectl get events -n ${ns} --field-selector involvedObject.name=${object} -o jsonpath='{.items[*].message}' 2>/dev/null; fi`,
  ].join("; ");
}

async function eksNetAct(p: PlatformConfig, creds: CredFactory, action: ActionName, req: ActionRequest): Promise<ActionOutcome> {
  const ns = (p.identifiers as EksIdentifiers).namespace;
  const backend = chaosBackend(p);
  if (backend !== "chaos-mesh" && backend !== "pumba") throw new Error(`unknown chaos backend '${backend}' (use chaos-mesh or pumba)`);
  const dryRun = !!req.dryRun;

  if (action === "net-status") {
    const l4 = backend === "chaos-mesh"
      ? `kubectl get networkchaos -n ${ns}`
      : `kubectl get pods -n ${ns} -l chaos-backend=pumba`;
    // also list any L7 path overlays after a marker so Active chaos surfaces them too.
    const kcmd = `${l4}; echo '---CHAOS-PATHS---'; kubectl get ingress -n ${ns} -l chaos-overlay=path --no-headers 2>/dev/null`;
    if (dryRun) return { action, target: null, dryRun: true, plan: { awsCall: "ssm:SendCommand", params: { kubectl: kcmd } } };
    const out = await runKubectl(p, creds, kcmd);
    return { action, target: null, dryRun: false, result: { output: out.trim() } };
  }

  const svc = req.service;
  if (!svc) throw new Error(`action '${action}' requires a service`);

  if (action === "net-clear") {
    const base = backend === "chaos-mesh"
      ? `kubectl delete networkchaos chaos-nc-${svc} -n ${ns} --ignore-not-found`
      : `kubectl delete pod chaos-pumba-${svc} -n ${ns} --ignore-not-found --grace-period=25`;
    // net-clear is the single "stop all chaos for this service" control: also remove any L7 path overlay.
    const kcmd = `${base}; ${pathOverlayDeleteCmd(ns, svc)}`;
    if (dryRun) return { action, target: svc, dryRun: true, plan: { awsCall: "ssm:SendCommand", params: { kubectl: kcmd } } };
    const out = await runKubectl(p, creds, kcmd);
    return { action, target: svc, dryRun: false, result: { output: out.trim() } };
  }

  if (action === "net-verify") return eksNetVerify(p, creds, svc, dryRun);
  if (action === "net-probe-start") return eksProbeStart(p, creds, svc, dryRun);
  if (action === "net-probe-tail") return eksProbeTail(p, creds, svc, req, dryRun);
  if (action === "net-probe-stop") return eksProbeStop(p, creds, svc, dryRun);

  // net-loss | net-partition | net-delay → build + apply a manifest
  const kind: "loss" | "delay" = action === "net-delay" ? "delay" : "loss";
  const built: ActionRequest = action === "net-partition" ? { ...req, loss: 100 } : req;
  const object = backend === "chaos-mesh" ? `chaos-nc-${svc}` : `chaos-pumba-${svc}`;
  const manifest = backend === "chaos-mesh"
    ? emitNetworkChaos(p, svc, kind, built)
    : emitPumbaPod(p, svc, kind, built);
  if (dryRun) return { action, target: svc, dryRun: true, plan: { awsCall: "ssm:SendCommand", params: { backend, object, manifest } } };
  const b64 = Buffer.from(manifest, "utf8").toString("base64").replace(/\n/g, "");
  const apply = `echo ${b64} | base64 -d | kubectl apply -f -`;
  if (backend === "chaos-mesh") {
    const out = await runKubectl(p, creds, apply);
    return { action, target: svc, dryRun: false, result: { backend, object, output: out.trim() } };
  }
  // pumba creates a Pod (immutable): delete any prior one first so re-throttling is
  // idempotent. kubectl apply succeeding only means the API accepted the manifest —
  // the pod can still fail to pull its image or be denied by Pod Security. So we
  // CONFIRM it reaches Ready and, if not, surface the real (addressable) reason
  // instead of a false success.
  const out = await runKubectl(p, creds, buildPumbaApplyScript(object, ns, apply), 75_000);
  if (!/PUMBA_READY/.test(out)) {
    const reason = out.replace(/PUMBA_NOT_READY/g, "").trim();
    const c = classifyKubectlError(reason || "the chaos pod did not become Ready");
    throw new ChaosError(c.code, `Pumba pod for '${svc}' did not become Ready: ${c.message}`,
      c.remediation ?? `Inspect it: kubectl describe pod ${object} -n ${ns}`);
  }
  return { action, target: svc, dryRun: false, result: { backend, object, ready: true, output: out.trim() } };
}

/**
 * net-verify: measure that EKS packet chaos is actually biting. We resolve a
 * running pod IP of the target service, then run a short-lived busybox probe pod
 * that pings it; Pumba's egress netem drops the echo replies, so the measured
 * loss/latency reflects the configured fault. One SSM round-trip drives the whole
 * thing (delete-prior, resolve-IP, run, wait, logs, delete) so it stays a single,
 * idempotent shell command on the manager.
 */
function buildVerifyCommand(p: PlatformConfig, svc: string): string {
  const ns = (p.identifiers as EksIdentifiers).namespace;
  const lkey = p.chaosLabel ?? "app";
  const pod = `chaos-probe-${svc}`;
  // A single sh script. `set -e` is intentionally NOT used: we want to fall
  // through to logs/cleanup even if `kubectl wait` times out (e.g. 100% loss can
  // still let the pod Succeed, but a flaky pull/schedule shouldn't abort cleanup).
  return [
    // 1. idempotent: remove any probe left over from a prior run.
    `kubectl delete pod ${pod} -n ${ns} --ignore-not-found --grace-period=1 >/dev/null 2>&1`,
    // 2. resolve a Running pod IP for the target service.
    `IP=$(kubectl get pods -n ${ns} -l ${lkey}=${svc} --field-selector=status.phase=Running -o jsonpath='{.items[0].status.podIP}' 2>/dev/null)`,
    // 3. no target → emit a sentinel the engine recognizes, and stop.
    `if [ -z "$IP" ]; then echo NO_TARGET; exit 0; fi`,
    // 4. run the probe (no --rm: we drive wait/logs/delete ourselves, which is
    //    robust over SSM where --attach --rm streaming can be flaky).
    `kubectl run ${pod} -n ${ns} --image=busybox:1.36 --restart=Never --quiet --command -- ping -c ${PROBE_PINGS} -W 1 "$IP" >/dev/null 2>&1`,
    // 5. wait for it to finish (bounded), then print its output for parsing.
    `kubectl wait --for=jsonpath='{.status.phase}'=Succeeded pod/${pod} -n ${ns} --timeout=40s >/dev/null 2>&1`,
    `echo "TARGET_IP=$IP"`,
    `kubectl logs pod/${pod} -n ${ns} 2>/dev/null`,
    // 6. always clean up the probe pod.
    `kubectl delete pod ${pod} -n ${ns} --ignore-not-found --grace-period=1 >/dev/null 2>&1`,
  ].join("; ");
}

async function eksNetVerify(p: PlatformConfig, creds: CredFactory, svc: string, dryRun: boolean): Promise<ActionOutcome> {
  // Defensive: eksAct is only dispatched for eks_ssm, but guard so a direct/ECS
  // call fails loudly rather than building a kubectl command for a non-EKS box.
  if (p.kind !== "eks_ssm") throw new Error("verification probe is EKS-only");
  const ns = (p.identifiers as EksIdentifiers).namespace;
  const kcmd = buildVerifyCommand(p, svc);
  if (dryRun)
    return {
      action: "net-verify", target: svc, dryRun: true,
      plan: { awsCall: "ssm:SendCommand", params: { kubectl: kcmd, probePod: `chaos-probe-${svc}`, namespace: ns, pings: PROBE_PINGS } },
    };
  // The probe sends PROBE_PINGS @ ~1/s with a 40s wait; give SSM headroom.
  const out = await runKubectl(p, creds, kcmd, 90_000);
  if (/(^|\n)\s*NO_TARGET\s*(\n|$)/.test(out))
    throw new Error(`no running pod for '${svc}' in ${ns} (nothing to probe)`);
  const ipm = /TARGET_IP=([0-9.]+)/.exec(out);
  const { lossPercent, rttMs } = parsePingSummary(out);
  return {
    action: "net-verify", target: svc, dryRun: false,
    result: { service: svc, target: ipm ? ipm[1] : null, sampled: PROBE_PINGS, lossPercent, rttMs, raw: out.trim() },
  };
}

// ── Near-live streaming probe (net-probe-start / -tail / -stop) ──────────────
//
// Where net-verify is a single ~30s round-trip (spawn pod, ping 20x, wait, read,
// delete), the streaming probe trades one-shot accuracy for liveness: ONE long-
// lived pod pings the target once a second and prints one JSON line per second to
// stdout, and the console tails its logs every ~2.5s. Same mechanism, same zero
// new AWS permissions (runKubectl = ssm:SendCommand + GetCommandInvocation), same
// non-privileged busybox pod. The probe self-terminates after ~10 min so an
// orphan (e.g. a browser tab closed without firing stop) can't linger.

/** The streaming probe pod name for a service (one per service; delete-before-create). */
const streamProbePod = (svc: string) => `chaos-streamprobe-${svc}`;
/** Default trailing window the console reads each tick (a touch over the 2.5s poll). */
const PROBE_TAIL_SINCE = 6;
/** Bound the per-second ping loop so an orphaned probe self-terminates (~10 min). */
const PROBE_MAX_ITERS = 600;

/**
 * Build the net-probe-start command: idempotently (delete-before-create) launch a
 * single busybox pod that resolves nothing on its own — we resolve the target pod
 * IP on the manager first, then run a bounded `sh -c` loop that pings that IP once
 * a second and prints ONE JSON line per second:
 *   reply   -> {"t":<epochSeconds>,"ok":1,"rtt":<ms>}
 *   timeout -> {"t":<epochSeconds>,"ok":0}
 * The pod is NOT privileged (plain ICMP from a busybox needs nothing special) and
 * restartPolicy=Never so it doesn't respawn after the loop self-terminates. One
 * SSM round-trip drives delete + resolve + create.
 */
function buildProbeStartCommand(p: PlatformConfig, svc: string): string {
  const ns = (p.identifiers as EksIdentifiers).namespace;
  const lkey = p.chaosLabel ?? "app";
  const pod = streamProbePod(svc);
  // The in-pod loop, single-quoted so NOTHING here is expanded by the manager's
  // shell — every `$…` belongs to the pod's own shell at runtime. The target IP
  // arrives as the positional `$1` (we pass "$IP" after the script), so it's data,
  // never interpolated text. `ping -c1 -W1` = one echo, 1s timeout, so each
  // iteration is ~1s whether the reply lands or is dropped by the injected fault.
  // The avg rtt is pulled from busybox's "round-trip min/avg/max = .../X/... ms"
  // summary; on a timeout there's no such line, so we emit ok:0. `i` bounds the
  // loop so the pod Completes (and is reapable) even if net-probe-stop never runs.
  const podScript =
    `IP="$1"; i=0; while [ $i -lt ${PROBE_MAX_ITERS} ]; do ` +
    `i=$((i+1)); T=$(date +%s); ` +
    `R=$(ping -c1 -W1 "$IP" 2>/dev/null); ` +
    `if echo "$R" | grep -q round-trip; then ` +
    `MS=$(echo "$R" | sed -n "s|.*round-trip[^=]*= [0-9.]*/\\([0-9.]*\\)/.*|\\1|p"); ` +
    `echo "{\\"t\\":$T,\\"ok\\":1,\\"rtt\\":$MS}"; ` +
    `else echo "{\\"t\\":$T,\\"ok\\":0}"; fi; ` +
    `sleep 1; done`;
  return [
    // 1. idempotent: remove any prior streaming probe for this service.
    `kubectl delete pod ${pod} -n ${ns} --ignore-not-found --grace-period=1 >/dev/null 2>&1`,
    // 2. resolve a Running pod IP for the target service (chaos label, else app)
    //    ON THE MANAGER, so a NO_RUNNING_PODS surfaces before we ever create a pod.
    `IP=$(kubectl get pods -n ${ns} -l ${lkey}=${svc} --field-selector=status.phase=Running -o jsonpath='{.items[0].status.podIP}' 2>/dev/null)`,
    // 3. no target → sentinel the engine maps to NO_RUNNING_PODS, and stop.
    `if [ -z "$IP" ]; then echo NO_TARGET; exit 0; fi`,
    // 4. launch the long-lived probe; the resolved IP is passed as $1 to the loop,
    //    which pings it once/sec and prints one JSON line/sec to stdout.
    `kubectl run ${pod} -n ${ns} --image=busybox:1.36 --restart=Never --quiet ` +
      `--command -- sh -c '${podScript}' _ "$IP" >/dev/null 2>&1`,
    `echo "PROBE_STARTED IP=$IP"`,
  ].join("; ");
}

async function eksProbeStart(p: PlatformConfig, creds: CredFactory, svc: string, dryRun: boolean): Promise<ActionOutcome> {
  if (p.kind !== "eks_ssm") throw new ChaosError("UNKNOWN", "the streaming probe is EKS-only");
  const ns = (p.identifiers as EksIdentifiers).namespace;
  const pod = streamProbePod(svc);
  const kcmd = buildProbeStartCommand(p, svc);
  if (dryRun)
    return {
      action: "net-probe-start", target: svc, dryRun: true,
      plan: { awsCall: "ssm:SendCommand", params: { kubectl: kcmd, probePod: pod, namespace: ns, maxIterations: PROBE_MAX_ITERS } },
    };
  const out = await runKubectl(p, creds, kcmd, 45_000);
  if (/(^|\n)\s*NO_TARGET\s*(\n|$)/.test(out))
    throw new ChaosError("NO_RUNNING_PODS", `no running pod for '${svc}' in ${ns} (nothing to probe)`,
      "Start the service (scale it up) so there's a pod to ping, then start the probe again.");
  const ipm = /IP=([0-9.]+)/.exec(out);
  return {
    action: "net-probe-start", target: svc, dryRun: false,
    result: { service: svc, probePod: pod, target: ipm ? ipm[1] : null, started: true },
  };
}

/**
 * Parse the streaming probe's stdout (one JSON object per line) into samples.
 * Tolerates partial/garbage lines (a half-flushed log line over SSM) by skipping
 * anything that isn't a well-formed {t, ok[, rtt]} object. Exported for tests.
 */
export function parseProbeLines(out: string): Array<{ t: number; ok: boolean; rtt: number | null }> {
  const samples: Array<{ t: number; ok: boolean; rtt: number | null }> = [];
  for (const line of out.split("\n")) {
    const s = line.trim();
    if (!s.startsWith("{")) continue;
    let o: { t?: unknown; ok?: unknown; rtt?: unknown };
    try { o = JSON.parse(s); } catch { continue; }
    if (typeof o.t !== "number") continue;
    const ok = o.ok === 1 || o.ok === true;
    samples.push({ t: o.t, ok, rtt: ok && typeof o.rtt === "number" ? o.rtt : null });
  }
  return samples;
}

/**
 * net-probe-tail: read the last `sinceSeconds` (default ~6s) of the streaming
 * probe's logs and return the parsed 1s samples. Tolerates the pod not existing
 * yet (it may still be scheduling, or stop just ran) — that surfaces as
 * `podMissing:true` with empty samples, NOT an error, so the console keeps polling.
 */
function buildProbeTailCommand(p: PlatformConfig, svc: string, sinceSeconds: number): string {
  const ns = (p.identifiers as EksIdentifiers).namespace;
  const pod = streamProbePod(svc);
  // `kubectl logs --since=<n>s` prints only the trailing window. If the pod is
  // gone, kubectl writes a NotFound to stderr and exits non-zero; we capture that
  // (2>&1) and emit a sentinel so the engine reports podMissing instead of failing.
  return `kubectl logs --since=${sinceSeconds}s ${pod} -n ${ns} 2>&1 || echo PROBE_POD_MISSING`;
}

async function eksProbeTail(p: PlatformConfig, creds: CredFactory, svc: string, req: ActionRequest, dryRun: boolean): Promise<ActionOutcome> {
  if (p.kind !== "eks_ssm") throw new ChaosError("UNKNOWN", "the streaming probe is EKS-only");
  const ns = (p.identifiers as EksIdentifiers).namespace;
  const since = clampSince(req.sinceSeconds);
  const kcmd = buildProbeTailCommand(p, svc, since);
  if (dryRun)
    return {
      action: "net-probe-tail", target: svc, dryRun: true,
      plan: { awsCall: "ssm:SendCommand", params: { kubectl: kcmd, probePod: streamProbePod(svc), namespace: ns, sinceSeconds: since } },
    };
  const out = await runKubectl(p, creds, kcmd, 30_000);
  // The pod isn't there (yet, or anymore): not an error — return empty + the flag.
  const podMissing = /PROBE_POD_MISSING/.test(out) || /\bnotfound\b|not found|forbidden/i.test(out);
  if (podMissing)
    return { action: "net-probe-tail", target: svc, dryRun: false, result: { service: svc, samples: [], podMissing: true } };
  return { action: "net-probe-tail", target: svc, dryRun: false, result: { service: svc, samples: parseProbeLines(out) } };
}

/** Keep the tail window sane: 1..60s, default PROBE_TAIL_SINCE. */
function clampSince(s: number | undefined): number {
  if (typeof s !== "number" || !Number.isFinite(s)) return PROBE_TAIL_SINCE;
  return Math.max(1, Math.min(60, Math.round(s)));
}

/** net-probe-stop: delete the streaming probe pod (idempotent, fast grace). */
async function eksProbeStop(p: PlatformConfig, creds: CredFactory, svc: string, dryRun: boolean): Promise<ActionOutcome> {
  if (p.kind !== "eks_ssm") throw new ChaosError("UNKNOWN", "the streaming probe is EKS-only");
  const ns = (p.identifiers as EksIdentifiers).namespace;
  const pod = streamProbePod(svc);
  const kcmd = `kubectl delete pod ${pod} -n ${ns} --ignore-not-found --grace-period=1`;
  if (dryRun)
    return { action: "net-probe-stop", target: svc, dryRun: true, plan: { awsCall: "ssm:SendCommand", params: { kubectl: kcmd } } };
  const out = await runKubectl(p, creds, kcmd, 30_000);
  return { action: "net-probe-stop", target: svc, dryRun: false, result: { service: svc, probePod: pod, output: out.trim() } };
}

/**
 * net-preflight: a read that reports whether each EKS chaos backend can actually run.
 * It schedules a short-lived *privileged* probe pod from the configured chaos image
 * (testing image-pull AND Pod Security admission in one shot), then checks the
 * ingress-nginx controller. Returns CapabilityStatus (pumba) + IngressStatus, both
 * with addressable detail/remediation, and always cleans the probe up. One SSM trip.
 */
function buildPreflightScript(p: PlatformConfig): string {
  const ns = (p.identifiers as EksIdentifiers).namespace;
  const pod = "chaos-preflight";
  const manifest =
`apiVersion: v1
kind: Pod
metadata:
  name: ${pod}
  namespace: ${ns}
  labels: { chaos-overlay: preflight }
spec:
  restartPolicy: Never
  containers:
  - name: probe
    image: ${pumbaImage(p)}
    command: ["true"]
    securityContext:
      privileged: true
`;
  const b64 = Buffer.from(manifest, "utf8").toString("base64").replace(/\n/g, "");
  return [
    `kubectl delete pod ${pod} -n ${ns} --ignore-not-found --grace-period=1 >/dev/null 2>&1`,
    `echo PROBE_APPLY_BEGIN`,
    `echo ${b64} | base64 -d | kubectl apply -f - 2>&1`,
    `echo PROBE_APPLY_END`,
    `kubectl wait --for=jsonpath='{.status.phase}'=Succeeded pod/${pod} -n ${ns} --timeout=30s >/dev/null 2>&1 || kubectl wait --for=condition=Ready pod/${pod} -n ${ns} --timeout=2s >/dev/null 2>&1`,
    `echo "PROBE_STATE=$(kubectl get pod ${pod} -n ${ns} -o jsonpath='{.status.phase}|{range .status.containerStatuses[*]}{.state.waiting.reason}{end}' 2>/dev/null)"`,
    `kubectl get events -n ${ns} --field-selector involvedObject.name=${pod} -o jsonpath='{.items[*].message}' 2>/dev/null`,
    `echo`,
    `kubectl delete pod ${pod} -n ${ns} --ignore-not-found --grace-period=1 >/dev/null 2>&1`,
    `echo INGRESS_PODS_BEGIN`,
    `kubectl get pods -n ingress-nginx -l app.kubernetes.io/name=ingress-nginx --no-headers 2>&1`,
    `echo INGRESS_CLASS_BEGIN`,
    `kubectl get ingressclass -o jsonpath='{range .items[*]}{.metadata.name}={.spec.controller} {end}' 2>&1`,
  ].join("; ");
}

function section(out: string, begin: string, end?: string): string {
  const i = out.indexOf(begin);
  if (i < 0) return "";
  const start = i + begin.length;
  const j = end ? out.indexOf(end, start) : -1;
  return out.slice(start, j < 0 ? undefined : j).trim();
}

function pumbaCapability(applyText: string, stateText: string): CapabilityStatus {
  // Pod Security Admission rejects the privileged pod at apply (admission) time.
  if (/podsecurity|pod security|\bprivileged\b/i.test(applyText)) {
    const c = classifyKubectlError(applyText);
    return { ready: false, state: "privileged-blocked", detail: c.message, remediation: c.remediation };
  }
  const ran = /(\bSucceeded\b|\bRunning\b)/.test(stateText) && !/imagepull|errimage/i.test(stateText);
  if (ran) return { ready: true, state: "ready", detail: "A privileged probe pod scheduled and ran from the chaos image." };
  const c = classifyKubectlError(stateText || applyText || "the probe pod did not become Ready");
  const state: CapabilityStatus["state"] =
    c.code === "IMAGE_UNREACHABLE" ? "image-unreachable"
    : c.code === "PRIVILEGED_BLOCKED" ? "privileged-blocked"
    : c.code === "MANAGER_UNREACHABLE" ? "manager-unreachable" : "unknown";
  return { ready: false, state, detail: c.message, remediation: c.remediation };
}

function ingressHealth(podsText: string, classText: string): IngressStatus {
  const hasNginxClass = /nginx/i.test(classText);
  const controller = hasNginxClass ? (classText.split("=")[1]?.trim().split(/\s/)[0] || "k8s.io/ingress-nginx") : undefined;
  if (/forbidden/i.test(podsText))
    return { present: false, healthy: false, detail: "Could not verify ingress-nginx (RBAC denied listing its pods).",
      remediation: "Grant the manager kubeconfig list on pods in the ingress-nginx namespace." };
  const noPods = podsText === "" || /no resources found|notfound/i.test(podsText);
  if (noPods && !hasNginxClass)
    return { present: false, healthy: false, detail: "No ingress-nginx controller / IngressClass was found.",
      remediation: "Install ingress-nginx, or use L4 chaos (net-loss/net-delay) which needs no ingress." };
  const running = /\bRunning\b/.test(podsText);
  return { present: true, healthy: running, controller,
    detail: running ? "ingress-nginx is installed and running." : "ingress-nginx is present but not all controller pods are Running.",
    remediation: running ? undefined : "Check the ingress-nginx controller pods (kubectl get pods -n ingress-nginx)." };
}

/** Parse the one-shot preflight script output into backend health. Exported for tests. */
export function parsePreflight(out: string): { pumba: CapabilityStatus; ingress: IngressStatus } {
  const applyText = section(out, "PROBE_APPLY_BEGIN", "PROBE_APPLY_END");
  const stateText = section(out, "PROBE_APPLY_END", "INGRESS_PODS_BEGIN");
  const podsText = section(out, "INGRESS_PODS_BEGIN", "INGRESS_CLASS_BEGIN");
  const classText = section(out, "INGRESS_CLASS_BEGIN");
  return { pumba: pumbaCapability(applyText, stateText), ingress: ingressHealth(podsText, classText) };
}

async function eksPreflight(p: PlatformConfig, creds: CredFactory, dryRun: boolean): Promise<ActionOutcome> {
  if (p.kind !== "eks_ssm") throw new ChaosError("UNKNOWN", "preflight is EKS-only");
  const script = buildPreflightScript(p);
  if (dryRun) return { action: "net-preflight", target: null, dryRun: true, plan: { awsCall: "ssm:SendCommand", params: { kubectl: script } } };
  let out: string;
  try { out = await runKubectl(p, creds, script, 60_000); }
  catch (e) {
    // The manager/SSM itself is unreachable: report it as the backend health, don't throw.
    const c = classifyKubectlError(e);
    return { action: "net-preflight", target: null, dryRun: false, result: {
      pumba: { ready: false, state: "manager-unreachable", detail: c.message, remediation: c.remediation },
      ingress: { present: false, healthy: false, detail: c.message, remediation: c.remediation },
    } };
  }
  return { action: "net-preflight", target: null, dryRun: false, result: { ...parsePreflight(out), raw: out.trim() } };
}

export async function eksAct(p: PlatformConfig, creds: CredFactory, action: ActionName, req: ActionRequest): Promise<ActionOutcome> {
  const id = p.identifiers as EksIdentifiers; const ns = id.namespace; const dryRun = !!req.dryRun;
  if (action === "net-preflight") return eksPreflight(p, creds, dryRun);
  if (action === "stop-all" || action === "start-all") {
    if (!id.asg) throw new Error(`platform '${p.id}' has no ASG configured`);
    const cap = action === "stop-all" ? 0 : (id.asgRestoreCap ?? 2);
    const params = { AutoScalingGroupName: id.asg, MinSize: cap, DesiredCapacity: cap };
    if (dryRun) return { action, target: id.asg, dryRun: true, plan: { awsCall: "autoscaling:UpdateAutoScalingGroup", params } };
    await new AutoScalingClient({ region: p.region, credentials: creds(p) }).send(new UpdateAutoScalingGroupCommand(params));
    return { action, target: id.asg, dryRun: false, result: { capacity: cap } };
  }
  if ((PATH_ACTIONS as readonly string[]).includes(action)) return eksPathAct(p, creds, action, req);
  if ((NET_ACTIONS as readonly string[]).includes(action)) return eksNetAct(p, creds, action, req);
  const svc = req.service; if (!svc) throw new Error(`action '${action}' requires a service`);
  let kcmd: string;
  if (action === "stop") kcmd = `kubectl scale deployment ${svc} --replicas=0 -n ${ns}`;
  else if (action === "start") kcmd = `kubectl scale deployment ${svc} --replicas=${req.count ?? p.restore ?? 2} -n ${ns}`;
  else if (action === "restart") kcmd = `kubectl rollout restart deployment ${svc} -n ${ns}`;
  else throw new Error(`unknown action '${action}' for eks_ssm`);
  if (dryRun) return { action, target: svc, dryRun: true, plan: { awsCall: "ssm:SendCommand", params: { kubectl: kcmd } } };
  const out = await runKubectl(p, creds, kcmd);
  return { action, target: svc, dryRun: false, result: { output: out.trim() } };
}
