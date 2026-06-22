import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type { AuditRecord } from "@chaos/shared";

export interface AuditSink {
  record(rec: Omit<AuditRecord, "id" | "ts">): AuditRecord;
  query(filter: { platform?: string; user?: string; limit?: number }): AuditRecord[];
}
export class SqliteAuditSink implements AuditSink {
  private db: Database.Database;
  constructor(file: string) {
    this.db = new Database(file);
    this.db.exec(`CREATE TABLE IF NOT EXISTS audit (id TEXT PRIMARY KEY, ts TEXT, user TEXT, role TEXT,
      platform TEXT, action TEXT, target TEXT, params TEXT, dryRun INTEGER, confirm INTEGER,
      result TEXT, error TEXT, awsIdentity TEXT)`);
  }
  // new Date() is fine in implementation code (the no-Date.now() rule applies to workflow scripts, not app code).
  record(r: Omit<AuditRecord, "id" | "ts">): AuditRecord {
    const full: AuditRecord = { ...r, id: randomUUID(), ts: new Date().toISOString() };
    this.db.prepare(`INSERT INTO audit VALUES (@id,@ts,@user,@role,@platform,@action,@target,@params,@dryRun,@confirm,@result,@error,@awsIdentity)`)
      .run({ ...full, target: full.target ?? null, params: JSON.stringify(full.params), dryRun: full.dryRun ? 1 : 0,
        confirm: full.confirm ? 1 : 0, error: full.error ?? null, awsIdentity: full.awsIdentity ?? null });
    return full;
  }
  query(f: { platform?: string; user?: string; limit?: number }): AuditRecord[] {
    const where: string[] = []; const args: Record<string, unknown> = {};
    if (f.platform) { where.push("platform=@platform"); args.platform = f.platform; }
    if (f.user) { where.push("user=@user"); args.user = f.user; }
    const sql = `SELECT * FROM audit ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY ts DESC LIMIT @limit`;
    args.limit = f.limit ?? 100;
    return (this.db.prepare(sql).all(args) as Record<string, unknown>[]).map((row) => ({ ...row, params: JSON.parse(row.params as string),
      dryRun: !!row.dryRun, confirm: !!row.confirm } as AuditRecord));
  }
}
