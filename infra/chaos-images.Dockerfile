# infra/chaos-images.Dockerfile
#
# ⚠️  This is NOT the Chaos Console application image — that's infra/Dockerfile.
#     Nothing here ships or runs. It exists purely to MIRROR images.
#
# Why it exists
# -------------
# The Console runs on ECS and never contains these images. The three chaos
# images are pulled by the **EKS worker nodes at runtime**, when the manager box
# (via kubectl/SSM) schedules the short-lived chaos pods:
#   • busybox  — the network probe pod that measures packet loss + latency
#                (feeds the per-service live chart and `net-verify`)
#   • pumba    — applies the network faults (loss / delay / partition) via Linux
#                tc/netem; pumba-alpine-nettools is its tc/netem toolbox
#   • nginx    — the 503 "sink" for L7 path-cut / path-degrade
# In a locked-down cluster the nodes can't reach ghcr.io / docker.io, so those
# pods ImagePullBackOff → no chart traffic, no chaos. They just need to EXIST in
# a registry the nodes CAN reach (JFrog).
#
# What to do with it
# ------------------
# Build this file through the mirror pipeline so each referenced image is pulled
# and lands in JFrog:
#     docker build -f infra/chaos-images.Dockerfile .
# (or mirror directly with skopeo — see infra/mirror-chaos-images.sh.)
#
# Then point the Console's platform config (platforms.json, the `api` platform)
# at the mirrored paths — that's the half that actually wires it up:
#     "chaosProbeImage":    "<jfrog>/busybox:1.36"                      # probe / chart
#     "chaosImage":         "<jfrog>/pumba:<pinned>"                    # Pumba netem
#     "chaosNetToolsImage": "<jfrog>/pumba-alpine-nettools:<pinned>"    # Pumba tc toolbox
#     "chaosSinkImage":     "<jfrog>/nginx:alpine"                      # L7 503 sink
#
# Prefer pinning Pumba to a specific release tag instead of :latest
# (https://github.com/alexei-led/pumba/releases) — :latest is mutable.

# One stage per upstream image — these are the exact sources to mirror FROM:
FROM busybox:1.36                                    AS probe      # docker.io/library/busybox
FROM ghcr.io/alexei-led/pumba:latest                 AS pumba      # ghcr.io/alexei-led/pumba
FROM ghcr.io/alexei-led/pumba-alpine-nettools:latest AS nettools   # ghcr.io/alexei-led/pumba-alpine-nettools
FROM nginx:alpine                                    AS sink       # docker.io/library/nginx

# BuildKit skips stages nothing depends on, so the final stage references all
# four to force each pull. Copying "/" avoids guessing per-image file paths; this
# image is never run, so its size is irrelevant.
FROM scratch
COPY --from=probe    / /mirror/busybox/
COPY --from=pumba    / /mirror/pumba/
COPY --from=nettools / /mirror/pumba-nettools/
COPY --from=sink     / /mirror/nginx/
