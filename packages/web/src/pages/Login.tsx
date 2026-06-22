import React, { useState } from "react";
import { useAuth } from "../auth.js";
import { ApiError } from "../api.js";
import { Button, Chip } from "../components/ui.js";

export function Login(): React.ReactElement {
  const { login } = useAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await login(username, password);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "login failed");
    } finally {
      setBusy(false);
    }
  }

  const field =
    "h-9 w-full rounded-md border border-border-strong bg-panel px-3 text-sm text-ink placeholder:text-ink-faint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface disabled:opacity-60";

  return (
    <div className="grid min-h-screen place-items-center bg-surface px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center justify-center gap-2.5">
          <span
            className="grid h-8 w-8 place-items-center rounded-md bg-ink text-xs font-semibold text-surface"
            aria-hidden="true"
          >
            CC
          </span>
          <span className="text-lg font-semibold text-ink">Chaos Console</span>
        </div>

        <form
          onSubmit={onSubmit}
          className="rounded-lg border border-border bg-panel p-6 shadow-sm"
          aria-label="Sign in"
        >
          <div className="mb-4 flex items-center justify-between">
            <h1 className="text-sm font-semibold text-ink">Sign in</h1>
            <Chip tone="warn">DEV</Chip>
          </div>

          <div className="mb-3">
            <label htmlFor="login-username" className="mb-1 block text-xs font-medium text-ink-soft">
              Username
            </label>
            <input
              id="login-username"
              className={field}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              autoFocus
            />
          </div>
          <div className="mb-4">
            <label htmlFor="login-password" className="mb-1 block text-xs font-medium text-ink-soft">
              Password
            </label>
            <input
              id="login-password"
              type="password"
              className={field}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
            />
          </div>

          {error && (
            <p
              className="mb-3 rounded-md border border-bad/40 bg-bad-soft px-3 py-2 text-xs text-bad"
              role="alert"
            >
              {error}
            </p>
          )}

          <Button type="submit" variant="primary" busy={busy} className="w-full" disabled={busy}>
            {busy ? "Signing in" : "Sign in"}
          </Button>
        </form>

        <p className="mt-4 text-center text-xs text-ink-faint">
          Authenticated, audited control surface for resilience drills.
        </p>
      </div>
    </div>
  );
}
