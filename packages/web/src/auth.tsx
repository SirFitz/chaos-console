import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { Role } from "@chaos/shared";
import * as api from "./api.js";
import type { SessionUser } from "./api.js";

interface AuthState {
  user: SessionUser | null;
  loading: boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function isOperator(role: Role | undefined): boolean {
  return role === "operator";
}

export function AuthProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    api
      .me()
      .then((u) => { if (alive) setUser(u); })
      .catch(() => { if (alive) setUser(null); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);

  const login = useCallback(async (username: string, password: string) => {
    setUser(await api.login(username, password));
  }, []);

  const logout = useCallback(async () => {
    await api.logout();
    setUser(null);
  }, []);

  const value = useMemo<AuthState>(() => ({ user, loading, login, logout }), [user, loading, login, logout]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within <AuthProvider>");
  return ctx;
}

export function RequireAuth({
  children,
  fallback,
}: {
  children: React.ReactNode;
  fallback: React.ReactNode;
}): React.ReactElement {
  const { user, loading } = useAuth();
  if (loading) return <p>Loading…</p>;
  return <>{user ? children : fallback}</>;
}
