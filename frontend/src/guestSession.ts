import type { Session } from "@supabase/supabase-js";
import { supabase } from "./lib";
import { sessionFailure } from "./sessionErrors";

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
    const auth = supabase.auth;
    const savedSession = async () => {
      try {
        const result = await auth.getSession();
        if (result.error) throw result.error;
        return result.data.session;
      } catch (error) {
        throw sessionFailure(error);
      }
    };
    const existing = await savedSession();
    if (existing) return existing;
    const captchaToken = await getCaptcha();
    // The visitor may have signed in in another tab while completing the challenge.
    const latest = await savedSession();
    if (latest) return latest;
    const { data, error } = await auth.signInAnonymously({
      options: { captchaToken },
    }).catch((error: unknown) => {
      throw sessionFailure(error);
    });
    if (error) throw sessionFailure(error);
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
