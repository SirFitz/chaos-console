// packages/web/src/pages/Terminal.tsx
//
// A minimal in-app SSM terminal. Operator-only: it runs free-text commands as
// root on an eks_ssm platform's manager box over SSM (every command is audited
// server-side). Commands run RAW — exactly as typed — so you see the box's true
// bare-shell state ($HOME unset, etc.); prepend `export HOME=/root; export
// KUBECONFIG=/root/.kube/config;` yourself when you want kubectl to resolve.
// No xterm, no websockets: a controlled input + a scrollback, one request/command.
import React, { useEffect, useRef, useState } from "react";
import type { ExecResult, Role } from "@chaos/shared";
import * as api from "../api.js";
import { ApiError, type PlatformSummary } from "../api.js";
import { Button, Chip, Spinner } from "../components/ui.js";

/** One submitted command and its (eventual) result or error. */
interface Entry {
  command: string;
  result?: ExecResult;
  error?: string;
  running: boolean;
}

function patchLast(entries: Entry[], patch: Partial<Entry>): Entry[] {
  if (entries.length === 0) return entries;
  const copy = entries.slice();
  copy[copy.length - 1] = { ...copy[copy.length - 1], ...patch };
  return copy;
}

export function Terminal({ role }: { role: Role }): React.ReactElement {
  const [platforms, setPlatforms] = useState<PlatformSummary[] | null>(null);
  const [platformId, setPlatformId] = useState("");
  const [input, setInput] = useState("");
  const [entries, setEntries] = useState<Entry[]>([]);
  const [busy, setBusy] = useState(false);
  const history = useRef<string[]>([]);
  const histIdx = useRef(-1);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Only eks_ssm platforms have a manager box reachable over SSM.
  useEffect(() => {
    let alive = true;
    api
      .listPlatforms()
      .then((ps) => {
        if (!alive) return;
        const eks = ps.filter((p) => p.kind === "eks_ssm");
        setPlatforms(eks);
        if (eks[0]) setPlatformId(eks[0].id);
      })
      .catch(() => alive && setPlatforms([]));
    return () => {
      alive = false;
    };
  }, []);

  // Pin the scrollback to the newest line as entries stream in.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [entries]);

  const run = async () => {
    const command = input.trim();
    if (!command || busy || !platformId) return;
    history.current.unshift(command);
    histIdx.current = -1;
    setInput("");
    setEntries((es) => [...es, { command, running: true }]);
    setBusy(true);
    try {
      const { result } = await api.execCommand(platformId, command);
      setEntries((es) => patchLast(es, { result, running: false }));
    } catch (e) {
      const msg = e instanceof ApiError ? `${e.code}: ${e.message}` : (e as Error).message;
      setEntries((es) => patchLast(es, { error: msg, running: false }));
    } finally {
      setBusy(false);
      inputRef.current?.focus();
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void run();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      const h = history.current;
      if (h.length === 0) return;
      histIdx.current = Math.min(histIdx.current + 1, h.length - 1);
      setInput(h[histIdx.current] ?? "");
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      histIdx.current = Math.max(histIdx.current - 1, -1);
      setInput(histIdx.current === -1 ? "" : history.current[histIdx.current] ?? "");
    }
  };

  if (role !== "operator")
    return (
      <Notice>
        The terminal requires the <strong>operator</strong> role.
      </Notice>
    );
  if (platforms !== null && platforms.length === 0)
    return (
      <Notice>
        No <code>eks_ssm</code> platform with a manager box is configured.
      </Notice>
    );

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-3">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h2 className="text-base font-semibold text-ink">SSM terminal</h2>
          <Chip tone="warn">root on manager box</Chip>
        </div>
        {platforms && platforms.length > 1 && (
          <label className="flex items-center gap-2 text-sm text-ink-soft">
            platform
            <select
              value={platformId}
              onChange={(e) => setPlatformId(e.target.value)}
              className="rounded-md border border-border-strong bg-panel px-2 py-1 text-sm text-ink"
            >
              {platforms.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.id}
                </option>
              ))}
            </select>
          </label>
        )}
      </header>

      <p className="text-xs text-ink-faint">
        Commands run as <strong>root</strong> on the manager box via SSM, exactly as typed, and every
        command is audited. The shell is bare — <code>$HOME</code> is unset — so for kubectl prepend{" "}
        <code className="rounded bg-rail px-1 py-0.5 text-ink-soft">
          export HOME=/root; export KUBECONFIG=/root/.kube/config;
        </code>
      </p>

      <div
        ref={scrollRef}
        data-testid="terminal-scrollback"
        className="h-[58vh] overflow-auto rounded-lg border border-border bg-ink/95 p-3 font-mono text-xs leading-relaxed text-surface"
      >
        {entries.length === 0 ? (
          <p className="text-ink-faint">
            No commands yet. Try <code>echo &quot;HOME=$HOME&quot;; ls -la /root/.kube</code>
          </p>
        ) : (
          entries.map((en, i) => <EntryView key={i} entry={en} />)
        )}
      </div>

      <div className="flex items-center gap-2">
        <span className="font-mono text-sm text-ink-soft" aria-hidden="true">
          $
        </span>
        <input
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="type a command, ↵ to run, ↑/↓ for history"
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="off"
          aria-label="terminal command"
          className="min-w-0 flex-1 rounded-md border border-border-strong bg-panel px-3 py-2 font-mono text-sm text-ink placeholder:text-ink-faint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        />
        <Button variant="primary" busy={busy} onClick={() => void run()} disabled={!input.trim() || !platformId}>
          Run
        </Button>
      </div>
    </div>
  );
}

/** One scrollback row: the echoed command, then stdout / stderr / exit, or an error. */
function EntryView({ entry }: { entry: Entry }): React.ReactElement {
  const r = entry.result;
  return (
    <div className="mb-3">
      <div className="text-accent">
        <span className="select-none text-ink-faint">$ </span>
        {entry.command}
      </div>
      {entry.running && (
        <div className="flex items-center gap-1.5 text-ink-faint">
          <Spinner className="text-surface" /> running…
        </div>
      )}
      {r?.stdout && <pre className="whitespace-pre-wrap break-words text-surface">{r.stdout}</pre>}
      {r?.stderr && <pre className="whitespace-pre-wrap break-words text-warn">{r.stderr}</pre>}
      {r && (
        <div className="text-ink-faint">
          [exit {r.exit ?? "?"} · {r.status}]
        </div>
      )}
      {entry.error && <pre className="whitespace-pre-wrap break-words text-bad">{entry.error}</pre>}
    </div>
  );
}

function Notice({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <div className="mx-auto max-w-lg rounded-lg border border-border bg-panel p-6 text-center text-sm text-ink-soft">
      {children}
    </div>
  );
}
