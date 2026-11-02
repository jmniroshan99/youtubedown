import type { Session } from "@supabase/supabase-js";
import { supabase } from "./lib";

let pending: Promise<Session> | null = null;
let authTail: Promise<unknown> = Promise.resolve();

// Serialize our guest/login/logout actions across tabs where Web Locks is available.
export function runAuthAction<T>(action: () => Promise<T>): Promise<T> {
  const run = async (): Promise<T> =>
    navigator.locks
      ? await navigator.locks.request("videoflow-auth-action", action)
      : await action();
  const next = authTail.then(run, run);
  authTail = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

export function ensureGuestSession(
  getCaptcha: () => Promise<string | undefined>,
): Promise<Session> {
  if (pending) return pending;
  pending = runAuthAction(async () => {
    if (!supabase)
      throw new Error(
        "Guest access is unavailable because the service is not configured.",
      );
    const existing = await supabase.auth.getSession();
    if (existing.error) throw existing.error;
    if (existing.data.session) return existing.data.session;
    const captchaToken = await getCaptcha();
    // The visitor may have signed in in another tab while completing the challenge.
    const latest = await supabase.auth.getSession();
    if (latest.error) throw latest.error;
    if (latest.data.session) return latest.data.session;
    const { data, error } = await supabase.auth.signInAnonymously({
      options: { captchaToken },
    });
    if (error) {
      if (error.code === "anonymous_provider_disabled")
        throw new Error(
          "Guest access is not enabled yet. Please contact support or sign in with an account.",
        );
      if (error.code === "captcha_failed")
        throw new Error(
          "Verification failed. Please try again or contact support if it keeps failing.",
        );
      if (error.status === 429)
        throw new Error(
          "Too many guest sessions have been requested. Please wait before trying again.",
        );
      throw error;
    }
    if (!data.session)
      throw new Error(
        "A guest session could not be started. Please try again.",
      );
    return data.session;
  }).finally(() => {
    pending = null;
  });
  return pending;
}
