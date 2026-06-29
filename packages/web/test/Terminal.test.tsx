// packages/web/test/Terminal.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as api from "../src/api.js";
import { Terminal } from "../src/pages/Terminal.js";

// Mock only the network calls; keep the real ApiError class (importActual pattern).
vi.mock("../src/api.js", async (importActual) => {
  const actual = await importActual<typeof import("../src/api.js")>();
  return { ...actual, listPlatforms: vi.fn(), execCommand: vi.fn() };
});
const mockedApi = vi.mocked(api);

const eks = [{ id: "api", layer: "API" as const, kind: "eks_ssm" as const, region: "us-east-1" }];

beforeEach(() => {
  vi.clearAllMocks();
  mockedApi.listPlatforms.mockResolvedValue(eks as never);
});

/** Type a command and run it via the Run button (waits for the platform to load). */
async function runCommand(text: string) {
  const input = await screen.findByLabelText(/terminal command/i);
  await userEvent.type(input, text);
  const runBtn = screen.getByRole("button", { name: /run/i });
  await waitFor(() => expect(runBtn).toBeEnabled());
  await userEvent.click(runBtn);
}

describe("Terminal", () => {
  it("a viewer sees an operator-required notice (no input)", () => {
    render(<Terminal role="viewer" />);
    expect(screen.getByText(/requires the/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/terminal command/i)).not.toBeInTheDocument();
  });

  it("an operator runs a command and sees stdout + exit, and calls the API with the platform", async () => {
    mockedApi.execCommand.mockResolvedValue({
      result: { command: "whoami", stdout: "root\n", stderr: "", exit: 0, status: "Success" },
      auditId: "a1",
    });
    render(<Terminal role="operator" />);
    await runCommand("whoami");
    // Scope to the scrollback — "root" also appears in the page's <strong>root</strong> hint.
    const sb = within(screen.getByTestId("terminal-scrollback"));
    expect(await sb.findByText("root")).toBeInTheDocument();
    expect(sb.getByText(/exit 0/)).toBeInTheDocument();
    expect(mockedApi.execCommand).toHaveBeenCalledWith("api", "whoami");
  });

  it("shows stderr + the exit code for a failing command without throwing", async () => {
    mockedApi.execCommand.mockResolvedValue({
      result: { command: "ls /nope", stdout: "", stderr: "ls: /nope: No such file or directory", exit: 2, status: "Failed" },
      auditId: "a1",
    });
    render(<Terminal role="operator" />);
    await runCommand("ls /nope");
    expect(await screen.findByText(/No such file or directory/)).toBeInTheDocument();
    expect(screen.getByText(/exit 2/)).toBeInTheDocument();
  });

  it("surfaces an API error in the scrollback", async () => {
    mockedApi.execCommand.mockRejectedValue(new api.ApiError("MANAGER_UNREACHABLE", "manager down", 502));
    render(<Terminal role="operator" />);
    await runCommand("whoami");
    expect(await screen.findByText(/manager down/i)).toBeInTheDocument();
  });
});
