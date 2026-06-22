// packages/web/src/components/ui.tsx
//
// Shared, consistent component vocabulary for the console. Every interactive
// element carries default / hover / focus-visible / active / disabled states;
// a `busy` flag adds the loading state. Tokens only — no hand-picked colors.
import React, { useEffect, useState } from "react";

const FOCUS =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
type ButtonSize = "sm" | "md";

const VARIANT: Record<ButtonVariant, string> = {
  primary:
    "bg-accent text-accent-ink border border-accent hover:brightness-110 active:brightness-95 disabled:opacity-50",
  secondary:
    "bg-panel text-ink border border-border-strong hover:bg-rail active:bg-rail disabled:opacity-50",
  ghost:
    "bg-transparent text-ink-soft border border-transparent hover:bg-rail hover:text-ink active:bg-rail disabled:opacity-40",
  danger:
    "bg-panel text-bad border border-bad hover:bg-bad hover:text-accent-ink active:brightness-95 disabled:opacity-50",
};
const SIZE: Record<ButtonSize, string> = {
  sm: "h-7 px-2.5 text-xs",
  md: "h-8 px-3 text-sm",
};
// Gap lives on the inner label span (the spinner is overlaid, out of flow).
const GAP: Record<ButtonSize, string> = { sm: "gap-1.5", md: "gap-2" };

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  busy?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", busy = false, className = "", disabled, children, ...rest },
  ref,
): React.ReactElement {
  // The spinner is overlaid (absolute) while the label stays in flow but hidden,
  // so the button keeps EXACTLY its resting size in the loading state — no grow
  // or shrink when the spinner appears (DESIGN.md: stable size in loading).
  return (
    <button
      ref={ref}
      type="button"
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      className={`relative inline-flex items-center justify-center whitespace-nowrap rounded-md font-medium transition-[background-color,color,filter,box-shadow] duration-150 ease-out disabled:cursor-not-allowed ${SIZE[size]} ${VARIANT[variant]} ${FOCUS} ${className}`}
      {...rest}
    >
      {busy && (
        <span className="absolute inset-0 grid place-items-center" aria-hidden="true">
          <Spinner />
        </span>
      )}
      <span className={`inline-flex items-center ${GAP[size]} ${busy ? "opacity-0" : ""}`}>
        {children}
      </span>
    </button>
  );
});

/** Tiny inline spinner for button loading state (not a center page spinner). */
export function Spinner({ className = "" }: { className?: string }): React.ReactElement {
  return (
    <span
      role="status"
      aria-label="loading"
      className={`inline-block h-3.5 w-3.5 animate-spin rounded-full border-[1.5px] border-current border-r-transparent opacity-80 ${className}`}
    />
  );
}

/** Small stone chip for env / role labels (DEV, operator). */
export function Chip({
  children,
  tone = "neutral",
  className = "",
}: {
  children: React.ReactNode;
  tone?: "neutral" | "accent" | "warn";
  className?: string;
}): React.ReactElement {
  const tones = {
    neutral: "bg-rail text-ink-soft border-border",
    accent: "bg-accent-soft text-accent border-transparent",
    warn: "bg-warn-soft text-warn border-transparent",
  } as const;
  return (
    <span
      className={`inline-flex items-center rounded-md border px-1.5 py-0.5 text-xs font-medium uppercase tracking-wide ${tones[tone]} ${className}`}
    >
      {children}
    </span>
  );
}

/** A small pulsing dot shown while a poll is in flight; steady otherwise. */
export function LiveDot({ active }: { active: boolean }): React.ReactElement {
  return (
    <span className="relative inline-flex h-2 w-2" aria-hidden="true">
      {active && (
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-ok opacity-60" />
      )}
      <span className={`relative inline-flex h-2 w-2 rounded-full ${active ? "bg-ok" : "bg-ink-faint"}`} />
    </span>
  );
}

function formatAgo(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 1) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ago`;
}

/**
 * Relative "updated Ns ago" caption that ticks on its own once a second, so the
 * surface reads as live even between polls.
 */
export function RelativeTime({
  since,
  prefix = "updated",
}: {
  since: number | null;
  prefix?: string;
}): React.ReactElement {
  const [, force] = useState(0);
  useEffect(() => {
    const t = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  if (since === null) return <span className="tnum text-ink-faint">never</span>;
  return (
    <span className="tnum text-ink-faint" title={new Date(since).toLocaleTimeString()}>
      {prefix} {formatAgo(Date.now() - since)}
    </span>
  );
}

/** A shimmering skeleton block for loading rows. */
export function Skeleton({ className = "" }: { className?: string }): React.ReactElement {
  return <span className={`skeleton block ${className}`} aria-hidden="true" />;
}
