import { useEffect, useState, useCallback } from "react";

/** The top-level nav tabs (drive the sidebar + top-bar title). */
export type Route = "inventory" | "chaos" | "audit" | "terminal";
const ROUTES: Route[] = ["inventory", "chaos", "audit", "terminal"];

/**
 * The parsed hash location. Either one of the three nav tabs, or a per-service
 * detail page (`#/service/:platformId/:name`). Kept separate from `Route` so the
 * sidebar/title machinery, which only knows the three tabs, stays unchanged.
 */
export type Location =
  | { kind: "route"; route: Route }
  | { kind: "service"; platformId: string; name: string };

/** Build the hash for a per-service detail page (segments encoded). */
export function serviceHash(platformId: string, name: string): string {
  return `#/service/${encodeURIComponent(platformId)}/${encodeURIComponent(name)}`;
}

function parse(): Location {
  const h = window.location.hash.replace(/^#\/?/, "");
  const segs = h.split("/").filter(Boolean);
  // #/service/:platformId/:name  -> a service detail page.
  if (segs[0] === "service" && segs.length >= 3) {
    const platformId = decodeURIComponent(segs[1]);
    // Re-join any trailing segments so a service name that itself contains a
    // "/" survives (defensive — names are flat today, but the encode is lossy
    // if we assumed exactly 3 segments).
    const name = decodeURIComponent(segs.slice(2).join("/"));
    if (platformId && name) return { kind: "service", platformId, name };
  }
  const route = (ROUTES as string[]).includes(segs[0]) ? (segs[0] as Route) : "inventory";
  return { kind: "route", route };
}

export interface HashRouter {
  /** The current parsed location. */
  location: Location;
  /**
   * The active top-level tab. A service detail page reports the tab it hangs
   * off ("inventory"), so the sidebar keeps Inventory highlighted while a
   * detail page is open.
   */
  route: Route;
  /** Navigate to one of the three nav tabs. */
  navigate: (r: Route) => void;
  /** Navigate to a per-service detail page. */
  navigateToService: (platformId: string, name: string) => void;
}

export function useHashRoute(): HashRouter {
  const [location, setLocation] = useState<Location>(parse());
  useEffect(() => {
    const onChange = () => setLocation(parse());
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  // Navigation sets the hash AND updates state synchronously, so the location is
  // correct on the next render without waiting for the (async in jsdom)
  // hashchange event; the listener above still catches external hash changes
  // (back/forward, hand-edited URL) and keeps a single source of truth via parse().
  const navigate = useCallback((r: Route) => {
    window.location.hash = `#/${r}`;
    setLocation({ kind: "route", route: r });
  }, []);
  const navigateToService = useCallback((platformId: string, name: string) => {
    window.location.hash = serviceHash(platformId, name);
    setLocation({ kind: "service", platformId, name });
  }, []);
  // A service detail page hangs off Inventory, so the tab highlight stays there.
  const route: Route = location.kind === "service" ? "inventory" : location.route;
  return { location, route, navigate, navigateToService };
}
