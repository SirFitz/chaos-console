// packages/engine/test/eks-path.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { SSMClient, SendCommandCommand, GetCommandInvocationCommand } from "@aws-sdk/client-ssm";
import { eksAct } from "../src/handlers/eks.js";

const ssm = mockClient(SSMClient);
beforeEach(() => ssm.reset());
const p: any = { id: "api", layer: "API", kind: "eks_ssm", region: "us-east-1",
  creds: { mode: "default" }, identifiers: { managerInstance: "i-1", namespace: "ns1" } };
const noCreds = () => undefined as any;
function ssmReturns(stdout: string) {
  ssm.on(SendCommandCommand).resolves({ Command: { CommandId: "c" } });
  ssm.on(GetCommandInvocationCommand).resolves({ Status: "Success", StandardOutputContent: stdout, StandardErrorContent: "" });
}
const ingressJson = (ns = "ns1") => JSON.stringify({ items: [
  { metadata: { name: "charge-ing", namespace: ns }, spec: { ingressClassName: "nginx", rules: [
    { host: "api.example", http: { paths: [
      { path: "/charge", pathType: "Prefix", backend: { service: { name: "charge", port: { number: 8080 } } } },
    ] } },
  ] } },
] });

describe("eksAct net-path-* (ingress-nginx canary overlay)", () => {
  it("net-path-cut (dry-run) builds a canary (weight 100) -> a 503 sink Deployment, never editing the real ingress", async () => {
    ssmReturns(ingressJson());
    const r = await eksAct(p, noCreds, "net-path-cut", { service: "charge", dryRun: true });
    expect(r.dryRun).toBe(true);
    const m = String(r.plan?.params.manifest);
    expect(m).toContain("kind: Deployment");                                // the 503 sink (must have endpoints)
    expect(m).toContain("image: nginx:alpine");
    expect(m).toContain("return 503");
    expect(m).toContain("kind: Service");
    expect(m).toContain("name: chaos-sink-charge");
    expect(m).toContain("kind: Ingress");                                   // the canary overlay
    expect(m).toContain('nginx.ingress.kubernetes.io/canary: "true"');
    expect(m).toContain('nginx.ingress.kubernetes.io/canary-weight: "100"');
    expect(m).toContain("host: api.example");
    expect(m).toContain("path: /charge");
    expect(m).toContain("ingressClassName: nginx");
    expect(m).toMatch(/name: chaos-sink-charge\n\s+port/);                  // canary points at the sink
    expect(r.plan?.params.mode).toBe("cut");
    expect(ssm.commandCalls(SendCommandCommand)).toHaveLength(1);           // only discovery; nothing applied
  });
  it("net-path-degrade (dry-run) sends a percentage of the path to the 503 sink (canary weight = loss%)", async () => {
    ssmReturns(ingressJson());
    const r = await eksAct(p, noCreds, "net-path-degrade", { service: "charge", loss: 30, dryRun: true });
    const m = String(r.plan?.params.manifest);
    expect(m).toContain("kind: Deployment");
    expect(m).toContain("name: chaos-sink-charge");
    expect(m).toContain('nginx.ingress.kubernetes.io/canary-weight: "30"'); // partial outage
    expect(m).not.toContain("limit-rps");                                   // limit-rps is ignored on canary (validated live)
    expect(r.plan?.params.mode).toBe("degrade");
  });
  it("net-path-clear (dry-run) deletes overlay objects (incl. the sink Deployment) by label, needing no discovery", async () => {
    const r = await eksAct(p, noCreds, "net-path-clear", { service: "charge", dryRun: true });
    expect(r.plan?.params.kubectl).toBe(
      "kubectl delete ingress,service,deployment -n ns1 -l chaos-overlay=path,chaos-service=charge --ignore-not-found");
    expect(ssm.calls()).toHaveLength(0);
  });
  it("refuses (addressably) when the ingress is in a different namespace than configured", async () => {
    ssmReturns(ingressJson("other-ns"));
    await expect(eksAct(p, noCreds, "net-path-cut", { service: "charge", dryRun: true }))
      .rejects.toMatchObject({ code: "OVERLAY_FAILED" });
  });
  it("filters to a specific path when one is given", async () => {
    ssmReturns(ingressJson());
    const r = await eksAct(p, noCreds, "net-path-cut", { service: "charge", path: "/charge", dryRun: true });
    expect(r.plan?.params.paths).toEqual([{ host: "api.example", path: "/charge" }]);
  });
});
