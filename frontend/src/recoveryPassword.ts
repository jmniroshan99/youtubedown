import type { Session } from "@supabase/supabase-js";
import { AuthFlowError } from "./authSupport";
import { getSupabaseUrl } from "./publicConfig";
import { consumeRecoveryAuthority, hasRecoveryAuthority } from "./recoveryAuth";

export async function updateRecoveryPassword(session: Session, password: string) {
  if (!hasRecoveryAuthority(session)) throw new AuthFlowError("RECOVERY_SESSION_CHANGED");
  const url = getSupabaseUrl();
  const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim();
  if (!url || !key) throw new AuthFlowError("AUTH_NOT_CONFIGURED");
  const userId = session.user.id;
  const accessToken = session.access_token;
  // The primary SDK's updateUser reloads browser storage before its request.
  // Bind the documented Auth user endpoint to this captured recovery token so
  // a concurrent sign-in cannot redirect the password change to another user.
  const response = await fetch(url.replace(/\/$/, "") + "/auth/v1/user", {
    method: "PUT",
    headers: { apikey: key, Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
    signal: AbortSignal.timeout(20_000),
    cache: "no-store", credentials: "omit", redirect: "error",
  });
  const body: unknown = await response.json().catch(() => null);
  const result = body && typeof body === "object" ? body as Record<string, unknown> : {};
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) throw new AuthFlowError("RECOVERY_LINK_INVALID");
    // Only structured code/status reach the fixed auth error mapper. Provider
    // messages, password policy details and raw response bodies never escape.
    throw Object.assign(new Error(), {
      status: response.status,
      code: typeof result.code === "string" ? result.code : undefined,
    });
  }
  const user = result.user && typeof result.user === "object" ? result.user as Record<string, unknown> : result;
  if (!response.headers.get("content-type")?.includes("application/json") || user.id !== userId)
    throw new AuthFlowError("AUTH_RESPONSE_INVALID");
  // Never save this response over the primary session: another account may now
  // own it. Consume the grant even if the reset route was unmounted in flight.
  consumeRecoveryAuthority(userId);
}
