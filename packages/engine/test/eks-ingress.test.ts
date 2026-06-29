// packages/engine/test/eks-ingress.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { SSMClient, SendCommandCommand, GetCommandInvocationCommand } from "@aws-sdk/client-ssm";
import { discoverPathTargets } from "../src/handlers/eks.js";

const ssm = mockClient(SSMClient);
beforeEach(() => ssm.reset());
const p: any = { id: "api", layer: "API", kind: "eks_ssm", region: "us-east-1",
  creds: { mode: "default" }, identifiers: { managerInstance: "i-1", namespace: "ns1" } };
const noCreds = () => undefined as any;
function ssmReturns(stdout: string) {
  ssm.on(SendCommandCommand).resolves({ Command: { CommandId: "c" } });
  ssm.on(GetCommandInvocationCommand).resolves({ Status: "Success", StandardOutputContent: stdout, StandardErrorContent: "" });
}
const cmd = () => (ssm.commandCalls(SendCommandCommand)[0].args[0].input as { Parameters?: { commands?: string[] } }).Parameters!.commands![0];

const ingressJson = JSON.stringify({ items: [
  { metadata: { name: "charge-ing", namespace: "ns1" }, spec: { rules: [
    { host: "api.example", http: { paths: [
      { path: "/charge", pathType: "Prefix", backend: { service: { name: "charge", port: { number: 80 } } } },
      { path: "/health", pathType: "Prefix", backend: { service: { name: "other", port: { number: 80 } } } },
    ] } },
  ] } },
  // legacy extensions/v1beta1 shape: backend.serviceName instead of backend.service.name
  { metadata: { name: "legacy-ing", namespace: "ns2" }, spec: { rules: [
    { host: "old.example", http: { paths: [ { path: "/charge", backend: { serviceName: "charge" } } ] } },
  ] } },
] });

describe("discoverPathTargets", () => {
  it("returns every ingress path whose backend is the service (v1 + legacy shapes)", async () => {
    ssmReturns(ingressJson);
    const t = await discoverPathTargets(p, noCreds, "charge");
    expect(t).toHaveLength(2);
    expect(t[0]).toMatchObject({ service: "charge", host: "api.example", path: "/charge", pathType: "Prefix", ingress: "charge-ing", ingressNamespace: "ns1" });
    expect(t[1]).toMatchObject({ host: "old.example", path: "/charge", ingress: "legacy-ing", ingressNamespace: "ns2" });
    expect(t.some((x) => x.path === "/health")).toBe(false); // that path routes to 'other'
  });
  it("queries the cluster-wide ingress list as JSON", async () => {
    ssmReturns(ingressJson);
    await discoverPathTargets(p, noCreds, "charge");
    expect(cmd()).toContain("kubectl get ingress -A -o json");
  });
  it("throws an addressable NO_INGRESS when nothing routes to the service", async () => {
    ssmReturns(ingressJson);
    await expect(discoverPathTargets(p, noCreds, "nope")).rejects.toMatchObject({ code: "NO_INGRESS" });
  });
});
