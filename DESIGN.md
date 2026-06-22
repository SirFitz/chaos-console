# DESIGN.md — Chaos Console

Light, white + warm **stone**, professional operational dashboard. Tailwind. Restrained color: stone neutrals carry the surface; semantic color carries *state* only. OKLCH throughout. Never `#fff`/`#000`.

## Color (OKLCH; define as CSS vars in `:root`, map in Tailwind config)

**Neutrals — warm stone (hue ~70):**
- `--surface` app background `oklch(0.985 0.003 75)` (warm off-white, not #fff)
- `--panel` cards/tables `oklch(1 0 0 / 0)` → use `oklch(0.995 0.002 75)` solid white-stone
- `--rail` sidebar/toolbars `oklch(0.965 0.004 70)` (a touch cooler/deeper than content — the "second neutral layer")
- `--border` `oklch(0.92 0.004 70)`; `--border-strong` `oklch(0.86 0.005 70)`
- text: `--ink` `oklch(0.27 0.01 70)` · `--ink-soft` `oklch(0.48 0.01 70)` · `--ink-faint` `oklch(0.62 0.008 70)`

**Accent (interactive / selection only, ≤10% of surface): indigo**
- `--accent` `oklch(0.55 0.15 264)` · `--accent-ink` `oklch(0.985 0.01 264)` · `--accent-soft` `oklch(0.95 0.03 264)`

**Semantic status (functional, never decorative):**
- healthy/running `--ok` `oklch(0.62 0.13 150)` (+ `--ok-soft` `oklch(0.95 0.04 150)`)
- transitioning/pending `--warn` `oklch(0.74 0.14 75)` (amber) (+ soft `oklch(0.96 0.05 75)`)
- stopped/error `--bad` `oklch(0.58 0.18 25)` (+ soft `oklch(0.95 0.04 25)`)
- chaos active `--chaos` `oklch(0.55 0.18 300)` (violet — clearly "intentional disruption", distinct from error/warn) (+ soft `oklch(0.95 0.05 300)`)

Status uses a soft tint background + the saturated hue for the dot/label. Inactive states get neutral stone, never a faded saturated color.

## Typography
- One family: `ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Inter, sans-serif`. Tabular numerals for all counts/metrics (`font-variant-numeric: tabular-nums`).
- Fixed rem scale, ratio ~1.2: `text-xs 0.75 / sm 0.8125 / base 0.875 / lg 1.0625 / xl 1.375`. Dense UI sits at `sm`/`base`.
- Weight contrast for hierarchy: 600 headings/labels, 400–450 body, 500 data emphasis. Uppercase tracked `text-xs` for section/column labels.

## Layout — dashboard shell
- **Left sidebar** (`--rail`, ~232px, collapsible < lg): product mark "Chaos Console", nav = **Inventory** (the 3 layers), **Active chaos** (badge = count), **Audit**. Footer: role chip + sign out.
- **Top bar**: page title + a `DEV` environment pill; right side = **live status** (last-updated relative time + a small pulsing dot when polling), global **Refresh**, user.
- **Content**: layers as titled sections (API / MI / Rules), each a **dense table** grouped by catalog group. No card grids. Tables, not tiles.
- Action surfaces are a **right-side drawer** (chaos / actions), not center modals. Confirm uses a small centered dialog only for destructive execution.
- Comfortable section headers; dense rows (h ~40px). Vary spacing — generous around headers, tight in rows.

## Status rendering — NO raw "0/2"
A service row's state is a **StatusPill** + a **ReplicaMeter**, never a naked ratio:
- **StatusPill**: soft-tinted chip with a colored dot + word — `Running` (ok), `Scaling` / `Pending` (warn, dot gently pulses), `Stopped` (bad), `Degraded` (bad/warn), `Throttled`/`Blocked` (chaos).
- **ReplicaMeter**: `running` of `desired` shown as a tiny segmented bar (filled = running, track = desired) + `2 / 2` in tabular nums, colored ok when running==desired, warn when 0<running<desired, bad when running==0 && desired>0. If `desired`/`running` are unknown (e.g. some platforms), show `—`, never `0/0` or `1/0`.
- Liveness: a subtle "updated 3s ago" caption per table + the top-bar pulse. Rows that changed since last poll get a 1-step highlight fade (state-conveying, ≤250ms).

## Live data (must feel live, not static)
- Inventory polls every **10s** (configurable) AND immediately after any action; show last-updated + an unobtrusive auto-refresh indicator; never block the table while refetching (keep prior data, update in place).
- **Active chaos** and **Audit** also poll (Active chaos ~10s; Audit ~15s or on focus).
- Optimistic feedback on actions, then reconcile from the next poll.

## Components (each: default / hover / focus-visible / active / disabled / loading)
- **Buttons**: solid accent (primary), stone outline (secondary), quiet ghost (tertiary), `--bad` outline→solid on confirm (destructive). Radius `rounded-md` (6px). Focus = 2px accent ring offset.
- **ScaleControl** (inline, operator): `−` / value / `+` stepper + a compact "set" input + Apply; shows current running/desired inline; disabled+spinner while applying; 0 routes to Stop (confirm).
- **ChaosDrawer**: kind-adaptive — ECS: block(CIDR)+clear+status; EKS: loss%(slider+number) / delay / partition + direction + duration + clear + status. Dry-run toggle. Renders the plan/result cleanly (formatted, not raw JSON dumped — pretty key/value), with the auditId.
- **Tables**: sticky header, zebra via `--rail` at 35% on hover only (no permanent zebra), column labels uppercase xs tracked, right-aligned numerics.
- **Loading** = skeleton rows, not center spinners. **Empty** = a teaching line ("No services in this layer yet"). **Error** (per layer) = inline degraded banner with retry, page stays alive.

## Motion
150–250ms, ease-out (quart/expo). Only for: state change (status fade), drawer slide, button feedback, skeleton shimmer. No page-load choreography, no bounce. Don't animate layout props.

## Bans (enforced)
No side-stripe accent borders; no gradient text; no glassmorphism; no hero-metric tiles; no identical icon-card grids; no modal-as-default (drawer for actions; dialog only for destructive confirm). System sans only. No em dashes in UI copy.
