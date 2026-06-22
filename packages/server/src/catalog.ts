// packages/server/src/catalog.ts
import type { ServiceStatus } from "@chaos/shared";
import type { Catalog } from "./server.js";
export function joinCatalog(svcs: ServiceStatus[], catalog: Catalog): ServiceStatus[] {
  return svcs.map((s) => {
    const groups = catalog.groups[s.layer] ?? {};
    const group = Object.keys(groups).find((g) => groups[g].includes(s.name));
    return group ? { ...s, mapped: true, group } : { ...s, mapped: false, group: "Unmapped" };
  });
}
