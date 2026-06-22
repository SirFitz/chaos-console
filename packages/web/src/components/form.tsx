// packages/web/src/components/form.tsx
//
// Shared form-control vocabulary for the drawer. One look for every input so
// the surface never feels stitched together (product register: consistency).
import React from "react";

const CONTROL =
  "h-8 w-full rounded-md border border-border-strong bg-panel px-2.5 text-sm text-ink placeholder:text-ink-faint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-panel disabled:opacity-60";

export function Field({
  label,
  htmlFor,
  children,
  hint,
}: {
  label: string;
  htmlFor?: string;
  children: React.ReactNode;
  hint?: string;
}): React.ReactElement {
  return (
    <div className="mb-3.5">
      <label htmlFor={htmlFor} className="mb-1 block text-xs font-medium text-ink-soft">
        {label}
      </label>
      {children}
      {hint && <p className="mt-1 text-xs text-ink-faint">{hint}</p>}
    </div>
  );
}

export const TextInput = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  function TextInput({ className = "", ...rest }, ref) {
    return <input ref={ref} className={`${CONTROL} ${className}`} {...rest} />;
  },
);

export function Select({
  className = "",
  children,
  ...rest
}: React.SelectHTMLAttributes<HTMLSelectElement>): React.ReactElement {
  return (
    <select className={`${CONTROL} ${className}`} {...rest}>
      {children}
    </select>
  );
}

export function Checkbox({
  label,
  ...rest
}: { label: React.ReactNode } & React.InputHTMLAttributes<HTMLInputElement>): React.ReactElement {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-sm text-ink-soft">
      <input
        type="checkbox"
        className="h-4 w-4 rounded border-border-strong text-accent accent-[var(--accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1"
        {...rest}
      />
      {label}
    </label>
  );
}
