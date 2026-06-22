// packages/web/test/HealthChip.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as api from "../src/api.js";
import type { BackendHealthSummary } from "../src/api.js";
import { deriveBackendHealth } from "../src/lib/health.js";
import { HealthChip, HealthChipView } from "../src/components/HealthChip.js";

// Keep the REAL ApiError; only stub the network functions (importActual pattern).
vi.mock("../src/api.js", async (importActual) => {
  const actual = await importActual<typeof import("../src/api.js")>();
  return { ...actual, health: vi.fn() };
});
const mockedApi = vi.mocked(api);
beforeEach(() => vi.resetAllMocks());

const summary = (o: Partial<BackendHealthSummary>): BackendHealthSummary => ({
  platform: "api",
  kind: "eks_ssm",
  applicable: true,
  pumba: { ready: true, state: "ready", detail: "Pumba can run here." },
  ingress: { present: true, healthy: true, detail: "ingress-nginx healthy." },
  ...o,
});

describe("deriveBackendHealth", () => {
  it("ok when pumba is ready and ingress is healthy", () => {
    const chip = deriveBackendHealth(summary({}));
    expect(chip).toMatchObject({ tone: "ok", label: "Backends ready" });
  });

  it("bad + 'Chaos image not mirrored' when the image is unreachable", () => {
    const chip = deriveBackendHealth(
      summary({ pumba: { ready: false, state: "image-unreachable", detail: "image not pullable", remediation: "Mirror it to JFrog." } }),
    );
    expect(chip).toMatchObject({ tone: "bad", label: "Chaos image not mirrored", remediation: "Mirror it to JFrog." });
  });

  it("bad + 'Privileged blocked' when privileged pods are denied", () => {
    const chip = deriveBackendHealth(summary({ pumba: { ready: false, state: "privileged-blocked", detail: "PSA blocks privileged" } }));
    expect(chip).toMatchObject({ tone: "bad", label: "Privileged blocked" });
  });

  it("bad + 'Manager unreachable' when the manager jump box is unreachable", () => {
    const chip = deriveBackendHealth(summary({ pumba: { ready: false, state: "manager-unreachable", detail: "SSM offline" } }));
    expect(chip).toMatchObject({ tone: "bad", label: "Manager unreachable" });
  });

  it("flags ingress (chaos tone) when pumba is ready but ingress is unavailable", () => {
    const chip = deriveBackendHealth(
      summary({ ingress: { present: false, healthy: false, detail: "no ingress-nginx", remediation: "Install the controller." } }),
    );
    expect(chip).toMatchObject({ tone: "chaos", label: "Ingress unavailable", remediation: "Install the controller." });
  });

  it("pumba problems outrank an ingress problem", () => {
    const chip = deriveBackendHealth(
      summary({
        pumba: { ready: false, state: "privileged-blocked", detail: "PSA blocks privileged" },
        ingress: { present: false, healthy: false, detail: "no ingress" },
      }),
    );
    expect(chip?.label).toBe("Privileged blocked");
  });

  it("renders nothing for a non-applicable (ECS) platform or when probes are absent", () => {
    expect(deriveBackendHealth({ platform: "mi", kind: "ecs", applicable: false })).toBeNull();
    expect(deriveBackendHealth({ platform: "api", kind: "eks_ssm", applicable: true })).toBeNull();
  });
});

describe("<HealthChipView/>", () => {
  it("shows the label, and reveals detail + remediation on click", async () => {
    render(
      <HealthChipView chip={{ tone: "bad", label: "Chaos image not mirrored", detail: "ghcr.io is blocked here.", remediation: "Mirror gaiaadm/pumba to JFrog and set chaosImage." }} />,
    );
    const btn = screen.getByRole("button", { name: /backend health: chaos image not mirrored/i });
    expect(btn).toHaveTextContent("Chaos image not mirrored");
    // collapsed by default
    expect(screen.queryByText(/ghcr.io is blocked here/)).not.toBeInTheDocument();
    await userEvent.click(btn);
    expect(screen.getByText(/ghcr.io is blocked here/)).toBeInTheDocument();
    expect(screen.getByText(/Mirror gaiaadm\/pumba to JFrog/)).toBeInTheDocument();
  });

  it("omits the remediation line when there is none", async () => {
    render(<HealthChipView chip={{ tone: "ok", label: "Backends ready", detail: "Pumba ready; ingress-nginx healthy." }} />);
    await userEvent.click(screen.getByRole("button", { name: /backend health: backends ready/i }));
    expect(screen.getByText(/Pumba ready; ingress-nginx healthy\./)).toBeInTheDocument();
    expect(screen.queryByText(/^Fix$/)).not.toBeInTheDocument();
  });
});

describe("<HealthChip/> (polling)", () => {
  it("polls the platform health endpoint and renders the derived chip", async () => {
    mockedApi.health.mockResolvedValue(summary({}));
    render(<HealthChip platformId="api" />);
    expect(await screen.findByRole("button", { name: /backend health: backends ready/i })).toBeInTheDocument();
    await waitFor(() => expect(mockedApi.health).toHaveBeenCalledWith("api"));
  });

  it("renders nothing (no chip, no error banner) when the health probe fails", async () => {
    mockedApi.health.mockRejectedValue(new api.ApiError("MANAGER_UNREACHABLE", "manager offline", 502));
    const { container } = render(<HealthChip platformId="api" />);
    // Give the rejected poll a tick to settle; the chip stays absent.
    await waitFor(() => expect(mockedApi.health).toHaveBeenCalled());
    expect(container.querySelector("button")).toBeNull();
  });
});
