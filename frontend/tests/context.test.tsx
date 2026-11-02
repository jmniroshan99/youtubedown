import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "@supabase/supabase-js";
const state = vi.hoisted(() => ({
  listener: null as null | ((event: string, session: Session | null) => void),
  unsubscribe: vi.fn(),
  preferences: vi.fn(),
}));
vi.mock("../src/lib", () => ({
  supabase: {
    auth: {
      onAuthStateChange: (fn: typeof state.listener) => {
        state.listener = fn;
        fn?.("INITIAL_SESSION", null);
        return { data: { subscription: { unsubscribe: state.unsubscribe } } };
      },
    },
  },
}));
vi.mock("../src/queries", () => ({
  settingsOptions: (id: string) => ({
    queryKey: ["private", id, "settings"],
    queryFn: state.preferences,
  }),
}));
import { AppProvider, useApp } from "../src/context";
import { createQueryClient, privateKey } from "../src/queryClient";
function Probe() {
  const app = useApp();
  return (
    <div>
      <span data-testid="user">{app.session?.user.id ?? "signed-out"}</span>
      <span data-testid="theme">{app.theme}</span>
    </div>
  );
}
function session(id: string) {
  return {
    user: { id },
    access_token: "test",
    refresh_token: "test",
    expires_in: 3600,
    token_type: "bearer",
  } as Session;
}
beforeEach(() => {
  localStorage.clear();
  state.unsubscribe.mockReset();
  state.preferences
    .mockReset()
    .mockResolvedValue({ theme: "dark", language: "si" });
});
afterEach(cleanup);
describe("English-only preferences and session lifecycle", () => {
  it("retires a saved local language preference and renders English", async () => {
    localStorage.setItem("vf-language", "si");
    const q = createQueryClient();
    render(
      <QueryClientProvider client={q}>
        <AppProvider>
          <Probe />
        </AppProvider>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(document.documentElement.lang).toBe("en"));
    expect(localStorage.getItem("vf-language")).toBeNull();
    q.clear();
  });
  it("reads the saved theme without applying the old server language", async () => {
    const q = createQueryClient();
    render(
      <QueryClientProvider client={q}>
        <AppProvider>
          <Probe />
        </AppProvider>
      </QueryClientProvider>,
    );
    await act(async () => state.listener?.("SIGNED_IN", session("alice")));
    await waitFor(() => expect(state.preferences).toHaveBeenCalledOnce());
    expect(document.documentElement.lang).toBe("en");
    expect(screen.getByTestId("theme").textContent).toBe("dark");
    q.clear();
  });
  it("clears private cached analysis on sign-out", async () => {
    const q = createQueryClient();
    render(
      <QueryClientProvider client={q}>
        <AppProvider>
          <Probe />
        </AppProvider>
      </QueryClientProvider>,
    );
    await act(async () => state.listener?.("SIGNED_IN", session("alice")));
    q.setQueryData(privateKey("alice", "analysis"), { title: "private" });
    await act(async () => state.listener?.("SIGNED_OUT", null));
    expect(screen.getByTestId("user").textContent).toBe("signed-out");
    expect(q.getQueryData(privateKey("alice", "analysis"))).toBeUndefined();
    q.clear();
  });
  it("retains cache on a token refresh for the same user", async () => {
    const q = createQueryClient();
    render(
      <QueryClientProvider client={q}>
        <AppProvider>
          <Probe />
        </AppProvider>
      </QueryClientProvider>,
    );
    await act(async () => state.listener?.("SIGNED_IN", session("alice")));
    q.setQueryData(privateKey("alice", "jobs"), ["saved"]);
    await act(async () =>
      state.listener?.("TOKEN_REFRESHED", session("alice")),
    );
    expect(q.getQueryData(privateKey("alice", "jobs"))).toEqual(["saved"]);
    expect(state.preferences).toHaveBeenCalledOnce();
    q.clear();
  });
  it("unsubscribes from auth when unmounted", async () => {
    const q = createQueryClient();
    const view = render(
      <QueryClientProvider client={q}>
        <AppProvider>
          <Probe />
        </AppProvider>
      </QueryClientProvider>,
    );
    await act(async () => {});
    view.unmount();
    expect(state.unsubscribe).toHaveBeenCalledOnce();
    q.clear();
  });
});
