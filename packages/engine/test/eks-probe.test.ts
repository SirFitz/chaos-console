// packages/engine/test/eks-probe.test.ts
//
// The near-live streaming probe: net-probe-start (launch one continuous ping pod),
// net-probe-tail (read the trailing JSON-line logs), net-probe-stop (delete it).
// Mocks SSM like eks-net.test.ts / eks-verify.test.ts; everything rides the same
// runKubectl (ssm:SendCommand + GetCommandInvocation), no new AWS calls.
import { describe, it, expect, beforeEach } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { SSMClient, SendCommandCommand, GetCommandInvocationCommand } from "@aws-sdk/client-ssm";
import { eksAct, parseProbeLines } from "../src/handlers/eks.js";

const ssm = mockClient(SSMClient);
beforeEach(() => ssm.reset());

const ssmReturns = (stdout: string) => {
  ssm.on(SendCommandCommand).resolves({ Command: { CommandId: "c" } });
  ssm.on(GetCommandInvocationCommand).resolves({ Status: "Success", StandardOutputContent: stdout, StandardErrorContent: "" });
};
const cmd = () =>
  (ssm.commandCalls(SendCommandCommand)[0].args[0].input as { Parameters?: { commands?: string[] } }).Parameters!.commands![0];

const p: any = { id: "api", layer: "API", kind: "eks_ssm", region: "us-east-1", creds: { mode: "default" },
  identifiers: { managerInstance: "i-1", namespace: "ns1" }, restore: 2 };
const ecsP: any = { id: "mi", layer: "MI", kind: "ecs", region: "us-east-1", creds: { mode: "default" },
  identifiers: { cluster: "c1" } };
const noCreds = () => undefined as any;

describe("eksAct net-probe-start", () => {
  it("idempotently launches one continuous ping pod that prints one JSON line/sec", async () => {
    ssmReturns("PROBE_STARTED IP=10.20.2.114");
    const r = await eksAct(p, noCreds, "net-probe-start", { service: "dep" });
    const c = cmd();
    // delete-before-create: any prior streaming probe is removed first.
    expect(c).toContain("kubectl delete pod chaos-streamprobe-dep -n ns1 --ignore-not-found --grace-period=1");
    // resolve a RUNNING pod IP on the manager using the chaos label (default app).
    expect(c).toContain("kubectl get pods -n ns1 -l app=dep --field-selector=status.phase=Running -o jsonpath='{.items[0].status.podIP}'");
    // empty IP → NO_TARGET guard before any pod is created.
    expect(c).toContain("NO_TARGET");
    // a non-privileged busybox pod, restart=Never, NOT privileged.
    expect(c).toContain("kubectl run chaos-streamprobe-dep -n ns1 --image=busybox:1.36 --restart=Never");
    expect(c).not.toContain("privileged");
    // the per-second probe: one echo, 1s timeout, JSON line, sleep 1, bounded loop.
    expect(c).toContain("ping -c1 -W1");
    expect(c).toContain("sleep 1");
    expect(c).toContain("-lt 600");                 // ~10 min self-terminating bound
    expect(c).toContain('\\"ok\\":1');              // reply line
    expect(c).toContain('\\"ok\\":0');              // timeout line
    // the resolved IP is passed as a positional arg ($1), never interpolated text.
    expect(c).toContain('_ "$IP"');
    // a single SSM round-trip launches it.
    expect(ssm.commandCalls(SendCommandCommand)).toHaveLength(1);
    expect(r.result).toMatchObject({ service: "dep", probePod: "chaos-streamprobe-dep", target: "10.20.2.114", started: true });
  });

  it("uses a custom chaosLabel to find the target pod", async () => {
    ssmReturns("PROBE_STARTED IP=10.0.0.9");
    await eksAct({ ...p, chaosLabel: "k8s-app" }, noCreds, "net-probe-start", { service: "dep" });
    expect(cmd()).toContain("-l k8s-app=dep");
  });

  it("throws NO_RUNNING_PODS when there is no running pod (NO_TARGET sentinel)", async () => {
    ssmReturns("NO_TARGET\n");
    await expect(eksAct(p, noCreds, "net-probe-start", { service: "dep" }))
      .rejects.toMatchObject({ code: "NO_RUNNING_PODS" });
  });

  it("dry-run returns a plan and makes no SSM calls", async () => {
    const r = await eksAct(p, noCreds, "net-probe-start", { service: "dep", dryRun: true });
    expect(ssm.calls()).toHaveLength(0);
    expect(r.dryRun).toBe(true);
    expect(r.plan?.awsCall).toBe("ssm:SendCommand");
    expect(r.plan?.params.probePod).toBe("chaos-streamprobe-dep");
    expect(r.plan?.params.maxIterations).toBe(600);
    expect(String(r.plan?.params.kubectl)).toContain("kubectl run chaos-streamprobe-dep");
  });

  it("is EKS-only: rejects an ecs platform", async () => {
    await expect(eksAct(ecsP, noCreds, "net-probe-start", { service: "dep" })).rejects.toThrow(/eks-only/i);
  });

  it("requires a service", async () => {
    await expect(eksAct(p, noCreds, "net-probe-start", {})).rejects.toThrow(/requires a service/i);
  });
});

describe("eksAct net-probe-tail", () => {
  it("reads the trailing window of probe logs and parses the 1s JSON samples", async () => {
    ssmReturns(`{"t":1700000001,"ok":1,"rtt":0.8}
{"t":1700000002,"ok":0}
{"t":1700000003,"ok":1,"rtt":1.2}`);
    const r = await eksAct(p, noCreds, "net-probe-tail", { service: "dep" });
    expect(cmd()).toContain("kubectl logs --since=6s chaos-streamprobe-dep -n ns1");
    expect(r.result?.samples).toEqual([
      { t: 1700000001, ok: true, rtt: 0.8 },
      { t: 1700000002, ok: false, rtt: null },
      { t: 1700000003, ok: true, rtt: 1.2 },
    ]);
    expect(r.result?.podMissing).toBeUndefined();
  });

  it("honors a custom sinceSeconds window (clamped sane)", async () => {
    ssmReturns(`{"t":1,"ok":1,"rtt":2}`);
    await eksAct(p, noCreds, "net-probe-tail", { service: "dep", sinceSeconds: 3 });
    expect(cmd()).toContain("kubectl logs --since=3s chaos-streamprobe-dep -n ns1");
  });

  it("tolerates the pod not existing yet → empty samples + podMissing, not an error", async () => {
    ssmReturns("PROBE_POD_MISSING\n");
    const r = await eksAct(p, noCreds, "net-probe-tail", { service: "dep" });
    expect(r.result).toMatchObject({ service: "dep", samples: [], podMissing: true });
  });

  it("treats a kubectl NotFound on logs as podMissing, not an error", async () => {
    ssmReturns('Error from server (NotFound): pods "chaos-streamprobe-dep" not found');
    const r = await eksAct(p, noCreds, "net-probe-tail", { service: "dep" });
    expect(r.result).toMatchObject({ samples: [], podMissing: true });
  });

  it("dry-run returns a plan and makes no SSM calls", async () => {
    const r = await eksAct(p, noCreds, "net-probe-tail", { service: "dep", dryRun: true });
    expect(ssm.calls()).toHaveLength(0);
    expect(r.plan?.params.sinceSeconds).toBe(6);
    expect(String(r.plan?.params.kubectl)).toContain("kubectl logs --since=6s");
  });

  it("is EKS-only: rejects an ecs platform", async () => {
    await expect(eksAct(ecsP, noCreds, "net-probe-tail", { service: "dep" })).rejects.toThrow(/eks-only/i);
  });
});

describe("eksAct net-probe-stop", () => {
  it("deletes the streaming probe pod (idempotent, fast grace)", async () => {
    ssmReturns("pod \"chaos-streamprobe-dep\" deleted");
    await eksAct(p, noCreds, "net-probe-stop", { service: "dep" });
    expect(cmd()).toContain("kubectl delete pod chaos-streamprobe-dep -n ns1 --ignore-not-found --grace-period=1");
  });

  it("dry-run returns a plan and makes no SSM calls", async () => {
    const r = await eksAct(p, noCreds, "net-probe-stop", { service: "dep", dryRun: true });
    expect(ssm.calls()).toHaveLength(0);
    expect(String(r.plan?.params.kubectl)).toBe("kubectl delete pod chaos-streamprobe-dep -n ns1 --ignore-not-found --grace-period=1");
  });

  it("is EKS-only: rejects an ecs platform", async () => {
    await expect(eksAct(ecsP, noCreds, "net-probe-stop", { service: "dep" })).rejects.toThrow(/eks-only/i);
  });
});

describe("parseProbeLines", () => {
  it("parses well-formed JSON lines, mapping ok:1 → true with rtt and ok:0 → false with null rtt", () => {
    expect(parseProbeLines(`{"t":10,"ok":1,"rtt":5.5}\n{"t":11,"ok":0}`)).toEqual([
      { t: 10, ok: true, rtt: 5.5 },
      { t: 11, ok: false, rtt: null },
    ]);
  });
  it("skips blank, non-JSON, and half-flushed lines (robust over SSM)", () => {
    expect(parseProbeLines(`\nPING 10.0.0.1 ...\n{"t":1,"ok":1,"rtt":2}\n{"t":2,"ok":1,"rt`)).toEqual([
      { t: 1, ok: true, rtt: 2 },
    ]);
  });
  it("drops rtt when ok is false even if a stray rtt is present", () => {
    expect(parseProbeLines(`{"t":3,"ok":0,"rtt":99}`)).toEqual([{ t: 3, ok: false, rtt: null }]);
  });
  it("returns an empty array for empty output", () => {
    expect(parseProbeLines("")).toEqual([]);
  });
});
