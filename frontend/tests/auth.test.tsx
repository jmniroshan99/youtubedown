import type { AuthChangeEvent, Session } from "@supabase/supabase-js";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  session: null as Session | null,
  authListener: null as null | ((event: AuthChangeEvent, session: Session | null) => void),
  getSession: vi.fn(), initialize: vi.fn(), signUp: vi.fn(), password: vi.fn(), oauth: vi.fn(), reset: vi.fn(), update: vi.fn(), recoveryUpdate: vi.fn(), captcha: vi.fn(), redirect: vi.fn(),
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
import { AuthFlowError, authSchema, callbackFailure, friendlyAuthError, safeReturnPath } from "../src/authSupport";
import { hasRecoveryAuthority, observeRecoveryAuth } from "../src/recoveryAuth";

const permanent = { user: { id: "account-a", is_anonymous: false }, access_token: "test-token" } as Session;
const guest = { user: { id: "guest-a", is_anonymous: true }, access_token: "guest-token" } as Session;
const oauthURL = (provider: string) => "https://test.supabase.co/auth/v1/authorize?provider=" + provider + "&redirect_to=" + encodeURIComponent(window.location.origin + "/auth/callback");
function sdkInitializationSuccess() {
  // A successful PKCE exchange consumes its code in the pinned SDK itself.
  const url = new URL(window.location.href);
  url.searchParams.delete("code");
  window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
  return { error: null };
}

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
  observeRecoveryAuth({ onAuthStateChange: (listener) => {
    state.authListener = listener;
    listener("INITIAL_SESSION", null);
    return { data: { subscription: { unsubscribe: () => {} } } };
  } });
  state.getSession.mockReset().mockResolvedValue({ data: { session: null }, error: null });
  state.initialize.mockReset().mockImplementation(async () => sdkInitializationSuccess());
  state.signUp.mockReset().mockResolvedValue({ data: { session: null }, error: null });
  state.password.mockReset().mockResolvedValue({ data: { session: permanent }, error: null });
  state.oauth.mockReset().mockImplementation(async ({ provider }) => ({ data: { url: oauthURL(provider) }, error: null }));
  state.reset.mockReset().mockResolvedValue({ data: {}, error: null });
  state.update.mockReset().mockResolvedValue({ data: { user: permanent.user }, error: null });
  state.recoveryUpdate.mockReset().mockImplementation(async () => Response.json(permanent.user));
  state.captcha.mockReset().mockResolvedValue("captcha-test");
  state.redirect.mockReset();
  vi.stubGlobal("fetch", vi.fn().mockImplementation(async (url, init?: RequestInit) =>
    String(url).endsWith("/auth/v1/user") && init?.method === "PUT"
      ? state.recoveryUpdate(url, init)
      : Response.json({ external: { google: true, facebook: true } })));
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
  state.initialize.mockImplementation(() => new Promise((done) => { resolve = done; }).then(() => sdkInitializationSuccess()));
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
  state.initialize.mockImplementation(() => new Promise((done) => { resolve = done; }).then(() => sdkInitializationSuccess()));
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

it.each([null, guest])("callback initialization without an account terminates rather than spinning", async (returned) => {
  state.getSession.mockResolvedValue({ data: { session: returned }, error: null });
  window.history.replaceState(null, "", "/auth/callback?code=consumed-by-sdk");
  callback();
  await screen.findByRole("heading", { name: "Sign-in not completed" });
  expect(screen.getByText(/No signed-in account was returned/)).toBeTruthy();
  expect(screen.queryByText("Checking your account…")).toBeNull();
  expect(screen.queryByRole("heading", { name: "Home route" })).toBeNull();
});

it("a callback code without its PKCE verifier cannot reuse an old account as successful sign-in", async () => {
  state.session = permanent;
  state.getSession.mockResolvedValue({ data: { session: permanent }, error: null });
  // The real SDK ignores an unrecognized PKCE callback and leaves its code intact.
  state.initialize.mockResolvedValue({ error: null });
  window.history.replaceState(null, "", "/auth/callback?code=missing-verifier-private-code");
  callback();
  await screen.findByRole("heading", { name: "Sign-in not completed" });
  expect(screen.getByText(/This sign-in link could not be verified/)).toBeTruthy();
  expect(state.getSession).not.toHaveBeenCalled();
  expect(screen.queryByRole("heading", { name: "Home route" })).toBeNull();
  expect(document.body.textContent).not.toContain("missing-verifier-private-code");
  expect(window.location.search).toBe("");
});

it("provider errors use fixed guidance without raw messages or signed addresses", () => {
  for (const error of [new Error("private provider response https://private.test/?token=secret"),
    { code: "unknown_provider_code", message: "secret user/provider response" }]) {
    const message = friendlyAuthError(error);
    expect(message).toBe("Sign-in could not be completed. Please try again.");
    expect(message).not.toContain("private");
    expect(message).not.toContain("token");
  }
  expect(friendlyAuthError(new AuthFlowError("AUTH_NOT_CONFIGURED"))).toContain("not configured");
  expect(friendlyAuthError({ code: "email_not_confirmed", message: "private" })).toContain("Confirm your email address");
});

function fillReset() {
  fireEvent.change(screen.getByLabelText("New password"), { target: { value: "new-password-123" } });
}

it("failed recovery initialization never updates an older saved account", async () => {
  state.session = permanent;
  state.getSession.mockResolvedValue({ data: { session: permanent }, error: null });
  state.initialize.mockResolvedValue({ error: new Error("private expired reset code") });
  window.history.replaceState(null, "", "/reset-password?code=expired-private-code");
  const view = page("reset");
  await screen.findByText(/This password reset link could not be verified/);
  expect(screen.getByRole("button", { name: "Reset password" })).toHaveProperty("disabled", true);
  fillReset();
  fireEvent.submit(view.container.querySelector("form")!);
  await act(async () => {});
  expect(state.update).not.toHaveBeenCalled();
  expect(state.getSession).not.toHaveBeenCalled();
  expect(document.body.textContent).not.toContain("expired-private-code");
  expect(window.location.search).toBe("");
});

it("an unconsumed reset code cannot grant password recovery using an old session", async () => {
  state.session = permanent;
  state.getSession.mockResolvedValue({ data: { session: permanent }, error: null });
  state.initialize.mockResolvedValue({ error: null });
  window.history.replaceState(null, "", "/reset-password?code=unrecognized-private-code");
  page("reset");
  await screen.findByText(/This password reset link could not be verified/);
  expect(state.update).not.toHaveBeenCalled();
  expect(state.getSession).not.toHaveBeenCalled();
});

it("a saved account alone cannot grant password-recovery authority", async () => {
  state.session = permanent;
  state.getSession.mockResolvedValue({ data: { session: permanent }, error: null });
  page("reset");
  await screen.findByText(/Open a fresh password reset link/);
  expect(screen.getByRole("button", { name: "Reset password" })).toHaveProperty("disabled", true);
  expect(state.update).not.toHaveBeenCalled();
});

it("recovery authority captured before the lazy reset page mounts permits exactly the recovered account", async () => {
  state.session = permanent;
  state.getSession.mockResolvedValue({ data: { session: permanent }, error: null });
  act(() => state.authListener?.("PASSWORD_RECOVERY", permanent));
  window.history.replaceState(null, "", "/reset-password?code=valid-recovery-code");
  page("reset");
  await waitFor(() => expect(screen.getByRole("button", { name: "Reset password" })).toHaveProperty("disabled", false));
  fillReset();
  fireEvent.click(screen.getByRole("button", { name: "Reset password" }));
  await screen.findByRole("heading", { name: "Settings route" });
  expect(state.recoveryUpdate).toHaveBeenCalledExactlyOnceWith("https://test.supabase.co/auth/v1/user", expect.objectContaining({
    method: "PUT", headers: expect.objectContaining({ apikey: "public-test-key", Authorization: "Bearer test-token" }),
    body: JSON.stringify({ password: "new-password-123" }), credentials: "omit", redirect: "error",
  }));
  expect(state.update).not.toHaveBeenCalled();
  expect(hasRecoveryAuthority(permanent)).toBe(false);
});

it("a recovery notification arriving after initialization enables the matching reset session", async () => {
  state.session = permanent;
  state.getSession.mockResolvedValue({ data: { session: permanent }, error: null });
  page("reset");
  await screen.findByText(/Open a fresh password reset link/);
  act(() => state.authListener?.("PASSWORD_RECOVERY", permanent));
  await waitFor(() => expect(screen.getByRole("button", { name: "Reset password" })).toHaveProperty("disabled", false));
  expect(screen.queryByText(/Open a fresh password reset link/)).toBeNull();
});

it("a session switch between recovery rendering and submission cannot update the other account", async () => {
  state.session = permanent;
  const other = { ...permanent, user: { ...permanent.user, id: "account-b" }, access_token: "other-token" } as Session;
  state.getSession.mockResolvedValueOnce({ data: { session: permanent }, error: null })
    .mockResolvedValue({ data: { session: other }, error: null });
  act(() => state.authListener?.("PASSWORD_RECOVERY", permanent));
  page("reset");
  await waitFor(() => expect(screen.getByRole("button", { name: "Reset password" })).toHaveProperty("disabled", false));
  fillReset();
  fireEvent.click(screen.getByRole("button", { name: "Reset password" }));
  await screen.findByText(/Your password reset session changed/);
  expect(state.update).not.toHaveBeenCalled();
});

it("a new sign-in for the same user invalidates a previous recovery grant", async () => {
  state.session = permanent;
  state.getSession.mockResolvedValue({ data: { session: permanent }, error: null });
  act(() => state.authListener?.("PASSWORD_RECOVERY", permanent));
  page("reset");
  await waitFor(() => expect(screen.getByRole("button", { name: "Reset password" })).toHaveProperty("disabled", false));
  act(() => state.authListener?.("SIGNED_IN", { ...permanent, access_token: "new-login-token" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Reset password" })).toHaveProperty("disabled", true));
  expect(state.update).not.toHaveBeenCalled();
});

it("binds password mutation to the recovered account when another tab replaces the global session after the check", async () => {
  const other = { ...permanent, user: { ...permanent.user, id: "account-b" }, access_token: "other-token" } as Session;
  const writes = new Map<string, string>();
  state.session = permanent;
  state.getSession.mockResolvedValueOnce({ data: { session: permanent }, error: null })
    .mockImplementationOnce(async () => {
      // getSession captured account A; another tab now stores account B before
      // the async caller can begin mutation. Its auth event has not arrived yet.
      state.session = other;
      state.getSession.mockResolvedValue({ data: { session: other }, error: null });
      return { data: { session: permanent }, error: null };
    });
  state.update.mockImplementation(async ({ password }: { password: string }) => {
    // Model the primary SDK's independent storage read in _updateUser.
    const current = (await state.getSession()).data.session as Session;
    writes.set(current.user.id, password);
    return { data: { user: current.user }, error: null };
  });
  state.recoveryUpdate.mockImplementation(async (_url: string, init: RequestInit) => {
    const token = new Headers(init.headers).get("Authorization");
    const authenticated = token === "Bearer test-token" ? permanent : other;
    writes.set(authenticated.user.id, JSON.parse(String(init.body)).password);
    return Response.json(authenticated.user);
  });
  act(() => state.authListener?.("PASSWORD_RECOVERY", permanent));
  page("reset");
  await waitFor(() => expect(screen.getByRole("button", { name: "Reset password" })).toHaveProperty("disabled", false));
  fillReset();
  fireEvent.click(screen.getByRole("button", { name: "Reset password" }));
  await screen.findByRole("heading", { name: "Settings route" });
  expect(state.session).toBe(other);
  expect(writes.get("account-a")).toBe("new-password-123");
  expect(writes.has("account-b")).toBe(false);
  expect(state.update).not.toHaveBeenCalled();
  expect(hasRecoveryAuthority(permanent)).toBe(false);
});

it("consumes a successful recovery grant even when the form unmounts during the authenticated request", async () => {
  let complete!: (response: Response) => void;
  state.session = permanent;
  state.getSession.mockResolvedValue({ data: { session: permanent }, error: null });
  state.recoveryUpdate.mockImplementation(() => new Promise<Response>((resolve) => { complete = resolve; }));
  act(() => state.authListener?.("PASSWORD_RECOVERY", permanent));
  const view = page("reset");
  await waitFor(() => expect(screen.getByRole("button", { name: "Reset password" })).toHaveProperty("disabled", false));
  fillReset();
  fireEvent.click(screen.getByRole("button", { name: "Reset password" }));
  await waitFor(() => expect(state.recoveryUpdate).toHaveBeenCalledOnce());
  view.unmount();
  await act(async () => complete(Response.json(permanent.user)));
  expect(hasRecoveryAuthority(permanent)).toBe(false);
});

it("uses fixed guidance for recovery HTTP failures without exposing provider response details", async () => {
  state.session = permanent;
  state.getSession.mockResolvedValue({ data: { session: permanent }, error: null });
  state.recoveryUpdate.mockImplementation(async () => Response.json({ code: "same_password", message: "secret provider response" }, { status: 422 }));
  act(() => state.authListener?.("PASSWORD_RECOVERY", permanent));
  page("reset");
  await waitFor(() => expect(screen.getByRole("button", { name: "Reset password" })).toHaveProperty("disabled", false));
  fillReset();
  fireEvent.click(screen.getByRole("button", { name: "Reset password" }));
  await screen.findByText("Choose a password different from your current password.");
  expect(document.body.textContent).not.toContain("secret provider response");
  expect(hasRecoveryAuthority(permanent)).toBe(true);
});
