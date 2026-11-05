import { describe, expect, it } from "vitest";
import { SessionError, sessionFailure } from "../src/sessionErrors";

describe("safe session failures", () => {
  it.each([
    [new TypeError("private https://auth.example/?token=secret"), "AUTH_NETWORK_ERROR"],
    [{ name: "AuthRetryableFetchError", status: 0, message: "Failed to fetch private token" }, "AUTH_NETWORK_ERROR"],
    [{ name: "TimeoutError", message: "private timeout response" }, "AUTH_TIMEOUT"],
    [{ code: "anonymous_provider_disabled", message: "private response" }, "GUEST_DISABLED"],
    [{ code: "captcha_failed", message: "private response" }, "CAPTCHA_FAILED"],
    [{ status: 429, message: "private response" }, "AUTH_RATE_LIMITED"],
    [{ name: "AuthRetryableFetchError", status: 503, message: "private response" }, "AUTH_UNAVAILABLE"],
    [new Error("private provider response https://auth.example/?token=secret"), "AUTH_SESSION_FAILED"],
  ])("reduces %j to a safe stage/code", (original, code) => {
    const failure = sessionFailure(original);
    expect(failure).toBeInstanceOf(SessionError);
    expect(failure.code).toBe(code);
    expect(failure.stage).toBe("session");
    expect(failure.message).not.toContain("private");
    expect(failure.message).not.toContain("token");
    expect(failure.message).not.toContain("https://");
  });
  it("preserves an already classified error", () => {
    const failure = new SessionError("AUTH_NETWORK_ERROR");
    expect(sessionFailure(failure)).toBe(failure);
  });
});
