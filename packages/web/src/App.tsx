// packages/web/src/App.tsx
import React from "react";
import { AuthProvider, useAuth } from "./auth.js";
import { Login } from "./pages/Login.js";
import { Console } from "./Console.js";
import { Spinner } from "./components/ui.js";

function Gate(): React.ReactElement {
  const { user, loading, logout } = useAuth();
  if (loading) {
    return (
      <div className="grid min-h-screen place-items-center bg-surface text-ink-soft">
        <span className="inline-flex items-center gap-2 text-sm">
          <Spinner />
          Loading
        </span>
      </div>
    );
  }
  if (!user) return <Login />;
  return <Console user={user} onLogout={() => void logout()} />;
}

export function App(): React.ReactElement {
  return (
    <AuthProvider>
      <Gate />
    </AuthProvider>
  );
}
