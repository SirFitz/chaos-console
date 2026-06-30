// packages/engine/test/eks-verify.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { SSMClient, SendCommandCommand, GetCommandInvocationCommand } from "@aws-sdk/client-ssm";
import { eksAct, parsePingSummary } from "../src/handlers/eks.js";

const ssm = mockClient(SSMClient);
beforeEach(() => ssm.reset());

// Resolve SSM with a caller-supplied probe stdout.
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

// A representative busybox ping summary (note busybox's `round-trip` line + the
// "packets received" wording, which differs from iputils ping).
const BUSYBOX_OK = `TARGET_IP=10.20.2.114
PING 10.20.2.114 (10.20.2.114): 56 data bytes
20 packets transmitted, 11 packets received, 45% packet loss
round-trip min/avg/max = 0.512/205.137/640.201 ms`;

describe("eksAct net-verify (probe)", () => {
  it("honors a chaosProbeImage override (registry mirror when docker.io is blocked)", async () => {
    ssmReturns(BUSYBOX_OK);
    await eksAct({ ...p, chaosProbeImage: "jfrog.corp/busybox:1.36" }, noCreds, "net-verify", { service: "dep" });
    expect(cmd()).toContain("--image=jfrog.corp/busybox:1.36 --restart=Never");
  });
  it("issues one idempotent shell command: delete prior probe, resolve a Running pod IP, run busybox ping", async () => {
    ssmReturns(BUSYBOX_OK);
    await eksAct(p, noCreds, "net-verify", { service: "dep" });
    const c = cmd();
    // idempotent pre-delete of any leftover probe pod
    expect(c).toContain("kubectl delete pod chaos-probe-dep -n ns1 --ignore-not-found --grace-period=1");
    // resolve a RUNNING pod IP using the chaos label (default "app") + jsonpath
    expect(c).toContain("kubectl get pods -n ns1 -l app=dep --field-selector=status.phase=Running -o jsonpath='{.items[0].status.podIP}'");
    // empty IP → NO_TARGET sentinel guard
    expect(c).toContain("NO_TARGET");
    // run the busybox probe that pings the resolved IP
    expect(c).toContain("kubectl run chaos-probe-dep -n ns1 --image=busybox:1.36 --restart=Never");
    expect(c).toContain("ping -c 20 -W 1");
    // a single SSM round-trip drives the whole thing
    expect(ssm.commandCalls(SendCommandCommand)).toHaveLength(1);
  });

  it("parses measured packet loss and avg rtt from the busybox summary", async () => {
    ssmReturns(BUSYBOX_OK);
    const r = await eksAct(p, noCreds, "net-verify", { service: "dep" });
    expect(r.result).toMatchObject({ service: "dep", target: "10.20.2.114", sampled: 20, lossPercent: 45, rttMs: 205.137 });
    expect(String(r.result?.raw)).toContain("45% packet loss");
  });

  it("reports rttMs null when every packet was lost (no round-trip line)", async () => {
    ssmReturns(`TARGET_IP=10.20.2.114
PING 10.20.2.114 (10.20.2.114): 56 data bytes
20 packets transmitted, 0 packets received, 100% packet loss`);
    const r = await eksAct(p, noCreds, "net-verify", { service: "dep" });
    expect(r.result).toMatchObject({ lossPercent: 100, rttMs: null, target: "10.20.2.114" });
  });

  it("uses a custom chaosLabel to find the target pod", async () => {
    ssmReturns(BUSYBOX_OK);
    await eksAct({ ...p, chaosLabel: "k8s-app" }, noCreds, "net-verify", { service: "dep" });
    expect(cmd()).toContain("-l k8s-app=dep");
  });

  it("throws a clear error when there is no running pod (NO_TARGET sentinel)", async () => {
    ssmReturns("NO_TARGET\n");
    await expect(eksAct(p, noCreds, "net-verify", { service: "dep" })).rejects.toThrow(/no running pod for 'dep'/i);
  });

  it("requires a service", async () => {
    await expect(eksAct(p, noCreds, "net-verify", {})).rejects.toThrow(/requires a service/i);
  });

  it("is EKS-only: rejects an ecs platform", async () => {
    await expect(eksAct(ecsP, noCreds, "net-verify", { service: "dep" })).rejects.toThrow(/eks-only/i);
  });

  it("dry-run returns a plan describing the probe and makes no SSM calls", async () => {
    const r = await eksAct(p, noCreds, "net-verify", { service: "dep", dryRun: true });
    expect(ssm.calls()).toHaveLength(0);
    expect(r.dryRun).toBe(true);
    expect(r.plan?.awsCall).toBe("ssm:SendCommand");
    expect(r.plan?.params.probePod).toBe("chaos-probe-dep");
    expect(r.plan?.params.pings).toBe(20);
    expect(String(r.plan?.params.kubectl)).toContain("kubectl run chaos-probe-dep");
  });
});

describe("parsePingSummary", () => {
  it("reads loss% and avg rtt out of a busybox summary", () => {
    expect(parsePingSummary("20 packets transmitted, 11 packets received, 45% packet loss\nround-trip min/avg/max = 0.5/205.1/640.2 ms"))
      .toEqual({ lossPercent: 45, rttMs: 205.1 });
  });
  it("returns nulls for unparseable output", () => {
    expect(parsePingSummary("connection refused")).toEqual({ lossPercent: null, rttMs: null });
  });
  it("rttMs is null on total loss but loss% is still read", () => {
    expect(parsePingSummary("20 packets transmitted, 0 packets received, 100% packet loss"))
      .toEqual({ lossPercent: 100, rttMs: null });
  });
});
