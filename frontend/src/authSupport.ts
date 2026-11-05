import { z } from "zod";
import { getSupabaseUrl } from "./publicConfig";
import { sessionFailure } from "./sessionErrors";

export type AuthMode = "login" | "register" | "forgot" | "reset";
export type SocialProvider = "google" | "facebook";
export const providerName = (provider: SocialProvider) => provider === "google" ? "Google" : "Facebook";

export function authSchema(mode: AuthMode) {
  return z.object({ fullName: z.string(), email: z.string(), password: z.string(), confirmPassword: z.string() })
    .superRefine((value, context) => {
      if (mode === "register" && (!value.fullName.trim() || value.fullName.trim().length > 100))
        context.addIssue({ code: "custom", path: ["fullName"], message: "Enter your name using 1–100 characters." });
      if (mode !== "reset" && !z.email().safeParse(value.email.trim()).success)
        context.addIssue({ code: "custom", path: ["email"], message: "Enter a valid email address." });
      if (mode !== "forgot" && value.password.length < (mode === "login" ? 1 : 8))
        context.addIssue({ code: "custom", path: ["password"], message: mode === "login" ? "Enter your password." : "Use at least 8 characters." });
      if (mode === "register" && value.password !== value.confirmPassword)
        context.addIssue({ code: "custom", path: ["confirmPassword"], message: "Your passwords do not match." });
    });
}

export type AuthFields = z.infer<ReturnType<typeof authSchema>>;

export function safeReturnPath(value: unknown) {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || value.includes("\\") || [...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) return "/";
  try {
    const target = new URL(value, window.location.origin);
    return target.origin === window.location.origin ? target.pathname + target.search + target.hash : "/";
  } catch { return "/"; }
}

export function callbackFailure(url: string) {
  const parsed = new URL(url);
  const fragment = new URLSearchParams(parsed.hash.slice(1));
  const code = parsed.searchParams.get("error_code") || parsed.searchParams.get("error") || fragment.get("error_code") || fragment.get("error");
  if (!code && !parsed.searchParams.has("error_description") && !fragment.has("error_description")) return "";
  if (code === "access_denied") return "Sign-in was cancelled or permission was not granted. Try again or continue as a guest.";
  if (code === "otp_expired" || code === "flow_state_expired") return "This sign-in link has expired. Please request a new link.";
  return "Sign-in could not be completed. Please try again, use email, or continue as a guest.";
}

export function clearCallbackAddress() {
  // Run only after the SDK has finished reading its PKCE callback URL.
  window.history.replaceState(window.history.state, "", window.location.pathname);
}

export async function checkSocialProvider(provider: SocialProvider) {
  const url = getSupabaseUrl();
  const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim();
  if (!url || !key) throw new Error("Account sign-in is not configured. Please contact support or continue as a guest.");
  let response: Response;
  try {
    response = await fetch(url.replace(/\/$/, "") + "/auth/v1/settings", {
      headers: { apikey: key }, signal: AbortSignal.timeout(8_000), cache: "no-store",
    });
    if (!response.ok) throw new Error("unavailable");
  } catch {
    throw new Error("The sign-in service is temporarily unavailable. Please try again shortly.");
  }
  const settings = await response.json().catch(() => ({}));
  if (settings?.external?.[provider] === false)
    throw new Error(`${providerName(provider)} sign-in is not available yet. Use email or continue as a guest.`);
}

export function redirectToProvider(url: string, provider: SocialProvider) {
  const base = new URL(getSupabaseUrl());
  const target = new URL(url);
  const expectedPath = base.pathname.replace(/\/$/, "") + "/auth/v1/authorize";
  if (target.origin !== base.origin || target.pathname !== expectedPath || target.username || target.password ||
      target.searchParams.get("provider") !== provider || target.searchParams.get("redirect_to") !== window.location.origin + "/auth/callback")
    throw new Error("The sign-in service returned an invalid address. Please try again.");
  window.location.assign(target.href);
}

export function friendlyAuthError(error: unknown, provider?: SocialProvider) {
  const issue = error && typeof error === "object" ? error as { code?: string; name?: string; status?: number; message?: string } : {};
  if (issue.name === "AuthRetryableFetchError") return sessionFailure(error).message;
  if (error instanceof TypeError || (error instanceof Error && error.name === "TimeoutError")) return "Cannot reach the sign-in service. Check your connection and try again.";
  if (issue.status && issue.status >= 500) return "The sign-in service is temporarily unavailable. Please try again shortly.";
  if (issue.status === 429) return "Too many attempts. Please wait a moment and try again.";
  if (issue.code === "invalid_credentials") return "Check your email and password and try again.";
  if (issue.code === "weak_password") return "This password does not meet the account requirements. Choose a stronger password.";
  if (issue.code === "captcha_failed") return "Verification failed. Please try again.";
  if (provider && (issue.code === "provider_disabled" || /unsupported provider|provider.*not enabled/i.test(issue.message || "")))
    return `${providerName(provider)} sign-in is not available yet. Use email or continue as a guest.`;
  return error instanceof Error ? error.message : "Sign-in could not be completed. Please try again.";
}
