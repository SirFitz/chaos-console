// packages/server/test/audit.test.ts
import { describe, it, expect } from "vitest";
import { tmpdir } from "node:os"; import { join } from "node:path"; import { rmSync } from "node:fs";
import { SqliteAuditSink } from "../src/audit.js";
describe("SqliteAuditSink", () => {
  it("records and queries", () => {
    const f = join(tmpdir(), `chaos-audit-${Date.now()}.sqlite`);
    const sink = new SqliteAuditSink(f);
    const rec = sink.record({ user: "o", role: "operator", platform: "mi", action: "stop", target: "svc",
      params: { service: "svc" }, dryRun: false, confirm: true, result: "success", awsIdentity: "profile:x" });
    expect(rec.id).toBeTruthy(); expect(rec.ts).toBeTruthy();
    const rows = sink.query({ platform: "mi", limit: 10 });
    expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ user: "o", action: "stop", result: "success" });
    rmSync(f, { force: true });
  });
});
