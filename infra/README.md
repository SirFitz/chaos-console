# Chaos Console — Deploy (DEV)

Everything here is **DEV-oriented and account-agnostic**: nothing hard-codes a host
account. The same image runs under any of the three credential modes — pick one in your
platforms config (`creds.mode`: `profile` | `default` | `assumeRole`). **No static AWS
keys** ever enter the image: runtime creds come from the container's task role (or IRSA on
EKS); local dev mounts your `~/.aws` read-only.

> The artifacts here: `Dockerfile` + `.dockerignore` (image) and `docker-compose.yml`
> (local run). Provisioning the cloud runtime (registry, ECS/EKS, load balancer, IAM
> roles) is left to your own IaC — the image only needs a config mount, a TLS-terminating
> load balancer in front, and AWS credentials via one of the modes below.

## 0. Pick the credential mode

| Host scenario | `api` creds | `mi`/`rules` creds | What to create |
| --- | --- | --- | --- |
| Tooling account (A) | `assumeRole` → a console-api role | `assumeRole` → a console-mi role | host/task role + 2 target roles (cross-account trust) |
| In the mi/rules account (B) | `assumeRole` → a console-api role | `default` (the task role itself) | host/task role + 1 target role in the api account |
| Local dev (laptop/bastion) | `profile aws-profile-a` | `profile aws-profile-b` | none — use existing SSO/SAML profiles |

If you **cannot create roles** (e.g. SSO/SAML-only), use `creds.mode: profile` (or
`default` where the running identity already has the needed permissions) — the console code
is identical; only the platforms config and the surrounding IAM change. The least-privilege
permissions per layer are summarized in the repo `README.md` (Credentials).

## 1. Local run (no infra) — `docker-compose`

Uses `creds.mode: profile` against your existing `aws-profile-a` / `aws-profile-b`
profiles, mounted read-only.

```bash
# from the repo root
cp config/users.example.json config/users.json   # then set real bcrypt hashes
# (generate a hash:  node -e "console.log(require('bcryptjs').hashSync('PASSWORD',10))")
cp config/platforms.example.json config/platforms.json   # then fill it in
cp config/catalog.example.json config/catalog.json       # optional service labels

CHAOS_JWT_SECRET=$(openssl rand -hex 32) \
  docker compose -f infra/docker-compose.yml up --build
# → http://localhost:8080  (login, then the inventory loads via your profiles)
```

Teardown: `docker compose -f infra/docker-compose.yml down` (add `-v` to drop the audit volume).

## 2. Build the image

```bash
# from the repo root (build context = repo root)
docker build -f infra/Dockerfile -t chaos-console:dev .
```

The build runs `pnpm install --frozen-lockfile` → `pnpm -r build` → prod-prune, then a
slim `node:20-slim` runtime starts the Fastify server (which serves the SPA from
`packages/web/dist`) as the non-root `chaos` user. Health: `GET /healthz`.

## 3. Provision the runtime (your IaC)

Stand up whatever container runtime you prefer (ECS Fargate + ALB, EKS, or any container
host). Whichever you choose, the console needs:

- **A config mount at `/config`** holding `platforms.json` (+ optional `catalog.json`) and
  `users.json`. The image is environment-agnostic — nothing is baked in.
- **A TLS-terminating load balancer in front.** The session cookie is `Secure` by default;
  terminate TLS at the LB (or set `CHAOS_COOKIE_INSECURE=true` only for an internal
  HTTP-only deployment).
- **AWS credentials** via the task role / IRSA (`assumeRole` or `default` mode), or a
  mounted profile for local runs. No static keys belong in the image.
- **The JWT secret** supplied at runtime — e.g. from a secrets manager / SSM SecureString
  injected as `CHAOS_JWT_SECRET`:

```bash
aws ssm put-parameter --name /chaos-console/jwt-secret --type SecureString \
  --value "$(openssl rand -hex 32)"
```

## 4. Push the image + roll the service

```bash
REGION=us-east-1
ECR_URL=<your-account>.dkr.ecr.$REGION.amazonaws.com/chaos-console
aws ecr get-login-password --region "$REGION" \
  | docker login --username AWS --password-stdin "${ECR_URL%/*}"
docker tag chaos-console:dev "$ECR_URL:dev"
docker push "$ECR_URL:dev"

# roll an ECS service to pull the new image (adjust cluster/service names)
aws ecs update-service --cluster my-ecs-cluster --service chaos-console \
  --force-new-deployment
```

Browse to your load balancer's DNS name (or your CNAME to it). Always **dry-run** a new
role/profile/environment first — every action supports it, and the audit log records the
resolved identity.

## 5. Teardown

Tear down whatever you provisioned in step 3 with the same IaC, runtime first
(load balancer / service) then any IAM roles you created.
