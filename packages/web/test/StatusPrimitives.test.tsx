// packages/web/test/StatusPrimitives.test.tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import type { ServiceStatus } from "@chaos/shared";
import { ServiceStatusPill } from "../src/components/StatusPill.js";
import { ReplicaMeter } from "../src/components/ReplicaMeter.js";

const svc = (o: Partial<ServiceStatus>): ServiceStatus => ({
  platformId: "mi",
  layer: "MI",
  name: "x",
  mapped: true,
  ...o,
});

describe("<ServiceStatusPill/>", () => {
  it("reads 'Running' for a healthy service", () => {
    render(<ServiceStatusPill s={svc({ running: 2, desired: 2 })} />);
    expect(screen.getByText("Running")).toBeInTheDocument();
  });

  it("reads 'Stopped' when nothing runs but something is desired", () => {
    render(<ServiceStatusPill s={svc({ running: 0, desired: 2 })} />);
    expect(screen.getByText("Stopped")).toBeInTheDocument();
  });

  it("reads 'Scaling' mid-transition", () => {
    render(<ServiceStatusPill s={svc({ running: 1, desired: 3 })} />);
    expect(screen.getByText("Scaling")).toBeInTheDocument();
  });
});

describe("<ReplicaMeter/> — never a naked 0/2", () => {
  it("renders 'N / N' for known counts with an accessible label", () => {
    render(<ReplicaMeter s={svc({ running: 2, desired: 2 })} />);
    expect(screen.getByText("2 / 2")).toBeInTheDocument();
    expect(screen.getByLabelText("2 running of 2 desired")).toBeInTheDocument();
  });

  it("renders an em dash for unknown counts, not '0/0'", () => {
    render(<ReplicaMeter s={svc({})} />);
    expect(screen.getByLabelText(/unknown/i)).toBeInTheDocument();
    expect(screen.queryByText(/0\s*\/\s*0/)).not.toBeInTheDocument();
  });

  it("shows '0 / 2' (bad) when stopped, which is meaningful, not unknown", () => {
    render(<ReplicaMeter s={svc({ running: 0, desired: 2 })} />);
    expect(screen.getByText("0 / 2")).toBeInTheDocument();
  });
});
