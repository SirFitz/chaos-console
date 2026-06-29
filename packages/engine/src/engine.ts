// packages/engine/src/engine.ts
import type { PlatformConfig, ServiceStatus, EcsIdentifiers, EksIdentifiers, ActionName, ActionOutcome, ActionRequest, ExecResult } from "@chaos/shared";
import { resolveCredentials } from "./credentials.js";
import { ecsStatus, ecsAct, type CredFactory } from "./handlers/ecs.js";
import { eksStatus, eksAct, execOnManager } from "./handlers/eks.js";

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

export class Engine {
  constructor(private platforms: PlatformConfig[]) {}
  private creds: CredFactory = (p) => resolveCredentials(p.creds, p.region);
  private get(id: string): PlatformConfig {
    const p = this.platforms.find((x) => x.id === id);
    if (!p) throw new Error(`unknown platform '${id}'`);
    return p;
  }
  listPlatforms() {
    return this.platforms.map((p) => ({ id: p.id, layer: p.layer, kind: p.kind, region: p.region,
      ...(p.kind === "ecs" ? { cluster: (p.identifiers as EcsIdentifiers).cluster }
        : { managerInstance: (p.identifiers as EksIdentifiers).managerInstance,
            namespace: (p.identifiers as EksIdentifiers).namespace }) }));
  }
  async status(id: string, service?: string): Promise<ServiceStatus[]> {
    const p = this.get(id);
    return p.kind === "ecs" ? ecsStatus(p, this.creds, service) : eksStatus(p, this.creds, service);
  }
  async act(id: string, action: ActionName, req: ActionRequest): Promise<ActionOutcome> {
    const p = this.get(id);
    if (req.service !== undefined && !NAME_RE.test(req.service)) throw new Error(`invalid service name '${req.service}'`);
    const eksOnly = ["net-loss", "net-delay", "net-partition", "net-verify",
      "net-probe-start", "net-probe-tail", "net-probe-stop"];
    const ecsOnly = ["net-block"];
    if (p.kind === "ecs" && eksOnly.includes(action)) throw new Error(`action '${action}' is not supported for ecs platform '${id}' (eks-only packet chaos)`);
    if (p.kind === "eks_ssm" && ecsOnly.includes(action)) throw new Error(`action '${action}' is not supported for eks platform '${id}' (use net-loss/net-partition instead)`);
    return p.kind === "ecs" ? ecsAct(p, this.creds, action, req) : eksAct(p, this.creds, action, req);
  }
  /** Run a free-text command on an eks_ssm platform's manager box over SSM (the terminal). */
  async exec(id: string, command: string, timeoutMs = 60_000): Promise<ExecResult> {
    const p = this.get(id);
    if (p.kind !== "eks_ssm") throw new Error(`platform '${id}' has no manager box (terminal is for eks_ssm platforms)`);
    return execOnManager(p, this.creds, command, timeoutMs);
  }
  platformIds(): string[] {
    return this.platforms.map((p) => p.id);
  }
  describeCreds(id: string): string {
    const c = this.get(id).creds;
    return c.mode === "profile" ? `profile:${c.profile}` : c.mode === "assumeRole" ? `assumeRole:${c.roleArn}` : "default";
  }
}
