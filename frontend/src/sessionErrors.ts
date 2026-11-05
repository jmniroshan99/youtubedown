const messages = {
  AUTH_NETWORK_ERROR: "Cannot reach the sign-in service. Check your connection and the site's authentication configuration, then try again.",
  AUTH_TIMEOUT: "The sign-in service took too long to respond. Please try again shortly.",
  AUTH_UNAVAILABLE: "The sign-in service is temporarily unavailable. Please try again shortly.",
  AUTH_RATE_LIMITED: "Too many guest sessions have been requested. Please wait before trying again.",
  GUEST_DISABLED: "Guest access is not enabled yet. Please contact support or sign in with an account.",
  CAPTCHA_FAILED: "Verification failed. Please try again or contact support if it keeps failing.",
  AUTH_SESSION_FAILED: "Your session could not be verified. Please try again or sign in with an account.",
};

export class SessionError extends Error {
  readonly stage = "session";
  constructor(public readonly code: keyof typeof messages) { super(messages[code]); }
}

export function sessionFailure(error: unknown): SessionError {
  if (error instanceof SessionError) return error;
  const issue = error && typeof error === "object"
    ? error as { code?: string; name?: string; status?: number }
    : {};
  if (issue.code === "anonymous_provider_disabled") return new SessionError("GUEST_DISABLED");
  if (issue.code === "captcha_failed") return new SessionError("CAPTCHA_FAILED");
  if (issue.status === 429) return new SessionError("AUTH_RATE_LIMITED");
  if (issue.status && issue.status >= 500) return new SessionError("AUTH_UNAVAILABLE");
  if (issue.name === "TimeoutError") return new SessionError("AUTH_TIMEOUT");
  if (error instanceof TypeError || issue.name === "AuthRetryableFetchError") return new SessionError("AUTH_NETWORK_ERROR");
  return new SessionError("AUTH_SESSION_FAILED");
}
