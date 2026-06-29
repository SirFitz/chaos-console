# Chaos Console

A deployed, authenticated, audited web console for running controlled chaos against your services across three AWS layers — one **EKS/API** layer (driven via SSM → `kubectl`) and two **ECS** layers (labelled `MI` and `RULES` by default; rename freely). Operators can **scale** services up/down, **restart**, **stop-all/start-all**, and inject **packet chaos** (ECS NACL block; EKS packet **loss / delay / partition** via Chaos Mesh or Pumba) — each with dry-run, server-enforced confirmation, RBAC, and a full audit trail.

One TypeScript monorepo, one Docker image: a Fastify backend (engine + JSON API) that also serves the React SPA. The host is just configuration.

## Packages

| Package | Role |
| --- | --- |
| `@chaos/shared` | DTOs + `ok()`/`fail()` API-envelope helpers shared by engine and server. |
| `@chaos/engine` | Framework-agnostic library: config loader, pluggable credential provider, and the `ecs` + `eks_ssm` handlers (status, scale, restart, stop-all, packet chaos) on AWS SDK v3. |
| `@chaos/server` | Fastify app: local auth (JWT cookie) + RBAC, read routes that join live state with the static catalog, guarded mutation + packet-chaos routes (dry-run + server-side confirm), an append-only SQLite audit trail, and static serving of the built SPA. |
| `@chaos/web` | React + Vite SPA (Tailwind): the operator dashboard. |

## Requirements

- Node 20+
- pnpm 9.7.0 (via corepack: `corepack enable`)
- AWS credentials reachable per the configured credential mode (see [Credentials](#credentials)).

## Install

```bash
corepack enable
pnpm install
```

## Configure

Config lives in `./config` (override with `CHAOS_CONFIG_DIR`). The published Docker image ships **environment-agnostic** — no config is baked in; it's mounted at runtime (see [`infra/DEVOPS-IMAGE.md`](infra/DEVOPS-IMAGE.md)). Annotated templates ship as `*.example.json`; copy each to its real name (kept out of source control) and fill it in:

- `config/platforms.json` — the platforms to control (template: [`config/platforms.example.json`](config/platforms.example.json)). Each entry sets a `kind` (`ecs` | `eks_ssm`), a `region`, a credential mode, identifiers (ECS cluster, or EKS manager instance + namespace + ASG), and optional `chaosBackend` (`chaos-mesh` | `pumba`). For `eks_ssm`, the engine runs every `kubectl` over SSM with `export HOME=/root; export KUBECONFIG=<identifiers.kubeconfig or /root/.kube/config>` — SSM Run Command runs as root in a bare shell (no `$HOME`), so otherwise `kubectl` (and the `aws eks get-token` plugin EKS kubeconfigs use) can't find their config and `kubectl` falls back to `localhost:8080`. Set `identifiers.kubeconfig` only to override the default path; on failure the command emits a `CHAOS_DIAG` block (HOME, KUBECONFIG, readability, dir listing, tool paths) to the logs so the manager state is debuggable without shell access.
- `config/catalog.json` — static grouping/flow metadata used to label live services (template: [`config/catalog.example.json`](config/catalog.example.json)); services not found in any group are reported as `Unmapped`.
- `config/users.json` — local users (**not committed**). Create it from the example:

```bash
cp config/users.example.json config/users.json
# replace each REPLACE_WITH_BCRYPT_HASH (run through @chaos/server, which owns bcryptjs):
pnpm --filter @chaos/server exec node -e "console.log(require('bcryptjs').hashSync('PASSWORD',10))"
```

Each user has a `role` of `viewer` or `operator`. Read routes require any authenticated user; mutation and packet-chaos routes require `operator`.

## Credentials

The engine resolves AWS credentials per platform via `creds.mode`:

- `profile` — a named profile from `~/.aws` (`creds.profile`).
- `default` — the standard AWS SDK provider chain (instance/task role, IRSA, env).
- `assumeRole` — `sts:AssumeRole` into a per-account role (`creds.roleArn`, optional `externalId`).

The console needs least-privilege permissions per layer: ECS (`ecs:DescribeServices`, `ecs:UpdateService`, `ecs:ListServices`/`ListTasks`) plus EC2 NACL entry create/delete for ECS packet-block; SSM `SendCommand`/`GetCommandInvocation` against the EKS manager instance (and that instance's role needs `kubectl` access to the cluster) plus Auto Scaling describe/update for EKS stop-all/start-all. Grant only what your chosen `creds.mode` and layers require.

## Run (local)

```bash
pnpm --filter @chaos/server dev   # API on :8080
pnpm --filter @chaos/web dev      # SPA on :5173 (proxies /api → :8080)
```

Environment variables (see `.env.example`):

| Var | Default | Purpose |
| --- | --- | --- |
| `CHAOS_CONFIG_DIR` | `./config` | Directory holding the JSON config files. |
| `CHAOS_JWT_SECRET` | `dev` | Secret used to sign session cookies. |
| `CHAOS_AUDIT_DB` | `./chaos-audit.sqlite` | SQLite file backing the append-only audit trail. |
| `CHAOS_COOKIE_INSECURE` | unset | Set `true` only for an HTTP-only (non-TLS) deployment; otherwise the session cookie is `Secure`. |
| `PORT` | `8080` | HTTP listen port. |

## HTTP API

All `/api/*` routes except `POST /api/auth/login` and `GET /healthz` require a valid session cookie (`chaos`). Responses use the shared envelope: `{ ok: true, data, auditId }` or `{ ok: false, error: { code, message }, auditId }`.

| Method & path | Auth | Description |
| --- | --- | --- |
| `GET /healthz` | none | Liveness probe (container + load-balancer health checks). |
| `POST /api/auth/login` | none | `{ username, password }` → sets the session cookie, returns the user. |
| `POST /api/auth/logout` | session | Clears the session cookie. |
| `GET /api/auth/me` | session | Returns the current session. |
| `GET /api/platforms` | session | Lists configured platforms (no secrets). |
| `GET /api/platforms/:id/services` | session | Live service status joined with the catalog (unmatched → `Unmapped`). Optional `?service=` filter. |
| `POST /api/platforms/:id/actions/:action` | operator | Runs an action (below). Body `{ service?, count?, loss?, delay?, direction?, duration?, cidr?, dryRun?, confirm? }`. |
| `GET /api/chaos/active` | session | Current network chaos across all platforms (per-platform failures isolated). |
| `GET /api/audit` | session | Audit records, most recent first. Optional `?platform=`, `?user=`, `?limit=`. |

**Actions** (`:action`): scaling `stop` / `start` / `restart` / `stop-all` / `start-all` (`stop-all`/`start-all` are EKS-only); packet chaos `net-loss` / `net-delay` / `net-partition` / `net-clear` / `net-status` (EKS) and `net-block` / `net-clear` / `net-status` (ECS). Wrong-kind actions are rejected.

- `dryRun: true` returns the exact planned operation (SDK params / `kubectl` / NACL entry) without executing, and bypasses confirm.
- `confirm: true` is **required** for the destructive actions (`stop`, `restart`, `stop-all`, `net-loss`, `net-delay`, `net-partition`, `net-block`); `start`, `start-all`, `net-clear`, `net-status` do not need it.
- Packet-loss/delay default to `100`% / `200ms`; `net-partition` forces 100% loss; `net-block` refuses `0.0.0.0/0`.

Every executed action (success or failure) is written to the SQLite audit trail; successful responses carry the record id as `auditId`.

> **Packet-chaos prerequisites.** The EKS backends are not installed by the console: `net-loss`/`net-delay`/`net-partition` need **Chaos Mesh** on the cluster (default) or **Pumba** (set `chaosBackend: "pumba"`); if absent, the action surfaces a clear error. ECS `net-block` needs only the EC2 NACL entry permissions noted under [Credentials](#credentials).

## Web UI

A Tailwind dashboard (white + warm stone, OKLCH) served by the same Fastify process. Design system: [`DESIGN.md`](DESIGN.md).

- **Shell** — left sidebar (Inventory / Active chaos with a live count / Audit, role chip, sign out) and a top bar with the page title, a `DEV` environment pill, a **live "updated Ns ago" indicator**, and global Refresh.
- **Inventory** — services grouped by layer → group as dense tables, each row showing a **StatusPill** (Running / Scaling / Stopped / Throttled…) and a **ReplicaMeter** (running-of-desired bar + tabular count; unknown counts show `—`). Operators get an inline **scale stepper** (−/＋/set), a **Network** button, and a **More** menu (restart / stop-all / start-all); viewers see data only.
- **Live everywhere** — inventory polls every 10s (and refreshes immediately after any action), Active chaos every 10s, Audit every 15s; tables update in place without blanking, and rows whose state changed are briefly highlighted.
- **ChaosDrawer** — kind-adaptive (ECS block; EKS loss/delay/partition with direction + duration), a dry-run toggle, and a formatted plan/result view with the `auditId`. Destructive actions confirm in a dialog.
- **Audit** — the audit log filtered by platform / user / limit.

RBAC is enforced **server-side** (viewers get `403`; destructive actions require `confirm:true`); the UI mirrors these rules but is not the source of truth.

## Build, test, lint

```bash
pnpm -r build     # tsc for shared/engine/server; tsc + vite build for web (→ packages/web/dist)
pnpm test         # vitest run — all packages
pnpm lint         # eslint over **/*.{ts,tsx}
```

In production the server serves the built SPA from `packages/web/dist` via `@fastify/static`, falling back to `index.html` for client routes without shadowing `/api/*`. One process, one origin, so the session cookie just works.

## Deploy

One image (Fastify serves the SPA + API), account-agnostic (no static AWS keys baked in — runtime creds come from the container's task role, IRSA, or a mounted profile). Build it, push it to any Docker registry, and run it on ECS Fargate, EKS, or any container host behind a TLS-terminating load balancer. The build/run runbook plus a `docker-compose` for local runs and teardown is in [`infra/README.md`](infra/README.md).

```bash
# local run against your AWS profiles
CHAOS_JWT_SECRET=$(openssl rand -hex 32) docker compose -f infra/docker-compose.yml up --build
# → http://localhost:8080
```

- **Image hand-off + run/config:** [`infra/DEVOPS-IMAGE.md`](infra/DEVOPS-IMAGE.md)
- **CI pipelines** (GitHub Actions / GitLab CI / Azure DevOps / Jenkins → any Docker registry incl. Nexus): [`infra/ci/`](infra/ci/README.md)
