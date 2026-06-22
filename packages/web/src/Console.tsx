// packages/web/src/Console.tsx
import React, { useEffect, useState } from "react";
import type { Kind, ServiceStatus } from "@chaos/shared";
import * as api from "./api.js";
import type { SessionUser } from "./api.js";
import { useHashRoute, type Route } from "./router.js";
import { useLivePoll } from "./lib/useLivePoll.js";
import { activeChaosCount } from "./lib/chaos.js";
import { LiveStatusProvider } from "./lib/liveStatus.js";
import { Sidebar } from "./components/Sidebar.js";
import { TopBar } from "./components/TopBar.js";
import { Inventory } from "./pages/Inventory.js";
import { ActiveChaos } from "./pages/ActiveChaos.js";
import { AuditView } from "./pages/AuditView.js";
import { ServiceDetail } from "./pages/ServiceDetail.js";
import { ChaosDrawer } from "./components/ChaosDrawer.js";

const TITLES: Record<Route, string> = {
  inventory: "Inventory",
  chaos: "Active chaos",
  audit: "Audit",
};

export function Console({
  user,
  onLogout,
}: {
  user: SessionUser;
  onLogout: () => void;
}): React.ReactElement {
  const { location, route, navigate, navigateToService } = useHashRoute();
  const [kinds, setKinds] = useState<Record<string, Kind>>({});
  // The right-side drawer target. `mode` distinguishes the full action menu
  // from the network-only chaos surface; both share <ChaosDrawer/>.
  const [drawer, setDrawer] = useState<{ service: ServiceStatus; mode: "actions" | "network" } | null>(null);
  const [navOpen, setNavOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    api
      .listPlatforms()
      .then((ps) => {
        if (!alive) return;
        const m: Record<string, Kind> = {};
        for (const p of ps) m[p.id] = p.kind;
        setKinds(m);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  // Lightweight, shell-level poll just for the nav badge count. The Active chaos
  // page runs its own authoritative live view.
  const chaos = useLivePoll(api.chaosActive, 10_000);
  const chaosCount = chaos.data ? activeChaosCount(chaos.data) : null;

  const closeDrawer = () => setDrawer(null);
  const afterAction = () => {
    void chaos.refresh();
  };

  return (
    <LiveStatusProvider>
      <div className="grid min-h-screen grid-cols-1 lg:grid-cols-[232px_minmax(0,1fr)]">
        {/* Sidebar — static on lg+, slide-over below. */}
        <aside className="sticky top-0 hidden h-screen border-r border-border lg:block">
          <Sidebar
            route={route}
            navigate={navigate}
            role={user.role}
            username={user.username}
            chaosCount={chaosCount}
            onLogout={onLogout}
          />
        </aside>

        {navOpen && (
          <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label="Navigation">
            <button
              type="button"
              aria-label="Close navigation"
              className="absolute inset-0 bg-ink/30 animate-fade-in"
              onClick={() => setNavOpen(false)}
            />
            <div className="absolute left-0 top-0 h-full w-[232px] border-r border-border shadow-xl">
              <Sidebar
                route={route}
                navigate={navigate}
                role={user.role}
                username={user.username}
                chaosCount={chaosCount}
                onLogout={onLogout}
                onNavigate={() => setNavOpen(false)}
              />
            </div>
          </div>
        )}

        <div className="flex min-w-0 flex-col">
          <TopBar
            title={location.kind === "service" ? location.name : TITLES[route]}
            username={user.username}
            onToggleSidebar={() => setNavOpen((v) => !v)}
          />
          <main className="min-w-0 flex-1 px-4 py-5 sm:px-6">
            {location.kind === "service" ? (
              <ServiceDetail
                key={`${location.platformId}:${location.name}`}
                platformId={location.platformId}
                name={location.name}
                role={user.role}
                onBack={() => navigate("inventory")}
                onOpenActions={(s) => setDrawer({ service: s, mode: "actions" })}
              />
            ) : (
              <>
                {route === "inventory" && (
                  <Inventory
                    role={user.role}
                    onAct={(s) => setDrawer({ service: s, mode: "actions" })}
                    onNetwork={(s) => setDrawer({ service: s, mode: "network" })}
                    onOpenService={(s) => navigateToService(s.platformId, s.name)}
                  />
                )}
                {route === "chaos" && <ActiveChaos role={user.role} />}
                {route === "audit" && <AuditView />}
              </>
            )}
          </main>
        </div>

        {drawer && (
          <ChaosDrawer
            service={drawer.service}
            kind={kinds[drawer.service.platformId] ?? "ecs"}
            role={user.role}
            mode={drawer.mode}
            onClose={closeDrawer}
            onDone={afterAction}
          />
        )}
      </div>
    </LiveStatusProvider>
  );
}
