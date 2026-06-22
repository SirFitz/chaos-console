# CI pipelines — build + publish the console image to Nexus

Pick the one for your CI. They are equivalent: a **`pnpm test → lint → build`** gate, then a **multi-arch (amd64+arm64)** image built from [`infra/Dockerfile`](../Dockerfile) with `buildx` and pushed to a **Sonatype Nexus Docker (hosted) repo**. Release on a `vX.Y.Z` tag; rolling `:latest` on `main`.

| CI | File | Where it goes |
|---|---|---|
| GitHub Actions | [`../../.github/workflows/build-image.yml`](../../.github/workflows/build-image.yml) | already at the default path (also supports GHCR/ECR) |
| GitLab CI | [`.gitlab-ci.yml`](.gitlab-ci.yml) | Settings → CI/CD → *CI/CD configuration file* = `infra/ci/.gitlab-ci.yml` |
| Azure DevOps | [`azure-pipelines.yml`](azure-pipelines.yml) | New pipeline → *Existing YAML* → `infra/ci/azure-pipelines.yml` |
| Jenkins | [`Jenkinsfile`](Jenkinsfile) | Pipeline job → *Script Path* = `infra/ci/Jenkinsfile` |

## Configure once (same names everywhere)

| name | example | notes |
|---|---|---|
| `NEXUS_REGISTRY` | `nexus.corp:8083` | the Nexus **Docker connector** host:port (variable) |
| `NEXUS_IMAGE` | `chaos-console` | image path within the repo (variable) |
| `NEXUS_USERNAME` | `svc-ci` | Nexus account that can push to that repo |
| `NEXUS_PASSWORD` | `••••` | **secret/masked** (Jenkins: a `nexus-docker` username/password credential) |

Result: `NEXUS_REGISTRY/NEXUS_IMAGE:<tag>` (+ a short-SHA tag).

## Runner prerequisites
- **Docker + `buildx`** on the build agent, and **privileged** access to register QEMU (`tonistiigi/binfmt`) for the arm64 leg. If your runners are amd64-only and you don't need arm64, drop `linux/arm64` from `--platform` (if your nodes are x86_64, amd64 alone is fine).
- `--provenance=false` is set on purpose: some Nexus Docker repos reject the buildx OCI attestation manifest.

## After it's in Nexus
Deploying the image is unchanged regardless of registry — env, the `/config` mount (`users.json` + `platforms.json` + `catalog.json`), TLS, and AWS creds/IAM are all in [`../DEVOPS-IMAGE.md`](../DEVOPS-IMAGE.md) and the repo [`README.md`](../../README.md).
