// packages/web/test/auditText.test.ts
import { describe, it, expect } from "vitest";
import type { AuditRecord } from "@chaos/shared";
import { describeAuditAction } from "../src/lib/auditText.js";

const rec = (o: Partial<AuditRecord>): AuditRecord => ({
  id: "1", ts: "t", user: "o", role: "operator", platform: "mi",
  action: "start", target: "bps-payments-svc", params: {}, dryRun: false, confirm: false,
  result: "success", ...o,
});

describe("describeAuditAction", () => {
  it("renders a scale-up as 'scaled <svc> <from> -> <to>'", () => {
    expect(describeAuditAction(rec({ action: "start", params: { count: 3, from: 2 } }))).toBe(
      "scaled bps-payments-svc 2 → 3",
    );
  });

  it("renders a scale with only a count (no from) as 'scaled <svc> -> <to>'", () => {
    expect(describeAuditAction(rec({ action: "start", params: { count: 3 } }))).toBe(
      "scaled bps-payments-svc → 3",
    );
  });

  it("renders a scale-to-zero stop as 'scaled <svc> <from> -> 0 (stop)'", () => {
    expect(describeAuditAction(rec({ action: "stop", params: { from: 2, confirm: true } }))).toBe(
      "scaled bps-payments-svc 2 → 0 (stop)",
    );
  });

  it("leaves a plain start (no per-service count) as its raw action", () => {
    expect(describeAuditAction(rec({ action: "start", target: null, params: {} }))).toBe("start");
    // start-all carries no service target / count -> stays "start-all".
    expect(describeAuditAction(rec({ action: "start-all", target: "asg-x", params: {} }))).toBe("start-all");
  });

  it("leaves a plain stop (no `from`) as 'stop' — a drawer stop, not a scale", () => {
    expect(describeAuditAction(rec({ action: "stop", target: "bps-payments-svc", params: {} }))).toBe("stop");
    expect(describeAuditAction(rec({ action: "stop-all", target: "asg-x", params: {} }))).toBe("stop-all");
  });

  it("passes non-scaling actions straight through", () => {
    expect(describeAuditAction(rec({ action: "restart", params: {} }))).toBe("restart");
    expect(describeAuditAction(rec({ action: "net-loss", params: { loss: 40 } }))).toBe("net-loss");
  });
});
