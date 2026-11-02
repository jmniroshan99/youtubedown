import type { Session } from "@supabase/supabase-js";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  session: null as Session | null,
  getSession: vi.fn(), initialize: vi.fn(), signUp: vi.fn(), password: vi.fn(), oauth: vi.fn(), reset: vi.fn(), update: vi.fn(), captcha: vi.fn(), redirect: vi.fn(),
}));
vi.hoisted(() => {
  vi.stubEnv("VITE_SUPABASE_URL", "https://test.supabase.co");
  vi.stubEnv("VITE_SUPABASE_PUBLISHABLE_KEY", "public-test-key");
});
vi.mock("../src/lib", () => ({
  supabase: { auth: { getSession: state.getSession, initialize: state.initialize, signUp: state.signUp, signInWithPassword: state.password, signInWithOAuth: state.oauth, resetPasswordForEmail: state.reset, updateUser: state.update } },
  cn: (...values: unknown[]) => values.filter(Boolean).join(" "),
}));
vi.mock("../src/context", () => ({ useApp: () => ({ session: state.session, loading: false, getCaptchaToken: state.captcha }) }));
vi.mock("../src/authSupport", async (original) => ({ ...(await original<typeof import("../src/authSupport")>()), redirectToProvider: state.redirect }));
import { AuthCallback, AuthPage } from "../src/auth";
import { authSchema, callbackFailure, safeReturnPath } from "../src/authSupport";

const permanent = { user: { id: "account-a", is_anonymous: false }, access_token: "test-token" } as Session;
const guest = { user: { id: "guest-a", is_anonymous: true }, access_token: "guest-token" } as Session;
const oauthURL = (provider: string) => "https://test.supabase.co/auth/v1/authorize?provider=" + provider + "&redirect_to=" + encodeURIComponent(window.location.origin + "/auth/callback");

function page(mode: "login" | "register" | "forgot" | "reset" = "register", from?: string) {
  return render(<MemoryRouter initialEntries={[{ pathname: "/form", state: { from } }]}><Routes>
    <Route path="/form" element={<AuthPage mode={mode} />} />
    <Route path="/" element={<h1>Home route</h1>} />
    <Route path="/downloads" element={<h1>Downloads route</h1>} />
    <Route path="/settings" element={<h1>Settings route</h1>} />
  </Routes></MemoryRouter>);
}
function fillRegister(confirm = "password-123") {
  fireEvent.change(screen.getByLabelText("Full name"), { target: { value: "  ශ්‍රී User  " } });
  fireEvent.change(screen.getByLabelText("Email address"), { target: { value: " person@example.com " } });
  fireEvent.change(screen.getByLabelText("Password", { exact: true }), { target: { value: "password-123" } });
  fireEvent.change(screen.getByLabelText("Confirm password"), { target: { value: confirm } });
}
function callback() {
  return render(<MemoryRouter initialEntries={["/auth/callback"]}><Routes><Route path="/auth/callback" element={<AuthCallback />} /><Route path="/" element={<h1>Home route</h1>} /></Routes></MemoryRouter>);
}

beforeEach(() => {
  state.session = null;
  state.getSession.mockReset().mockResolvedValue({ data: { session: null }, error: null });
  state.initialize.mockReset().mockResolvedValue({ error: null });
  state.signUp.mockReset().mockResolvedValue({ data: { session: null }, error: null });
  state.password.mockReset().mockResolvedValue({ data: { session: permanent }, error: null });
  state.oauth.mockReset().mockImplementation(async ({ provider }) => ({ data: { url: oauthURL(provider) }, error: null }));
  state.reset.mockReset().mockResolvedValue({ data: {}, error: null });
  state.update.mockReset().mockResolvedValue({ data: {}, error: null });
  state.captcha.mockReset().mockResolvedValue("captcha-test");
  state.redirect.mockReset();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ external: { google: true, facebook: true } }), { status: 200 })));
  window.history.replaceState(null, "", "/");
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

it("register has exactly four fields and two optional social providers", () => {
  const rendered = page();
  expect(rendered.container.querySelectorAll("input")).toHaveLength(4);
  for (const label of ["Full name", "Email address", "Password", "Confirm password"]) expect(screen.getByLabelText(label, { exact: true })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Continue with Google" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Continue with Facebook" })).toBeTruthy();
  expect(screen.getByRole("link", { name: "Continue as guest" })).toBeTruthy();
});

it("validates matching confirmation inline and sends only permitted signup fields", async () => {
  page(); fillRegister("different-password");
  fireEvent.click(screen.getByRole("button", { name: "Create account" }));
  await screen.findByText("Your passwords do not match.");
  expect(screen.getByLabelText("Confirm password").getAttribute("aria-invalid")).toBe("true");
  expect(state.signUp).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("Confirm password"), { target: { value: "password-123" } });
  fireEvent.click(screen.getByRole("button", { name: "Create account" }));
  await screen.findByText(/Check your email for the confirmation link/);
  expect(state.signUp).toHaveBeenCalledExactlyOnceWith({
    email: "person@example.com", password: "password-123",
    options: { data: { full_name: "ශ්‍රී User" }, captchaToken: "captcha-test", emailRedirectTo: window.location.origin + "/auth/callback" },
  });
});

it("validates each required registration field before any Auth request", async () => {
  page(); fireEvent.click(screen.getByRole("button", { name: "Create account" }));
  await screen.findByText("Enter your name using 1–100 characters.");
  expect(screen.getByText("Enter a valid email address.")).toBeTruthy();
  expect(screen.getByText("Use at least 8 characters.")).toBeTruthy();
  expect(state.signUp).not.toHaveBeenCalled();
});

it("immediate signup sessions go to the app without a false email prompt", async () => {
  state.signUp.mockResolvedValue({ data: { session: permanent }, error: null });
  page(); fillRegister(); fireEvent.click(screen.getByRole("button", { name: "Create account" }));
  await screen.findByRole("heading", { name: "Home route" });
  expect(screen.queryByText(/Check your email/)).toBeNull();
});

it.each(["google", "facebook"] as const)("%s uses public availability and a real PKCE OAuth start", async (provider) => {
  page("login");
  fireEvent.click(screen.getByRole("button", { name: "Continue with " + (provider === "google" ? "Google" : "Facebook") }));
  await waitFor(() => expect(state.redirect).toHaveBeenCalledExactlyOnceWith(oauthURL(provider), provider));
  expect(state.oauth).toHaveBeenCalledExactlyOnceWith({ provider, options: {
    redirectTo: window.location.origin + "/auth/callback", scopes: provider === "google" ? "openid email profile" : "email", skipBrowserRedirect: true,
  } });
  expect(fetch).toHaveBeenCalledExactlyOnceWith("https://test.supabase.co/auth/v1/settings", expect.objectContaining({ headers: { apikey: "public-test-key" }, cache: "no-store" }));
  expect(state.password).not.toHaveBeenCalled();
});

it("disabled providers stay in the app with an email/guest alternative", async () => {
  vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ external: { google: false } }), { status: 200 }));
  page(); fireEvent.click(screen.getByRole("button", { name: "Continue with Google" }));
  await screen.findByText("Google sign-in is not available yet. Use email or continue as a guest.");
  expect(state.oauth).not.toHaveBeenCalled(); expect(state.redirect).not.toHaveBeenCalled();
});

it("rapid OAuth clicks are deduplicated while public settings are pending", async () => {
  let resolve!: (response: Response) => void;
  vi.mocked(fetch).mockImplementation(() => new Promise<Response>((done) => { resolve = done; }));
  page(); const button = screen.getByRole("button", { name: "Continue with Facebook" });
  fireEvent.click(button); fireEvent.click(button);
  await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
  await act(async () => resolve(new Response(JSON.stringify({ external: { facebook: true } }))));
  await waitFor(() => expect(state.oauth).toHaveBeenCalledOnce());
  expect(state.redirect).toHaveBeenCalledOnce();
});

it("leaving during OAuth preflight never causes a late provider redirect", async () => {
  let resolve!: (response: Response) => void;
  vi.mocked(fetch).mockImplementation(() => new Promise<Response>((done) => { resolve = done; }));
  const rendered = page(); fireEvent.click(screen.getByRole("button", { name: "Continue with Google" }));
  await waitFor(() => expect(fetch).toHaveBeenCalledOnce()); rendered.unmount();
  await act(async () => resolve(new Response(JSON.stringify({ external: { google: true } }))));
  expect(state.oauth).not.toHaveBeenCalled(); expect(state.redirect).not.toHaveBeenCalled();
});

it("leaving during SDK URL generation never performs its delayed redirect", async () => {
  let resolve!: (result: unknown) => void;
  state.oauth.mockImplementation(() => new Promise((done) => { resolve = done; }));
  const rendered = page(); fireEvent.click(screen.getByRole("button", { name: "Continue with Google" }));
  await waitFor(() => expect(state.oauth).toHaveBeenCalledOnce()); rendered.unmount();
  await act(async () => resolve({ data: { url: oauthURL("google") }, error: null }));
  expect(state.redirect).not.toHaveBeenCalled();
});

it("another tab's permanent session is reused rather than replaced", async () => {
  state.getSession.mockResolvedValue({ data: { session: permanent }, error: null });
  page("login"); fireEvent.click(screen.getByRole("button", { name: "Continue with Google" }));
  await screen.findByRole("heading", { name: "Home route" });
  expect(fetch).not.toHaveBeenCalled(); expect(state.oauth).not.toHaveBeenCalled();
});

it("guest ownership is not claimed to transfer when signing in", () => {
  state.session = guest; page();
  expect(screen.getByText(/does not transfer your guest downloads/)).toBeTruthy();
});

it("login allows existing short passwords and blocks external return locations", async () => {
  page("login", "//attacker.example/path");
  fireEvent.change(screen.getByLabelText("Email address"), { target: { value: "user@example.com" } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "old" } });
  fireEvent.click(screen.getByRole("button", { name: "Sign in", exact: true }));
  await screen.findByRole("heading", { name: "Home route" });
  expect(state.password).toHaveBeenCalledExactlyOnceWith({ email: "user@example.com", password: "old", options: { captchaToken: "captcha-test" } });
  expect(safeReturnPath("https://attacker.example")).toBe("/");
  expect(safeReturnPath("/\\attacker.example")).toBe("/");
  expect(safeReturnPath("/downloads?page=2")).toBe("/downloads?page=2");
});

it("forgot/reset modes retain their own fields and validation", async () => {
  const rendered = page("forgot");
  expect(rendered.container.querySelectorAll("input")).toHaveLength(1);
  expect(screen.queryByRole("button", { name: /Continue with Google/ })).toBeNull();
  fireEvent.change(screen.getByLabelText("Email address"), { target: { value: "user@example.com" } });
  fireEvent.click(screen.getByRole("button", { name: "Reset password" }));
  await screen.findByText(/If this email can receive a reset link/);
  expect(state.reset).toHaveBeenCalledWith("user@example.com", expect.objectContaining({ redirectTo: window.location.origin + "/reset-password" }));
  expect(authSchema("reset").safeParse({ fullName: "", email: "", password: "long-password", confirmPassword: "" }).success).toBe(true);
});

it("callback cancellation wins over an existing account and scrubs URL errors", async () => {
  state.session = permanent;
  window.history.replaceState(null, "", "/auth/callback?error=access_denied&error_description=private-token-description#access_token=not-displayable");
  callback();
  await screen.findByRole("heading", { name: "Sign-in not completed" });
  await waitFor(() => expect(window.location.search + window.location.hash).toBe(""));
  expect(screen.getByText(/Sign-in was cancelled/)).toBeTruthy();
  expect(screen.queryByRole("heading", { name: "Home route" })).toBeNull();
  expect(document.body.textContent).not.toContain("private-token-description");
});

it("a failed PKCE initialization cannot turn an old saved account into callback success", async () => {
  state.session = permanent;
  state.initialize.mockResolvedValue({ error: new Error("private code exchange failure") });
  state.getSession.mockResolvedValue({ data: { session: permanent }, error: null });
  window.history.replaceState(null, "", "/auth/callback?code=expired-private-code");
  callback(); await screen.findByRole("heading", { name: "Sign-in not completed" });
  expect(state.getSession).not.toHaveBeenCalled();
  expect(screen.queryByRole("heading", { name: "Home route" })).toBeNull();
  expect(document.body.textContent).not.toContain("private code");
  expect(window.location.search).toBe("");
});

it("callback waits for existing initialization before removing its PKCE code", async () => {
  let resolve!: (result: { error: null }) => void;
  state.initialize.mockImplementation(() => new Promise((done) => { resolve = done; }));
  state.session = permanent;
  state.getSession.mockResolvedValue({ data: { session: permanent }, error: null });
  window.history.replaceState(null, "", "/auth/callback?code=one-time-code");
  callback();
  expect(window.location.search).toBe("?code=one-time-code");
  expect(screen.queryByRole("heading", { name: "Home route" })).toBeNull();
  await act(async () => resolve({ error: null }));
  await screen.findByRole("heading", { name: "Home route" });
  expect(state.initialize).toHaveBeenCalledOnce();
  expect(window.location.search).toBe("");
});

it("callback errors never echo untrusted provider descriptions", () => {
  expect(callbackFailure("https://example.com/auth/callback?error=unknown&error_description=secret-text")).not.toContain("secret-text");
});

it("changing auth mode clears hidden credentials and cancels a pending captcha submission", async () => {
  let resolve!: (token: string) => void;
  state.captcha.mockImplementation(() => new Promise((done) => { resolve = done; }));
  const rendered = render(<MemoryRouter><AuthPage mode="register" /></MemoryRouter>);
  fillRegister(); fireEvent.click(screen.getByRole("button", { name: "Create account" }));
  await waitFor(() => expect(state.captcha).toHaveBeenCalledOnce());
  rendered.rerender(<MemoryRouter><AuthPage mode="login" /></MemoryRouter>);
  expect(screen.queryByLabelText("Full name")).toBeNull();
  expect(screen.getByLabelText("Email address")).toHaveProperty("value", "");
  expect(screen.getByLabelText("Password")).toHaveProperty("value", "");
  await act(async () => resolve("late-captcha"));
  expect(state.signUp).not.toHaveBeenCalled();
  expect(state.password).not.toHaveBeenCalled();
});

it("slow callbacks do not invent expiry and can still succeed", async () => {
  vi.useFakeTimers();
  let resolve!: (result: { error: null }) => void;
  state.initialize.mockImplementation(() => new Promise((done) => { resolve = done; }));
  state.session = permanent;
  state.getSession.mockResolvedValue({ data: { session: permanent }, error: null });
  window.history.replaceState(null, "", "/auth/callback?code=still-valid");
  callback();
  await act(async () => vi.advanceTimersByTime(12_000));
  expect(screen.getByText(/Sign-in is taking longer than expected/)).toBeTruthy();
  expect(document.body.textContent).not.toContain("expired");
  expect(window.location.search).toBe("?code=still-valid");
  await act(async () => resolve({ error: null }));
  expect(screen.getByRole("heading", { name: "Home route" })).toBeTruthy();
  expect(window.location.search).toBe("");
});

it("provider redirects reject foreign, wrong-provider and wrong-callback addresses", async () => {
  const actual = await vi.importActual<typeof import("../src/authSupport")>("../src/authSupport");
  for (const url of ["https://attacker.example/auth/v1/authorize?provider=google", oauthURL("facebook"), "https://test.supabase.co/auth/v1/authorize?provider=google&redirect_to=https://attacker.example"])
    expect(() => actual.redirectToProvider(url, "google")).toThrow("invalid address");
});
