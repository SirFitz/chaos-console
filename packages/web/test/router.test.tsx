// packages/web/test/router.test.tsx
import { describe, it, expect, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useHashRoute, serviceHash } from "../src/router.js";

beforeEach(() => {
  window.location.hash = "";
});

describe("useHashRoute", () => {
  it("defaults to the inventory tab", () => {
    const { result } = renderHook(() => useHashRoute());
    expect(result.current.location).toEqual({ kind: "route", route: "inventory" });
    expect(result.current.route).toBe("inventory");
  });

  it("parses the three nav tabs", () => {
    window.location.hash = "#/audit";
    const { result } = renderHook(() => useHashRoute());
    expect(result.current.location).toEqual({ kind: "route", route: "audit" });
  });

  it("parses a per-service detail location (#/service/:platformId/:name)", () => {
    window.location.hash = "#/service/api/payments";
    const { result } = renderHook(() => useHashRoute());
    expect(result.current.location).toEqual({ kind: "service", platformId: "api", name: "payments" });
    // A service page hangs off Inventory, so the active tab stays "inventory".
    expect(result.current.route).toBe("inventory");
  });

  it("decodes encoded segments in a service location", () => {
    window.location.hash = "#/service/api/bps-payments%2Fsvc";
    const { result } = renderHook(() => useHashRoute());
    expect(result.current.location).toEqual({ kind: "service", platformId: "api", name: "bps-payments/svc" });
  });

  it("navigateToService writes the encoded service hash and updates the location", () => {
    const { result } = renderHook(() => useHashRoute());
    act(() => result.current.navigateToService("api", "pay/ments"));
    expect(window.location.hash).toBe(serviceHash("api", "pay/ments"));
    expect(result.current.location).toEqual({ kind: "service", platformId: "api", name: "pay/ments" });
  });

  it("navigate switches between nav tabs", () => {
    const { result } = renderHook(() => useHashRoute());
    act(() => result.current.navigate("chaos"));
    expect(result.current.location).toEqual({ kind: "route", route: "chaos" });
  });
});
