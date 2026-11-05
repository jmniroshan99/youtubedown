import type { AuthChangeEvent, Session } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it } from "vitest";
import { consumeRecoveryAuthority, hasRecoveryAuthority, observeRecoveryAuth } from "../src/recoveryAuth";

let emit: (event: AuthChangeEvent, session: Session | null) => void;
const id = "10000000-0000-0000-0000-000000000001";
const otherId = "10000000-0000-0000-0000-000000000002";
function session(userId = "alice", sessionId = id, generation = 1): Session {
  const payload = btoa(JSON.stringify({ session_id: sessionId, generation }));
  return { user: { id: userId, is_anonymous: false }, access_token: `fixture.${payload}.fixture` } as Session;
}
beforeEach(() => observeRecoveryAuth({ onAuthStateChange: (listener) => {
  emit = listener;
  listener("INITIAL_SESSION", null);
  return { data: { subscription: { unsubscribe: () => {} } } };
} }));

describe("ephemeral recovery authority", () => {
  it("does not grant authority from a saved session, a URL flag or another account", () => {
    const saved = session();
    emit("INITIAL_SESSION", saved);
    expect(hasRecoveryAuthority(saved)).toBe(false);
    emit("PASSWORD_RECOVERY", saved);
    expect(hasRecoveryAuthority(saved)).toBe(true);
    emit("SIGNED_IN", saved);
    expect(hasRecoveryAuthority(saved)).toBe(true);
    expect(hasRecoveryAuthority(session("bob"))).toBe(false);
    expect(hasRecoveryAuthority(session("alice", otherId))).toBe(false);
  });
  it("retains an existing grant only for a verified SDK token refresh of the same session", () => {
    const recovered = session();
    const refreshed = session("alice", id, 2);
    emit("PASSWORD_RECOVERY", recovered);
    emit("TOKEN_REFRESHED", refreshed);
    expect(hasRecoveryAuthority(refreshed)).toBe(true);
    expect(hasRecoveryAuthority(recovered)).toBe(false);
    emit("TOKEN_REFRESHED", session("alice", otherId, 3));
    expect(hasRecoveryAuthority(session("alice", otherId, 3))).toBe(false);
  });
  it("consumes a completed grant and invalidates it on a new sign-in or sign-out", () => {
    const recovered = session();
    emit("PASSWORD_RECOVERY", recovered);
    consumeRecoveryAuthority("someone-else");
    expect(hasRecoveryAuthority(recovered)).toBe(true);
    consumeRecoveryAuthority("alice");
    expect(hasRecoveryAuthority(recovered)).toBe(false);
    emit("PASSWORD_RECOVERY", recovered);
    emit("SIGNED_IN", session("alice", otherId));
    expect(hasRecoveryAuthority(recovered)).toBe(false);
    emit("PASSWORD_RECOVERY", recovered);
    emit("SIGNED_OUT", null);
    expect(hasRecoveryAuthority(recovered)).toBe(false);
  });
  it("never grants guests authority and fails closed on an unidentifiable refresh", () => {
    const recovered = session();
    emit("PASSWORD_RECOVERY", { ...recovered, user: { ...recovered.user, is_anonymous: true } });
    expect(hasRecoveryAuthority(recovered)).toBe(false);
    emit("PASSWORD_RECOVERY", recovered);
    const malformed = { ...recovered, access_token: "not-a-jwt" };
    emit("TOKEN_REFRESHED", malformed);
    expect(hasRecoveryAuthority(malformed)).toBe(false);
  });
});
