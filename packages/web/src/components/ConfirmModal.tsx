// packages/web/src/components/ConfirmModal.tsx
import React, { useEffect, useRef } from "react";
import { Button } from "./ui.js";

/**
 * Small centered dialog — used ONLY for destructive confirmation (DESIGN.md).
 * Escape cancels; the destructive Confirm is auto-focused so a deliberate
 * Enter completes it.
 */
export function ConfirmModal({
  title,
  message,
  onConfirm,
  onCancel,
  busy,
  confirmLabel = "Confirm",
}: {
  title: string;
  message: string;
  onConfirm: () => void;
  onCancel: () => void;
  busy: boolean;
  confirmLabel?: string;
}): React.ReactElement {
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    confirmRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onCancel]);

  return (
    <div className="fixed inset-0 z-[60] grid place-items-center p-4">
      <button
        type="button"
        aria-hidden="true"
        tabIndex={-1}
        className="absolute inset-0 bg-ink/40 animate-fade-in"
        onClick={() => !busy && onCancel()}
      />
      <div
        role="alertdialog"
        aria-modal="true"
        aria-label={title}
        className="relative w-full max-w-sm rounded-lg border border-border bg-panel p-5 shadow-xl animate-fade-in"
      >
        <h2 className="text-sm font-semibold text-ink">{title}</h2>
        <p className="mt-2 text-sm text-ink-soft">{message}</p>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button ref={confirmRef} variant="danger" size="sm" busy={busy} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
