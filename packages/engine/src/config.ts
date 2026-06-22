// packages/engine/src/config.ts
import { z } from "zod";
import type { PlatformConfig } from "@chaos/shared";

const creds = z.object({
  mode: z.enum(["assumeRole", "profile", "default"]),
  roleArn: z.string().optional(), profile: z.string().optional(), externalId: z.string().optional(),
}).refine((c) => c.mode !== "assumeRole" || !!c.roleArn, { message: "creds.roleArn required when mode=assumeRole" })
  .refine((c) => c.mode !== "profile" || !!c.profile, { message: "creds.profile required when mode=profile" });

const ecsId = z.object({ cluster: z.string({ required_error: "identifiers.cluster required" }).min(1, "identifiers.cluster required") });
const eksId = z.object({ managerInstance: z.string().min(1), namespace: z.string().min(1),
  asg: z.string().optional(), asgRestoreCap: z.number().int().optional() });

const platform = z.object({
  id: z.string().min(1), layer: z.enum(["API", "MI", "RULES"]),
  kind: z.enum(["eks_ssm", "ecs"]), region: z.string().min(1), creds,
  identifiers: z.unknown(), restore: z.number().int().optional(),
  chaosBackend: z.enum(["chaos-mesh", "pumba"]).optional(), chaosLabel: z.string().optional(),
  naclRule: z.number().int().optional(),
}).superRefine((p, ctx) => {
  const r = (p.kind === "ecs" ? ecsId : eksId).safeParse(p.identifiers);
  if (!r.success) ctx.addIssue({ code: "custom", message: r.error.issues.map((i) => i.message).join("; ") });
});

export function parsePlatforms(input: unknown): PlatformConfig[] {
  return z.array(platform).parse(input) as PlatformConfig[];
}
