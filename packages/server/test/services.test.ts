// packages/server/test/services.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { ECSClient, ListServicesCommand } from "@aws-sdk/client-ecs";
import bcrypt from "bcryptjs";
import { buildServer } from "../src/server.js";

const ecs = mockClient(ECSClient);
beforeEach(() => ecs.reset());
const users = [{ username: "v", passwordHash: bcrypt.hashSync("pw", 4), role: "viewer" as const }];
const platforms: any = [{ id: "mi", layer: "MI", kind: "ecs", region: "us-east-1", creds: { mode: "default" }, identifiers: { cluster: "c1" } }];
const catalog = { groups: { MI: { "notification-hub": ["nh_pub_pub"] } }, flows: {} };

async function login(app: any) {
  const r = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "v", password: "pw" } });
  return r.headers["set-cookie"];
}

describe("GET /api/platforms/:id/services", () => {
  it("returns live services joined with the catalog group, marking unmapped", async () => {
    ecs.on(ListServicesCommand).resolves({ serviceArns: ["a/c1/nh_pub_pub", "a/c1/orphan_svc"] });
    const app = buildServer({ platforms, users, jwtSecret: "t", catalog });
    const cookie = await login(app);
    const r = await app.inject({ method: "GET", url: "/api/platforms/mi/services", headers: { cookie } });
    expect(r.statusCode).toBe(200);
    const data = r.json().data;
    expect(data.find((s: any) => s.name === "nh_pub_pub")).toMatchObject({ mapped: true, group: "notification-hub" });
    expect(data.find((s: any) => s.name === "orphan_svc")).toMatchObject({ mapped: false, group: "Unmapped" });
  });
});
