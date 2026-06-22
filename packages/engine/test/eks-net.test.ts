// packages/engine/test/eks-net.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { SSMClient, SendCommandCommand, GetCommandInvocationCommand } from "@aws-sdk/client-ssm";
import { eksAct } from "../src/handlers/eks.js";

const ssm = mockClient(SSMClient);
beforeEach(() => ssm.reset());
const okSsm = () => {
  ssm.on(SendCommandCommand).resolves({ Command: { CommandId: "c" } });
  ssm.on(GetCommandInvocationCommand).resolves({ Status: "Success", StandardOutputContent: "PUMBA_READY", StandardErrorContent: "" });
};
const cmd = () => (ssm.commandCalls(SendCommandCommand)[0].args[0].input as { Parameters?: { commands?: string[] } }).Parameters!.commands![0];
const p: any = { id: "api", layer: "API", kind: "eks_ssm", region: "us-east-1", creds: { mode: "default" },
  identifiers: { managerInstance: "i-1", namespace: "ns1" }, restore: 2 };
const pPumba: any = { ...p, chaosBackend: "pumba" };
const noCreds = () => undefined as any;

describe("eksAct net-* (chaos-mesh default)", () => {
  it("net-loss applies a NetworkChaos manifest via base64|kubectl apply", async () => {
    okSsm();
    await eksAct(p, noCreds, "net-loss", { service: "dep", loss: 50 });
    const c = cmd();
    expect(c.startsWith("echo ")).toBe(true);
    expect(c.endsWith("| base64 -d | kubectl apply -f -")).toBe(true);
    const m = Buffer.from(c.split(" ")[1], "base64").toString("utf8");
    expect(m).toContain("kind: NetworkChaos");
    expect(m).toContain("name: chaos-nc-dep");
    expect(m).toContain("namespace: ns1");
    expect(m).toContain("action: loss");
    expect(m).toContain("mode: all");
    expect(m).toContain("direction: to");
    expect(m).toContain("app: dep");          // default label key
    expect(m).toContain('loss: "50"');
    expect(m).toContain('correlation: "0"');
  });
  it("net-partition forces loss 100", async () => {
    okSsm();
    await eksAct(p, noCreds, "net-partition", { service: "dep" });
    const m = Buffer.from(cmd().split(" ")[1], "base64").toString("utf8");
    expect(m).toContain("action: loss");
    expect(m).toContain('loss: "100"');
  });
  it("net-delay emits latency/jitter with the requested delay and direction", async () => {
    okSsm();
    await eksAct(p, noCreds, "net-delay", { service: "dep", delay: "300ms", direction: "both" });
    const m = Buffer.from(cmd().split(" ")[1], "base64").toString("utf8");
    expect(m).toContain("action: delay");
    expect(m).toContain('latency: "300ms"');
    expect(m).toContain('jitter: "0ms"');
    expect(m).toContain("direction: both");
  });
  it("net-delay defaults latency to 200ms", async () => {
    okSsm();
    await eksAct(p, noCreds, "net-delay", { service: "dep" });
    expect(Buffer.from(cmd().split(" ")[1], "base64").toString("utf8")).toContain('latency: "200ms"');
  });
  it("duration adds a quoted spec.duration", async () => {
    okSsm();
    await eksAct(p, noCreds, "net-loss", { service: "dep", duration: "5m" });
    expect(Buffer.from(cmd().split(" ")[1], "base64").toString("utf8")).toContain('duration: "5m"');
  });
  it("custom chaosLabel overrides the selector key", async () => {
    okSsm();
    await eksAct({ ...p, chaosLabel: "k8s-app" }, noCreds, "net-loss", { service: "dep" });
    expect(Buffer.from(cmd().split(" ")[1], "base64").toString("utf8")).toContain("k8s-app: dep");
  });
  it("net-clear deletes the NetworkChaos object and any L7 path overlay", async () => {
    okSsm();
    await eksAct(p, noCreds, "net-clear", { service: "dep" });
    expect(cmd()).toBe("kubectl delete networkchaos chaos-nc-dep -n ns1 --ignore-not-found; kubectl delete ingress,service,deployment -n ns1 -l chaos-overlay=path,chaos-service=dep --ignore-not-found");
  });
  it("net-status lists NetworkChaos plus any L7 path overlays", async () => {
    okSsm();
    await eksAct(p, noCreds, "net-status", {});
    expect(cmd()).toBe("kubectl get networkchaos -n ns1; echo '---CHAOS-PATHS---'; kubectl get ingress -n ns1 -l chaos-overlay=path --no-headers 2>/dev/null");
  });
  it("dry-run returns the manifest plan and makes no SSM calls", async () => {
    const r = await eksAct(p, noCreds, "net-loss", { service: "dep", dryRun: true });
    expect(ssm.calls()).toHaveLength(0);
    expect(r.dryRun).toBe(true);
    expect(r.plan?.awsCall).toBe("ssm:SendCommand");
    expect(String(r.plan?.params.manifest)).toContain("kind: NetworkChaos");
    expect(r.plan?.params.backend).toBe("chaos-mesh");
    expect(r.plan?.params.object).toBe("chaos-nc-dep");
  });
});

describe("eksAct net-* (pumba backend)", () => {
  it("net-loss applies a privileged pumba Pod", async () => {
    okSsm();
    await eksAct(pPumba, noCreds, "net-loss", { service: "dep", loss: 30 });
    const c = cmd();
    expect(c).toContain("kubectl delete pod chaos-pumba-dep -n ns1 --ignore-not-found"); // idempotent re-throttle
    const m = Buffer.from(c.match(/echo (\S+) \|/)![1], "base64").toString("utf8");
    expect(m).toContain("kind: Pod");
    expect(m).toContain("name: chaos-pumba-dep");
    expect(m).toContain("chaos-backend: pumba");
    expect(m).toContain("privileged: true");
    expect(m).toContain('"netem"');
    expect(m).toContain('"--percent=30"');
    expect(m).toContain('"re2:ns1/dep-.*"');
  });
  it("net-delay strips the ms suffix for pumba --time", async () => {
    okSsm();
    await eksAct(pPumba, noCreds, "net-delay", { service: "dep", delay: "250ms" });
    expect(Buffer.from(cmd().match(/echo (\S+) \|/)![1], "base64").toString("utf8")).toContain('"--time=250"');
  });
  it("net-loss confirms the pumba pod reached Ready on success", async () => {
    okSsm(); // okSsm resolves PUMBA_READY
    const r = await eksAct(pPumba, noCreds, "net-loss", { service: "dep", loss: 30 });
    expect(r.result?.ready).toBe(true);
  });
  it("net-loss surfaces an addressable error when the pumba pod can't start (image pull)", async () => {
    ssm.on(SendCommandCommand).resolves({ Command: { CommandId: "c" } });
    ssm.on(GetCommandInvocationCommand).resolves({ Status: "Success",
      StandardOutputContent: "PUMBA_NOT_READY\nImagePullBackOff: back-off pulling image phase=Pending", StandardErrorContent: "" });
    await expect(eksAct(pPumba, noCreds, "net-loss", { service: "dep", loss: 30 }))
      .rejects.toMatchObject({ code: "IMAGE_UNREACHABLE" });
  });
  it("net-clear deletes the pumba pod with a grace period and any L7 path overlay", async () => {
    okSsm();
    await eksAct(pPumba, noCreds, "net-clear", { service: "dep" });
    expect(cmd()).toBe("kubectl delete pod chaos-pumba-dep -n ns1 --ignore-not-found --grace-period=25; kubectl delete ingress,service,deployment -n ns1 -l chaos-overlay=path,chaos-service=dep --ignore-not-found");
  });
  it("net-status lists pumba pods plus any L7 path overlays", async () => {
    okSsm();
    await eksAct(pPumba, noCreds, "net-status", {});
    expect(cmd()).toBe("kubectl get pods -n ns1 -l chaos-backend=pumba; echo '---CHAOS-PATHS---'; kubectl get ingress -n ns1 -l chaos-overlay=path --no-headers 2>/dev/null");
  });
});

describe("eksAct net-* validation", () => {
  it("net-loss requires a service", async () => {
    await expect(eksAct(p, noCreds, "net-loss", {})).rejects.toThrow(/requires a service/i);
  });
  it("an unknown chaos backend is rejected", async () => {
    await expect(eksAct({ ...p, chaosBackend: "bogus" } as any, noCreds, "net-loss", { service: "dep" }))
      .rejects.toThrow(/unknown chaos backend/i);
  });
});
