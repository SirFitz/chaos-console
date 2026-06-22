// packages/engine/test/errors.test.ts
import { describe, it, expect } from "vitest";
import { ChaosError, classifyKubectlError } from "../src/errors.js";

describe("classifyKubectlError", () => {
  const cases: Array<[string, string, RegExp]> = [
    ["Error from server (Forbidden): pods is forbidden: User cannot create resource \"pods\"",
      "RBAC_FORBIDDEN", /rbac|permission|forbidden/i],
    ["Back-off pulling image \"ghcr.io/alexei-led/pumba\"; ImagePullBackOff",
      "IMAGE_UNREACHABLE", /mirror|chaosImage|registry/i],
    ["failed to pull: pull access denied, manifest unknown",
      "IMAGE_UNREACHABLE", /mirror|chaosImage|registry/i],
    ["pods \"chaos-pumba-x\" is forbidden: violates PodSecurity \"restricted:latest\": privileged",
      "PRIVILEGED_BLOCKED", /privileged|pod security/i],
    ["Error from server (NotFound): deployments.apps \"svc\" not found",
      "NOT_FOUND", /not found|exist/i],
    ["GetCommandInvocation failed: InvocationDoesNotExist",
      "MANAGER_UNREACHABLE", /manager|ssm|agent/i],
    ["InstanceId i-0c97 is not in a valid state for account",
      "MANAGER_UNREACHABLE", /manager|ssm|agent/i],
    ["SSM command timed out",
      "MANAGER_UNREACHABLE", /manager|ssm|agent/i],
  ];
  it.each(cases)("maps %j to its code with a remediation", (stderr, code, re) => {
    const c = classifyKubectlError(new Error(stderr));
    expect(c.code).toBe(code);
    expect(c.message).toBeTruthy();
    expect(`${c.remediation ?? ""} ${c.message}`).toMatch(re);
  });
  it("passes a ChaosError through unchanged (already classified)", () => {
    const e = new ChaosError("NO_INGRESS", "no ingress fronts svc", "expose it or use net-loss");
    const c = classifyKubectlError(e);
    expect(c.code).toBe("NO_INGRESS");
    expect(c.message).toBe("no ingress fronts svc");
    expect(c.remediation).toBe("expose it or use net-loss");
  });
  it("classifies PodSecurity before the generic 'forbidden' it contains", () => {
    // the PSA message literally contains 'is forbidden'; must not be miscoded RBAC
    expect(classifyKubectlError(new Error("is forbidden: violates PodSecurity privileged")).code)
      .toBe("PRIVILEGED_BLOCKED");
  });
  it("accepts a raw string and falls back to UNKNOWN preserving the tail", () => {
    expect(classifyKubectlError("ImagePullBackOff").code).toBe("IMAGE_UNREACHABLE");
    const u = classifyKubectlError(new Error("some totally novel failure xyz"));
    expect(u.code).toBe("UNKNOWN");
    expect(u.message).toMatch(/novel failure xyz/);
  });
});
