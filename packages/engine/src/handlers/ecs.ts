// packages/engine/src/handlers/ecs.ts
import { ECSClient, ListServicesCommand, DescribeServicesCommand, UpdateServiceCommand, ListTasksCommand, DescribeTasksCommand, StopTaskCommand } from "@aws-sdk/client-ecs";
import { EC2Client, DescribeNetworkAclsCommand, CreateNetworkAclEntryCommand, DeleteNetworkAclEntryCommand } from "@aws-sdk/client-ec2";
import type { AwsCredentialIdentityProvider } from "@aws-sdk/types";
import type { PlatformConfig, ServiceStatus, EcsIdentifiers, ActionName, ActionOutcome, ActionRequest } from "@chaos/shared";

export type CredFactory = (p: PlatformConfig) => AwsCredentialIdentityProvider;

const CIDR_RE = /^[0-9]{1,3}(\.[0-9]{1,3}){3}\/[0-9]{1,2}$/;
const NET_ACTIONS = ["net-block", "net-clear", "net-status"] as const;

export async function ecsStatus(p: PlatformConfig, creds: CredFactory, service?: string): Promise<ServiceStatus[]> {
  const cluster = (p.identifiers as EcsIdentifiers).cluster;
  const client = new ECSClient({ region: p.region, credentials: creds(p) });
  if (service) {
    const r = await client.send(new DescribeServicesCommand({ cluster, services: [service] }));
    return (r.services ?? []).map((s) => ({
      platformId: p.id, layer: p.layer, name: s.serviceName ?? service, mapped: false,
      desired: s.desiredCount, running: s.runningCount, pending: s.pendingCount, state: s.status, raw: s }));
  }
  const r = await client.send(new ListServicesCommand({ cluster }));
  const arns = r.serviceArns ?? [];
  if (arns.length === 0) return [];
  // DescribeServices caps at 10 services per call; chunk and merge counts back by name.
  const byName = new Map<string, { desired?: number; running?: number; pending?: number; state?: string; raw?: unknown }>();
  for (let i = 0; i < arns.length; i += 10) {
    const chunk = arns.slice(i, i + 10);
    const d = await client.send(new DescribeServicesCommand({ cluster, services: chunk }));
    for (const s of d?.services ?? [])
      if (s.serviceName)
        byName.set(s.serviceName, { desired: s.desiredCount, running: s.runningCount, pending: s.pendingCount, state: s.status, raw: s });
  }
  return arns.map((arn) => {
    const name = arn.split("/").pop() ?? arn;
    return { platformId: p.id, layer: p.layer, name, mapped: false, ...(byName.get(name) ?? {}) };
  });
}

export async function ecsAct(p: PlatformConfig, creds: CredFactory, action: ActionName, req: ActionRequest): Promise<ActionOutcome> {
  if ((NET_ACTIONS as readonly string[]).includes(action)) return ecsNetAct(p, creds, action, req);
  const cluster = (p.identifiers as EcsIdentifiers).cluster;
  if (action === "stop-all" || action === "start-all") throw new Error(`'${action}' is not supported for ecs platform '${p.id}' (target services individually)`);
  const svc = req.service;
  if (!svc) throw new Error(`action '${action}' requires a service`);
  const dryRun = !!req.dryRun;
  const client = () => new ECSClient({ region: p.region, credentials: creds(p) });
  if (action === "stop" || action === "start") {
    const desired = action === "stop" ? 0 : (req.count ?? p.restore ?? 1);
    const params = { cluster, service: svc, desiredCount: desired };
    if (dryRun) return { action, target: svc, dryRun: true, plan: { awsCall: "ecs:UpdateService", params } };
    const r = await client().send(new UpdateServiceCommand(params));
    return { action, target: svc, dryRun: false, result: { desiredCount: r.service?.desiredCount ?? desired } };
  }
  if (action === "restart") {
    if (dryRun) return { action, target: svc, dryRun: true, plan: { awsCall: "ecs:StopTask", params: { cluster, service: svc } } };
    const c = client();
    const t = await c.send(new ListTasksCommand({ cluster, serviceName: svc, desiredStatus: "RUNNING" }));
    const task = t.taskArns?.[0];
    if (!task) throw new Error(`no running task found for ${svc}`);
    await c.send(new StopTaskCommand({ cluster, task, reason: "chaos-console transient restart" }));
    return { action, target: svc, dryRun: false, result: { stoppedTask: task } };
  }
  throw new Error(`unknown action '${action}' for ecs`);
}

// 1:1 port of ecs_cluster_nacls(): RUNNING tasks → their subnetIds → the NACL guarding each.
async function clusterNacls(p: PlatformConfig, creds: CredFactory): Promise<string[]> {
  const cluster = (p.identifiers as EcsIdentifiers).cluster;
  const ecs = new ECSClient({ region: p.region, credentials: creds(p) });
  const ec2 = new EC2Client({ region: p.region, credentials: creds(p) });
  const t = await ecs.send(new ListTasksCommand({ cluster, desiredStatus: "RUNNING" }));
  const taskArns = t.taskArns ?? [];
  if (taskArns.length === 0) return [];
  const d = await ecs.send(new DescribeTasksCommand({ cluster, tasks: taskArns }));
  const subnets = new Set<string>();
  for (const task of d.tasks ?? [])
    for (const att of task.attachments ?? [])
      for (const det of att.details ?? [])
        if (det.name === "subnetId" && det.value) subnets.add(det.value);
  const nacls = new Set<string>();
  for (const subnet of subnets) {
    const r = await ec2.send(new DescribeNetworkAclsCommand({ Filters: [{ Name: "association.subnet-id", Values: [subnet] }] }));
    const id = r.NetworkAcls?.[0]?.NetworkAclId;
    if (id) nacls.add(id);
  }
  return [...nacls];
}

// 1:1 port of the net-block|net-clear|net-status cases in run_ecs(): subnet-NACL deny.
async function ecsNetAct(p: PlatformConfig, creds: CredFactory, action: ActionName, req: ActionRequest): Promise<ActionOutcome> {
  const rule = p.naclRule ?? 1;
  const dryRun = !!req.dryRun;
  const ec2 = () => new EC2Client({ region: p.region, credentials: creds(p) });

  if (action === "net-block") {
    const cidr = req.cidr;
    if (!cidr) throw new Error(`action 'net-block' requires a cidr (target to blackhole, e.g. 203.0.113.10/32)`);
    if (cidr === "0.0.0.0/0") throw new Error(`refusing 0.0.0.0/0 — that cuts the cluster's own traffic; use a specific target CIDR`);
    if (!CIDR_RE.test(cidr)) throw new Error(`invalid cidr '${cidr}' (expected A.B.C.D/len)`);
    const nacls = await clusterNacls(p, creds);
    if (nacls.length === 0) throw new Error(`could not find NACLs for the cluster's task subnets (any running tasks?)`);
    if (dryRun) return { action, target: cidr, dryRun: true, plan: { awsCall: "ec2:CreateNetworkAclEntry", params: { nacls, rule, cidr, egress: [true, false], protocol: "-1", action: "deny" } } };
    const c = ec2();
    for (const naclId of nacls)
      for (const egress of [true, false]) {
        await c.send(new DeleteNetworkAclEntryCommand({ NetworkAclId: naclId, RuleNumber: rule, Egress: egress })).catch(() => undefined);
        await c.send(new CreateNetworkAclEntryCommand({ NetworkAclId: naclId, RuleNumber: rule, Protocol: "-1", RuleAction: "deny", Egress: egress, CidrBlock: cidr }));
      }
    return { action, target: cidr, dryRun: false, result: { nacls, rule } };
  }

  if (action === "net-clear") {
    const nacls = await clusterNacls(p, creds);
    if (dryRun) return { action, target: null, dryRun: true, plan: { awsCall: "ec2:DeleteNetworkAclEntry", params: { nacls, rule, egress: [true, false] } } };
    const c = ec2();
    for (const naclId of nacls)
      for (const egress of [true, false])
        await c.send(new DeleteNetworkAclEntryCommand({ NetworkAclId: naclId, RuleNumber: rule, Egress: egress })).catch(() => undefined);
    return { action, target: null, dryRun: false, result: { nacls, rule } };
  }

  // net-status
  const nacls = await clusterNacls(p, creds);
  if (dryRun) return { action, target: null, dryRun: true, plan: { awsCall: "ec2:DescribeNetworkAcls", params: { nacls, rule } } };
  const c = ec2();
  const entries: Array<{ nacl: string; rule?: number; egress?: boolean; action?: string; cidr?: string; protocol?: string }> = [];
  for (const naclId of nacls) {
    const r = await c.send(new DescribeNetworkAclsCommand({ NetworkAclIds: [naclId] }));
    for (const e of r.NetworkAcls?.[0]?.Entries ?? [])
      if (e.RuleNumber === rule)
        entries.push({ nacl: naclId, rule: e.RuleNumber, egress: e.Egress, action: e.RuleAction, cidr: e.CidrBlock, protocol: e.Protocol });
  }
  return { action, target: null, dryRun: false, result: { rule, nacls, entries } };
}
