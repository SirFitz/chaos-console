// packages/engine/test/eks-preflight.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { SSMClient, SendCommandCommand, GetCommandInvocationCommand } from "@aws-sdk/client-ssm";
import { eksAct, parsePreflight } from "../src/handlers/eks.js";

const ssm = mockClient(SSMClient);
beforeEach(() => ssm.reset());
const p: any = { id: "api", layer: "API", kind: "eks_ssm", region: "us-east-1",
  creds: { mode: "default" }, identifiers: { managerInstance: "i-1", namespace: "ns1" } };
const noCreds = () => undefined as any;
const cmd = () => (ssm.commandCalls(SendCommandCommand)[0].args[0].input as { Parameters?: { commands?: string[] } }).Parameters!.commands![0];

const assemble = (o: { apply: string; state: string; pods: string; cls: string }) =>
  ["PROBE_APPLY_BEGIN", o.apply, "PROBE_APPLY_END", o.state, "INGRESS_PODS_BEGIN", o.pods, "INGRESS_CLASS_BEGIN", o.cls].join("\n");

describe("parsePreflight", () => {
  it("reports ready pumba + healthy ingress when the probe runs and nginx is up", () => {
    const h = parsePreflight(assemble({
      apply: "pod/chaos-preflight created", state: "PROBE_STATE=Succeeded|",
      pods: "ingress-nginx-controller-abc 1/1 Running 0 5d", cls: "nginx=k8s.io/ingress-nginx ",
    }));
    expect(h.pumba).toMatchObject({ ready: true, state: "ready" });
    expect(h.ingress).toMatchObject({ present: true, healthy: true });
    expect(h.ingress.controller).toMatch(/nginx/);
  });
  it("flags privileged-blocked when PSA rejects the probe at apply time", () => {
    const h = parsePreflight(assemble({
      apply: 'Error from server (Forbidden): pods "chaos-preflight" is forbidden: violates PodSecurity "restricted:latest": privileged',
      state: "PROBE_STATE=|", pods: "ingress-nginx-controller-abc 1/1 Running", cls: "nginx=k8s.io/ingress-nginx ",
    }));
    expect(h.pumba).toMatchObject({ ready: false, state: "privileged-blocked" });
    expect(h.pumba.remediation).toMatch(/privileged|pod security/i);
  });
  it("flags image-unreachable when the probe can't pull the chaos image", () => {
    const h = parsePreflight(assemble({
      apply: "pod/chaos-preflight created", state: "PROBE_STATE=Pending|ImagePullBackOff",
      pods: "ingress-nginx-controller-abc 1/1 Running", cls: "nginx=k8s.io/ingress-nginx ",
    }));
    expect(h.pumba).toMatchObject({ ready: false, state: "image-unreachable" });
  });
  it("flags ingress absent (with remediation) when no controller / class exists", () => {
    const h = parsePreflight(assemble({
      apply: "pod/chaos-preflight created", state: "PROBE_STATE=Succeeded|",
      pods: "No resources found in ingress-nginx namespace.", cls: "",
    }));
    expect(h.pumba.ready).toBe(true);
    expect(h.ingress).toMatchObject({ present: false, healthy: false });
    expect(h.ingress.remediation).toMatch(/install ingress-nginx|net-loss/i);
  });
});

describe("eksAct net-preflight", () => {
  it("dry-run returns the probe + ingress script and makes no SSM calls", async () => {
    const r = await eksAct(p, noCreds, "net-preflight", { dryRun: true });
    expect(ssm.calls()).toHaveLength(0);
    const s = String(r.plan?.params.kubectl);
    expect(s).toContain("chaos-preflight");
    expect(s).toContain("ingress-nginx");
    expect(s).toContain("get ingressclass");
    // the probe manifest is embedded as base64; decode to confirm it's the privileged pod
    const manifest = Buffer.from(s.match(/echo (\S+) \| base64 -d/)![1], "base64").toString("utf8");
    expect(manifest).toContain("privileged: true");
  });
  it("uses the configured chaosImage in the probe pod", async () => {
    const r = await eksAct({ ...p, chaosImage: "jfrog.corp/pumba:1.2" }, noCreds, "net-preflight", { dryRun: true });
    const manifest = Buffer.from(String(r.plan?.params.kubectl).match(/echo (\S+) \| base64 -d/)![1], "base64").toString("utf8");
    expect(manifest).toContain("image: jfrog.corp/pumba:1.2");
  });
  it("reports manager-unreachable (does not throw) when SSM fails", async () => {
    ssm.on(SendCommandCommand).resolves({ Command: { CommandId: "c" } });
    ssm.on(GetCommandInvocationCommand).resolves({ Status: "Failed", StandardOutputContent: "", StandardErrorContent: "InstanceId i-1 is not in a valid state" });
    const r = await eksAct(p, noCreds, "net-preflight", {});
    expect((r.result as { pumba: { state: string } }).pumba.state).toBe("manager-unreachable");
    expect((r.result as { ingress: { present: boolean } }).ingress.present).toBe(false);
  });
});

describe("chaosImage override (config plumb)", () => {
  it("net-loss pumba manifest uses the configured chaosImage", async () => {
    ssm.on(SendCommandCommand).resolves({ Command: { CommandId: "c" } });
    ssm.on(GetCommandInvocationCommand).resolves({ Status: "Success", StandardOutputContent: "PUMBA_READY", StandardErrorContent: "" });
    await eksAct({ ...p, chaosBackend: "pumba", chaosImage: "jfrog.corp/pumba:9" }, noCreds, "net-loss", { service: "dep", loss: 10 });
    const m = Buffer.from(cmd().match(/echo (\S+) \|/)![1], "base64").toString("utf8");
    expect(m).toContain("image: jfrog.corp/pumba:9");
  });
});
