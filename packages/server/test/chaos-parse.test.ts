// packages/server/test/chaos-parse.test.ts
import { describe, it, expect } from "vitest";
import { summarizeNetStatus } from "../src/chaos.js";

describe("summarizeNetStatus · ECS (subnet NACL)", () => {
  it("empty entries => no active chaos", () => {
    const items = summarizeNetStatus("ecs", { rule: 1, nacls: ["acl-1", "acl-2"], entries: [] });
    expect(items).toEqual([]);
  });

  it("non-empty entries => one plain line per ACL naming the blocked CIDR", () => {
    const items = summarizeNetStatus("ecs", {
      rule: 1,
      nacls: ["acl-1"],
      entries: [
        { nacl: "acl-1", cidr: "203.0.113.10/32", egress: true, action: "deny" },
        { nacl: "acl-1", cidr: "203.0.113.10/32", egress: false, action: "deny" },
      ],
    });
    expect(items).toHaveLength(1);
    expect(items[0].summary).toBe("Blocking 203.0.113.10/32 on subnet ACL acl-1");
    expect(items[0].backend).toBe("Subnet ACL");
  });

  it("multiple CIDRs on one ACL read as a list", () => {
    const items = summarizeNetStatus("ecs", {
      rule: 1, nacls: ["acl-1"],
      entries: [
        { nacl: "acl-1", cidr: "203.0.113.10/32" },
        { nacl: "acl-1", cidr: "198.51.100.0/24" },
      ],
    });
    expect(items).toHaveLength(1);
    expect(items[0].summary).toBe("Blocking 203.0.113.10/32 and 198.51.100.0/24 on subnet ACL acl-1");
  });

  it("entries spanning two ACLs produce two lines", () => {
    const items = summarizeNetStatus("ecs", {
      rule: 1, nacls: ["acl-1", "acl-2"],
      entries: [
        { nacl: "acl-1", cidr: "203.0.113.10/32" },
        { nacl: "acl-2", cidr: "203.0.113.10/32" },
      ],
    });
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.summary)).toEqual([
      "Blocking 203.0.113.10/32 on subnet ACL acl-1",
      "Blocking 203.0.113.10/32 on subnet ACL acl-2",
    ]);
  });

  it("a null/odd result is treated as no chaos", () => {
    expect(summarizeNetStatus("ecs", null)).toEqual([]);
    expect(summarizeNetStatus("ecs", { rule: 1 })).toEqual([]);
  });
});

describe("summarizeNetStatus · EKS (kubectl text)", () => {
  it("Chaos Mesh NetworkChaos rows => per-service summary with fault type + age", () => {
    const output = [
      "NAME          ACTION   DURATION   AGE",
      "chaos-nc-payments   loss      30s        113m",
      "chaos-nc-ledger     delay                 4m",
    ].join("\n");
    const items = summarizeNetStatus("eks_ssm", { output });
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ service: "payments", backend: "Chaos Mesh" });
    expect(items[0].summary).toBe("payments · packet loss injected (Chaos Mesh), active 113m");
    expect(items[1].summary).toBe("ledger · latency injected (Chaos Mesh), active 4m");
  });

  it("Pumba pod rows => active when Running, names the service + age", () => {
    const output = [
      "NAME                  READY   STATUS    RESTARTS   AGE",
      "chaos-pumba-payments   1/1     Running   0          113m",
    ].join("\n");
    const items = summarizeNetStatus("eks_ssm", { output });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ service: "payments", backend: "Pumba" });
    expect(items[0].summary).toBe("payments · network fault injected (Pumba), active 113m");
  });

  it("a Completed/terminating Pumba pod is not counted as active", () => {
    const output = [
      "NAME                  READY   STATUS      RESTARTS   AGE",
      "chaos-pumba-payments   0/1     Completed   0          5m",
      "chaos-pumba-ledger     1/1     Running     0          2m",
    ].join("\n");
    const items = summarizeNetStatus("eks_ssm", { output });
    expect(items).toHaveLength(1);
    expect(items[0].service).toBe("ledger");
  });

  it('"No resources found" / header-only => no chaos', () => {
    expect(summarizeNetStatus("eks_ssm", { output: "No resources found in ns1 namespace." })).toEqual([]);
    expect(summarizeNetStatus("eks_ssm", { output: "NAME   ACTION   AGE" })).toEqual([]);
    expect(summarizeNetStatus("eks_ssm", { output: "" })).toEqual([]);
  });

  it("ignores unrelated rows that are not chaos objects", () => {
    const output = [
      "NAME            READY   STATUS    RESTARTS   AGE",
      "some-other-pod  1/1     Running   0          9d",
      "chaos-pumba-api  1/1     Running   0          1m",
    ].join("\n");
    const items = summarizeNetStatus("eks_ssm", { output });
    expect(items).toHaveLength(1);
    expect(items[0].service).toBe("api");
  });

  it("tolerates a name-only row (no age column)", () => {
    const items = summarizeNetStatus("eks_ssm", { output: "NAME\nchaos-nc-api" });
    expect(items).toHaveLength(1);
    expect(items[0].summary).toBe("api · network fault injected (Chaos Mesh)");
  });

  it("surfaces L7 path overlays listed after the marker, alongside L4 chaos", () => {
    const output = [
      "chaos-pumba-payments   1/1   Running   0   3m",
      "---CHAOS-PATHS---",
      "chaos-path-charge-ab12cd   nginx   api.example   10.0.0.1   80   2m",
    ].join("\n");
    const items = summarizeNetStatus("eks_ssm", { output });
    expect(items).toHaveLength(2);
    const path = items.find((i) => i.backend === "ingress-nginx");
    expect(path?.service).toBe("charge");
    expect(path?.summary).toContain("path fault injected (ingress-nginx)");
  });
});
