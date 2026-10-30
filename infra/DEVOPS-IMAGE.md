# Chaos Console — Image Handoff (for DevOps)

The production container image for the Chaos Console (Fastify API + React SPA in one image; the engine talks to AWS via SDK v3). Built from [`infra/Dockerfile`](Dockerfile).

## What you're getting

- **Artifact:** `chaos-console-0.1.7-amd64.tar.gz` (a `docker save` tarball, **linux/amd64**).
- **Version:** `0.1.7` · **git:** `f955120` · **SHA256:** `3cba0e78ebf6b531dc241d92ecb03a2af05098cfd7d12ab0296ae65d788140fb` (also in `chaos-console-0.1.7-amd64.tar.gz.sha256`).
- **Changelog:** `0.1.7` adds a **per-service detail page** — click a service for its live status, the action/audit timeline scoped to that service, active chaos on it, and (EKS) a **live network chart** of measured loss % + latency over time (auto-sampled from net-verify probes — watch a fault take effect). `0.1.6` added **L7 path chaos** (additive ingress-nginx canary overlay → 503 sink; never edits the real Ingress), **backend-health preflight**, **Pumba liveness-confirm**, and an **addressable-error** layer. `0.1.5` added the EKS verification probe + UX polish. `0.1.3` made the image **environment-agnostic** + full action auditing. `0.1.2` redesigned the UI. Use `0.1.7`; earlier tags are superseded.
- Base `node:24-slim` (glibc — `better-sqlite3` is a native addon), **non-root** (uid 10001), `EXPOSE 8080`, built-in `HEALTHCHECK` on `/healthz`. No AWS keys or secrets are baked in.
- Need a registry image or arm64 instead? Use the pipeline below (multi-arch), or ask and we'll push to your ECR/GHCR.

## Load it

```bash
gunzip -c chaos-console-0.1.7-amd64.tar.gz | docker load
# verify integrity first if you like:
shasum -a 256 -c chaos-console-0.1.7-amd64.tar.gz.sha256
docker images chaos-console
```

## Run it

```bash
docker run -d --name chaos-console -p 8080:8080 \
  -e CHAOS_JWT_SECRET="$(openssl rand -hex 32)" \
  -v /path/to/your/config:/config:ro \
  -v chaos-audit:/data \
  chaos-console:0.1.7
# UI + API on :8080 ; health: curl -fsS localhost:8080/healthz -> {"status":"ok"}
```

### Environment

| var | default | notes |
|-----|---------|-------|
| `PORT` | `8080` | HTTP listen port (serves API **and** the SPA). |
| `CHAOS_CONFIG_DIR` | `/config` | where it reads `platforms.json`, `catalog.json`, `users.json`. |
| `CHAOS_JWT_SECRET` | `dev` | **set this** — signing key for the session cookie. |
| `CHAOS_AUDIT_DB` | `/data/chaos-audit.sqlite` | append-only audit DB; mount a volume at `/data` to persist. |
| `CHAOS_COOKIE_INSECURE` | unset | leave unset in prod. The session cookie is `Secure` → **terminate TLS in front** (ALB). Only set `true` for an internal HTTP-only deployment. |

### Config the image expects at `/config`

**The image is environment-agnostic — no config is baked in.** It boots with empty defaults and reads these from `/config` (mount them at runtime, e.g. an ECS/EKS volume or a `-v`):

- `platforms.json` — the platforms to control (clusters, regions, credential modes, EKS manager/namespace, `chaosBackend`). See the annotated template at `config/platforms.example.json`. **Supply the one for your environment.**
- `catalog.json` — optional service→layer→flow labels (template at `config/catalog.example.json`); unmapped services still appear.
- `users.json` — local users: array of `{ username, passwordHash (bcrypt), role: "viewer"|"operator" }`. Generate a hash: `node -e "console.log(require('bcryptjs').hashSync('PASSWORD',10))"`. Keep it out of source control.

### AWS credentials (runtime)

The engine uses the AWS SDK default provider chain, shaped per-platform by `creds.mode`:
- **`assumeRole`** — the container's task role calls `sts:AssumeRole` into per-account roles (recommended for ECS/EKS).
- **`default`** — the task role's own permissions are used directly (single-account).
- **`profile`** — reads `~/.aws` (mount it read-only); handy for local/`docker-compose` runs.

The least-privilege permissions per layer (ECS describe/update + NACL; SSM SendCommand + Auto Scaling for EKS) are summarized in the repo **[`README.md`](../README.md)** (Credentials). For EKS **network throttling** the cluster must run **Chaos Mesh** (default) or **Pumba** (`chaosBackend: "pumba"`); the console does not install either.

To stand up the runtime (a container host + load balancer + IAM roles), see **[`infra/README.md`](README.md)**.

## Rebuild / publish via CI

[`.github/workflows/build-image.yml`](../.github/workflows/build-image.yml) builds this image **multi-arch (amd64+arm64)** behind a `pnpm test && lint && build` gate and publishes it. Each registry job runs only if its registry is configured; a tag `v0.1.7` cuts a release, `main` pushes `:latest` + a sha tag.

- **GHCR** (default, zero config): uses the built-in `GITHUB_TOKEN` → `ghcr.io/<owner>/<repo>`.
- **Nexus** (Sonatype Docker hosted repo): set repo **variable** `NEXUS_REGISTRY` = the Docker connector `host:port` (e.g. `nexus.corp:8083`), `NEXUS_IMAGE` (default `chaos-console`), and **secrets** `NEXUS_USERNAME` / `NEXUS_PASSWORD` (a Nexus account that can push to that repo). The `image-nexus` job pushes there (with `provenance:false` for Nexus compatibility).
- **ECR** (optional): set repo **variables** `ECR_REPOSITORY` + `AWS_DEPLOY_ROLE_ARN` (OIDC role; optional `AWS_REGION`). No static keys.

```bash
git tag v0.1.7 && git push origin v0.1.7   # triggers a release build
```

### Push the supplied tarball to Nexus manually (no CI needed)

If you'd rather not wire CI yet, load the handed-over tarball and push it to your Nexus Docker repo (replace `NEXUS=host:port`, `REPO_PATH`, and use a Nexus account with push rights):

```bash
docker load -i chaos-console-0.1.7-amd64.tar.gz       # -> loads chaos-console:0.1.7
NEXUS=nexus.corp:8083                                  # your Nexus Docker connector host:port
docker login "$NEXUS"                                  # Nexus credentials
docker tag chaos-console:0.1.7 "$NEXUS/chaos-console:0.1.7"
docker push "$NEXUS/chaos-console:0.1.7"
```
Note: this tarball is **linux/amd64** only. For a multi-arch image in Nexus, run the pipeline (it builds amd64+arm64). The deploy/runtime config (env, `/config` mount, IAM) is unchanged regardless of registry — see the top of this doc.
