// packages/web/src/lib/chaos.ts
//
// The server now summarizes each platform's net-status into plain-language
// `items` + an `active` flag (see packages/server/src/chaos.ts). These helpers
// just read that summarized shape — the UI stays dumb.
import type { ChaosActive } from "../api.js";

/** Whether a platform currently has live chaos. */
export function isChaosActive(row: ChaosActive): boolean {
  return !row.error && row.active;
}

/** Count of platforms with live chaos (drives the nav badge). */
export function activeChaosCount(rows: ChaosActive[] | undefined): number {
  if (!rows) return 0;
  return rows.reduce((n, r) => n + (isChaosActive(r) ? 1 : 0), 0);
}
