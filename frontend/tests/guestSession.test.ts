import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  signInAnonymously: vi.fn(),
}));
vi.mock("../src/lib", () => ({ supabase: { auth: mocks } }));
const guest = {
  user: { id: "guest-a", is_anonymous: true },
  access_token: "guest-token",
};
beforeEach(() => {
  vi.resetModules();
  mocks.getSession
    .mockReset()
    .mockResolvedValue({ data: { session: null }, error: null });
  mocks.signInAnonymously
    .mockReset()
    .mockResolvedValue({ data: { session: guest }, error: null });
});
afterEach(() => vi.unstubAllGlobals());
describe("guest session initialization", () => {
  it("deduplicates simultaneous private actions", async () => {
    const { ensureGuestSession } = await import("../src/guestSession");
    const captcha = vi.fn().mockResolvedValue("captcha-token");
    const first = ensureGuestSession(captcha),
      second = ensureGuestSession(captcha);
    expect(first).toBe(second);
    expect((await first).user.id).toBe("guest-a");
    expect(mocks.signInAnonymously).toHaveBeenCalledExactlyOnceWith({
      options: { captchaToken: "captcha-token" },
    });
    expect(captcha).toHaveBeenCalledOnce();
  });
  it.each([true, false])(
    "reuses a persisted session, anonymous=%s",
    async (anonymous) => {
      const session = {
        ...guest,
        user: { id: "saved-user", is_anonymous: anonymous },
      };
      mocks.getSession.mockResolvedValue({ data: { session }, error: null });
      const { ensureGuestSession } = await import("../src/guestSession");
      const captcha = vi.fn();
      expect(await ensureGuestSession(captcha)).toBe(session);
      expect(mocks.signInAnonymously).not.toHaveBeenCalled();
      expect(captcha).not.toHaveBeenCalled();
    },
  );
  it("preserves an account sign-in completed while a challenge was open", async () => {
    const permanent = {
      ...guest,
      user: { id: "permanent", is_anonymous: false },
    };
    mocks.getSession
      .mockResolvedValueOnce({ data: { session: null }, error: null })
      .mockResolvedValueOnce({ data: { session: permanent }, error: null });
    const { ensureGuestSession } = await import("../src/guestSession");
    expect(await ensureGuestSession(async () => "token")).toBe(permanent);
    expect(mocks.signInAnonymously).not.toHaveBeenCalled();
  });
  it("permits retry after cancellation and explains disabled guest access", async () => {
    const { ensureGuestSession } = await import("../src/guestSession");
    await expect(
      ensureGuestSession(async () => {
        throw new Error("Cancelled");
      }),
    ).rejects.toThrow("Cancelled");
    mocks.signInAnonymously.mockResolvedValueOnce({
      data: {},
      error: { code: "anonymous_provider_disabled" },
    });
    await expect(ensureGuestSession(async () => undefined)).rejects.toThrow(
      "Guest access is not enabled",
    );
    await expect(ensureGuestSession(async () => undefined)).resolves.toBe(
      guest,
    );
  });
  it("does not replace a session when loading the saved session fails", async () => {
    mocks.getSession.mockResolvedValue({
      data: { session: null },
      error: new Error("Refresh failed"),
    });
    const { ensureGuestSession } = await import("../src/guestSession");
    await expect(ensureGuestSession(async () => undefined)).rejects.toThrow(
      "session could not be verified",
    );
    expect(mocks.signInAnonymously).not.toHaveBeenCalled();
  });
  it("classifies a rejected guest network call without keeping the failed initialization pending", async () => {
    mocks.signInAnonymously.mockRejectedValueOnce(new TypeError("private fetch detail"));
    const { ensureGuestSession } = await import("../src/guestSession");
    await expect(ensureGuestSession(async () => undefined)).rejects.toMatchObject({ code: "AUTH_NETWORK_ERROR", stage: "session" });
    await expect(ensureGuestSession(async () => undefined)).resolves.toBe(guest);
  });
  it("classifies SDK-returned fetch failures before any analysis request", async () => {
    mocks.signInAnonymously.mockResolvedValueOnce({ data: {}, error: { name: "AuthRetryableFetchError", status: 0, message: "Failed to fetch private" } });
    const { ensureGuestSession } = await import("../src/guestSession");
    await expect(ensureGuestSession(async () => undefined)).rejects.toMatchObject({ code: "AUTH_NETWORK_ERROR", stage: "session" });
  });
  it("serializes guest creation and ordinary authentication actions", async () => {
    const { ensureGuestSession, runAuthAction } =
      await import("../src/guestSession");
    let release!: () => void;
    const events: string[] = [];
    const first = ensureGuestSession(
      () =>
        new Promise<string>((resolve) => {
          events.push("guest-check");
          release = () => resolve("ok");
        }),
    );
    const next = runAuthAction(async () => {
      events.push("account-login");
      return "account";
    });
    await vi.waitFor(() => expect(events).toEqual(["guest-check"]));
    release();
    await first;
    await next;
    expect(events).toEqual(["guest-check", "account-login"]);
  });
});
