import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as api from "../src/api.js";
import { AuthProvider } from "../src/auth.js";
import { Login } from "../src/pages/Login.js";

// Mock the network functions but keep the REAL ApiError class. vitest's bare
// auto-mock stubs the ApiError constructor (message/code become empty), which
// would silently swallow the error text the UI surfaces. Preserving the actual
// class via importActual keeps `instanceof` AND `.message`/`.code` truthful.
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

function setup() {
  mockedApi.me.mockRejectedValue(new api.ApiError("UNAUTH", "no", 401));
  render(<AuthProvider><Login /></AuthProvider>);
}

describe("<Login/>", () => {
  it("submits username + password via the auth context", async () => {
    mockedApi.login.mockResolvedValue({ username: "o", role: "operator" });
    setup();
    await userEvent.type(screen.getByLabelText(/username/i), "o");
    await userEvent.type(screen.getByLabelText(/password/i), "pw");
    await userEvent.click(screen.getByRole("button", { name: /sign in/i }));
    await waitFor(() => expect(mockedApi.login).toHaveBeenCalledWith("o", "pw"));
  });

  it("shows the error message on a 401", async () => {
    mockedApi.login.mockRejectedValue(new api.ApiError("UNAUTH", "invalid credentials", 401));
    setup();
    await userEvent.type(screen.getByLabelText(/username/i), "o");
    await userEvent.type(screen.getByLabelText(/password/i), "bad");
    await userEvent.click(screen.getByRole("button", { name: /sign in/i }));
    expect(await screen.findByText(/invalid credentials/i)).toBeInTheDocument();
  });

  it("disables the button while submitting", async () => {
    let resolve!: (u: { username: string; role: "operator" }) => void;
    mockedApi.login.mockReturnValue(new Promise((r) => { resolve = r; }));
    setup();
    await userEvent.type(screen.getByLabelText(/username/i), "o");
    await userEvent.type(screen.getByLabelText(/password/i), "pw");
    await userEvent.click(screen.getByRole("button", { name: /sign in/i }));
    expect(screen.getByRole("button", { name: /signing in/i })).toBeDisabled();
    resolve({ username: "o", role: "operator" });
  });
});
