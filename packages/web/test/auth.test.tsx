import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as api from "../src/api.js";
import { AuthProvider, useAuth, RequireAuth, isOperator } from "../src/auth.js";

// Mock the network functions but keep the REAL ApiError class (vitest's bare
// auto-mock stubs the constructor, blanking message/code). See Login.test.tsx.
vi.mock("../src/api.js", async (importActual) => {
  const actual = await importActual<typeof import("../src/api.js")>();
  return {
    ...actual,
    me: vi.fn(),
    login: vi.fn(),
    logout: vi.fn(),
    listPlatforms: vi.fn(),
    services: vi.fn(),
    act: vi.fn(),
    chaosActive: vi.fn(),
    audit: vi.fn(),
  };
});
const mockedApi = vi.mocked(api);
beforeEach(() => vi.resetAllMocks());

function Probe() {
  const { user, login, logout } = useAuth();
  return (
    <div>
      <span data-testid="who">{user ? `${user.username}:${user.role}` : "anon"}</span>
      <button onClick={() => login("o", "pw")}>do-login</button>
      <button onClick={() => logout()}>do-logout</button>
    </div>
  );
}

describe("isOperator", () => {
  it("is true only for operator", () => {
    expect(isOperator("operator")).toBe(true);
    expect(isOperator("viewer")).toBe(false);
    expect(isOperator(undefined)).toBe(false);
  });
});

describe("AuthProvider", () => {
  it("resolves the current session from me() on mount", async () => {
    mockedApi.me.mockResolvedValue({ username: "v", role: "viewer" });
    render(<AuthProvider><Probe /></AuthProvider>);
    await waitFor(() => expect(screen.getByTestId("who")).toHaveTextContent("v:viewer"));
  });

  it("stays anonymous when me() rejects (401)", async () => {
    mockedApi.me.mockRejectedValue(new api.ApiError("UNAUTH", "no", 401));
    render(<AuthProvider><Probe /></AuthProvider>);
    await waitFor(() => expect(screen.getByTestId("who")).toHaveTextContent("anon"));
  });

  it("login() sets the user; logout() clears it", async () => {
    mockedApi.me.mockRejectedValue(new api.ApiError("UNAUTH", "no", 401));
    mockedApi.login.mockResolvedValue({ username: "o", role: "operator" });
    mockedApi.logout.mockResolvedValue(undefined);
    render(<AuthProvider><Probe /></AuthProvider>);
    await waitFor(() => expect(screen.getByTestId("who")).toHaveTextContent("anon"));
    await userEvent.click(screen.getByText("do-login"));
    await waitFor(() => expect(screen.getByTestId("who")).toHaveTextContent("o:operator"));
    await userEvent.click(screen.getByText("do-logout"));
    await waitFor(() => expect(screen.getByTestId("who")).toHaveTextContent("anon"));
  });
});

describe("RequireAuth", () => {
  it("renders fallback while unauthenticated and children once authed", async () => {
    mockedApi.me.mockResolvedValue({ username: "o", role: "operator" });
    render(
      <AuthProvider>
        <RequireAuth fallback={<div>please log in</div>}>
          <div>secret</div>
        </RequireAuth>
      </AuthProvider>,
    );
    expect(screen.queryByText("secret")).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("secret")).toBeInTheDocument());
  });
});
