#!/usr/bin/env bash
# infra/mirror-chaos-images.sh
#
# Mirror the chaos-runtime images into an internal registry (JFrog) so the EKS
# worker nodes can pull them at runtime. These are RUNTIME images for the cluster
# (probe / Pumba / 503 sink) — NOT part of the Console app image. See the header
# of infra/chaos-images.Dockerfile for the full why.
#
# Usage:
#   DEST=jfrog.corp/chaos ./infra/mirror-chaos-images.sh
#     DEST       your JFrog repo path (no trailing slash) — required.
#     PUMBA_TAG  Pumba tag to mirror (default: latest; prefer a pinned release).
#     USE_DOCKER set to 1 to pull/tag/push with docker instead of skopeo.
#
# Requires `skopeo` (default) or docker, plus push credentials for DEST.
set -euo pipefail
: "${DEST:?set DEST to your JFrog repo path, e.g. DEST=jfrog.corp/chaos}"
PUMBA_TAG="${PUMBA_TAG:-latest}"

# "<source ref>|<dest tag>" — the dest tag is what you put in the Console config.
IMAGES=(
  "docker.io/library/busybox:1.36|busybox:1.36"
  "ghcr.io/alexei-led/pumba:${PUMBA_TAG}|pumba:${PUMBA_TAG}"
  "ghcr.io/alexei-led/pumba-alpine-nettools:${PUMBA_TAG}|pumba-alpine-nettools:${PUMBA_TAG}"
  "docker.io/library/nginx:alpine|nginx:alpine"
)

for pair in "${IMAGES[@]}"; do
  src="${pair%%|*}"; dst="${DEST}/${pair##*|}"
  echo ">> mirroring $src  ->  $dst"
  if [ "${USE_DOCKER:-0}" = "1" ]; then
    docker pull "$src"; docker tag "$src" "$dst"; docker push "$dst"
  else
    skopeo copy --all "docker://$src" "docker://$dst"
  fi
done

cat <<EOF

Done. Now set these on the Console's 'api' platform in platforms.json:
  "chaosProbeImage":    "${DEST}/busybox:1.36"
  "chaosImage":         "${DEST}/pumba:${PUMBA_TAG}"
  "chaosNetToolsImage": "${DEST}/pumba-alpine-nettools:${PUMBA_TAG}"
  "chaosSinkImage":     "${DEST}/nginx:alpine"
EOF
