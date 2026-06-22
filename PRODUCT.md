# PRODUCT.md — Chaos Console

**register:** product

## Product purpose
A deployed, authenticated, audited web console that lists and manages your services across three AWS layers — one **api** layer (EKS, via SSM→kubectl) and two **ecs** layers (`mi` and `rules` by default) — and lets operators run controlled chaos against them: **scale** up/down, **restart**, **stop-all**, and **packet chaos** (ECS NACL block; EKS packet **loss / delay / partition** via Pumba). Safeguards throughout: dry-run, server-enforced confirm, audit, plus live inventory, RBAC, and a UI.

## Users
Platform **operators / SREs** and **viewers**. They use it during planned **resilience drills** and **incident response** — moments where being fast *and* not making a mistake both matter. Two roles: `operator` (read + all actions) and `viewer` (read-only). Not a public or consumer product.

## Tone & brand
A calm, trustworthy **control surface**, not a flashy SaaS app. Confidence under pressure. Dense but legible; every pixel earns operational value. The reader should feel they can see the true state of the system at a glance and act deliberately. Serious, precise, quiet.

## Strategic principles
1. **Live truth.** Always show current state, polled continuously — never a stale snapshot from page load. Status, counts, and active chaos refresh on their own.
2. **Deliberate danger.** Destructive actions (stop, restart, stop-all, packet chaos) require explicit confirm + support dry-run, and every attempt + outcome is audited.
3. **Per-layer fault isolation.** One account/role failure degrades that layer's card, never the whole page.
4. **Operator efficiency.** Scannable, dense, keyboard-friendly; the common actions (scale, throttle, restore) are one or two clicks, not buried.
5. **Clarity over decoration.** No ornament that doesn't convey state.

## Anti-references (do NOT look like these)
- Generic SaaS dashboards: gradient hero-metric tiles, identical icon-card grids, neon accents.
- The dark "hacker/terminal" ops-tool cliché (the reflex for a chaos tool — we deliberately go the other way).
- Raw, unstyled data: naked `0/2` counts, unlabeled states, ambiguous status.

## Success criteria
An operator fluent in tools like Linear / Datadog / the AWS console trusts it immediately, reads service health in one glance, and never sees a stale or cryptic state.
