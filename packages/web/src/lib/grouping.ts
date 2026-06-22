// packages/web/src/lib/grouping.ts
import { LAYERS, type Layer, type ServiceStatus } from "@chaos/shared";

export const UNMAPPED = "Unmapped";

export interface GroupBucket {
  group: string;
  services: ServiceStatus[];
}
export interface LayerBucket {
  layer: Layer;
  groups: GroupBucket[];
}

export function matchesFilter(s: ServiceStatus, q: string): boolean {
  if (!q) return true;
  const needle = q.toLowerCase();
  return [s.name, s.group ?? "", s.flow ?? ""].some((v) => v.toLowerCase().includes(needle));
}

export function groupByLayerAndGroup(rows: ServiceStatus[]): LayerBucket[] {
  const out: LayerBucket[] = [];
  for (const layer of LAYERS) {
    const inLayer = rows.filter((r) => r.layer === layer);
    if (inLayer.length === 0) continue;
    const byGroup = new Map<string, ServiceStatus[]>();
    for (const r of inLayer) {
      const key = r.mapped && r.group ? r.group : UNMAPPED;
      const bucket = byGroup.get(key) ?? [];
      bucket.push(r);
      byGroup.set(key, bucket);
    }
    const groups = [...byGroup.entries()]
      .sort(([a], [b]) => {
        if (a === UNMAPPED) return 1;
        if (b === UNMAPPED) return -1;
        return a.localeCompare(b);
      })
      .map(([group, services]) => ({
        group,
        services: [...services].sort((x, y) => x.name.localeCompare(y.name)),
      }));
    out.push({ layer, groups });
  }
  return out;
}
