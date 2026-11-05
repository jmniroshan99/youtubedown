import type { AuthChangeEvent, Session } from "@supabase/supabase-js";
import { useSyncExternalStore } from "react";

type AuthObserver = {
  onAuthStateChange: (callback: (event: AuthChangeEvent, session: Session | null) => void) => {
    data: { subscription: { unsubscribe: () => void } };
  };
};

// A recovery event is authority for this browser session only. It is never
// inferred from a URL flag, user metadata or an older persisted account.
let authority: { userId: string; accessToken: string; sessionId: string | null } | null = null;
let observed: AuthObserver | undefined;
let unsubscribe: (() => void) | undefined;
let version = 0;
const listeners = new Set<() => void>();

function sessionId(session: Session) {
  // This never grants recovery or authorizes an API request. It only prevents
  // an existing recovery grant moving to another session during token refresh.
  const token = session.access_token;
  if (!token || token.length > 16384) return null;
  try {
    const segment = token.split(".")[1];
    if (!segment) return null;
    const value = JSON.parse(atob(segment.replace(/-/g, "+").replace(/_/g, "/"))).session_id;
    return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) ? value : null;
  } catch { return null; }
}

function publish(next: typeof authority) {
  if (next?.userId === authority?.userId && next?.accessToken === authority?.accessToken) return;
  authority = next;
  version += 1;
  listeners.forEach((listener) => listener());
}

export function observeRecoveryAuth(auth?: AuthObserver | null) {
  if (auth === observed) return;
  unsubscribe?.();
  unsubscribe = undefined;
  observed = auth || undefined;
  publish(null);
  if (!auth?.onAuthStateChange) return;
  const { data } = auth.onAuthStateChange((event, session) => {
    if (event === "PASSWORD_RECOVERY" && session && !session.user.is_anonymous && session.access_token) {
      publish({ userId: session.user.id, accessToken: session.access_token, sessionId: sessionId(session) });
    } else if (!session || session.user.is_anonymous || event === "SIGNED_OUT") {
      publish(null);
    } else if (authority) {
      if (event === "TOKEN_REFRESHED" && session.user.id === authority.userId && authority.sessionId && sessionId(session) === authority.sessionId) {
        publish({ userId: session.user.id, accessToken: session.access_token, sessionId: authority.sessionId });
      } else if (session.user.id !== authority.userId || session.access_token !== authority.accessToken) {
        publish(null);
      }
      // SIGNED_IN is also emitted when a focused tab restores its unchanged
      // session. That notification keeps an existing grant, never creates one.
    }
  });
  unsubscribe = () => data.subscription.unsubscribe();
}

export function hasRecoveryAuthority(session: Session | null | undefined) {
  return !!session && !session.user.is_anonymous && !!authority &&
    session.user.id === authority.userId && session.access_token === authority.accessToken;
}

export function consumeRecoveryAuthority(userId: string) {
  if (authority?.userId === userId) publish(null);
}

export function useRecoveryVersion() {
  return useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    () => version,
    () => 0,
  );
}
