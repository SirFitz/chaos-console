// packages/web/src/lib/actions.ts
import { isDestructive, type ActionName, type Kind } from "@chaos/shared";

// These are the things an operator *does* from the drawer. `net-status` is a
// read, not an action — it is deliberately excluded here because the live
// Active Chaos panel already discovers and polls network status. The engine
// still supports net-status (via the action route + /api/chaos/active); it is
// simply not a selectable drawer action. `net-preflight` is likewise a read
// (it backs the backend-health chip), so it is never a drawer action either.
//
// The net-path-* actions are L7 (ingress-nginx) chaos and are EKS-only — ECS
// has no ingress controller to overlay.
const EKS_ACTIONS: ActionName[] = [
  "stop", "start", "restart", "stop-all", "start-all",
  "net-loss", "net-delay", "net-partition", "net-clear",
  "net-path-cut", "net-path-degrade", "net-path-clear",
];
const ECS_ACTIONS: ActionName[] = [
  "stop", "start", "restart",
  "net-block", "net-clear",
];

export function actionsForKind(kind: Kind): ActionName[] {
  return kind === "eks_ssm" ? EKS_ACTIONS : ECS_ACTIONS;
}

export function needsConfirm(action: ActionName): boolean {
  return isDestructive(action);
}
