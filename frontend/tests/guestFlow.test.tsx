import type { Session } from "@supabase/supabase-js";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  session: null as Session | null,
  listener: null as null | ((event: string, session: Session | null) => void),
  signIn: vi.fn(),
}));
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    auth: {
      getSession: async () => ({
        data: { session: state.session },
        error: null,
      }),
      signInAnonymously: state.signIn,
      onAuthStateChange: (fn: typeof state.listener) => {
        state.listener = fn;
        fn?.("INITIAL_SESSION", state.session);
        return { data: { subscription: { unsubscribe: vi.fn() } } };
      },
    },
  }),
}));
vi.mock("../src/queries", () => ({
  settingsOptions: (id: string) => ({
    queryKey: ["private", id, "settings"],
    queryFn: async () => null,
  }),
}));
vi.hoisted(() => {
  vi.stubEnv("VITE_SUPABASE_URL", "https://test.supabase.co");
  vi.stubEnv("VITE_SUPABASE_PUBLISHABLE_KEY", "test-publishable");
  vi.stubEnv("VITE_API_BASE_URL", "https://api.example.test");
});
import { AppProvider, useApp } from "../src/context";
import { createQueryClient, privateKey } from "../src/queryClient";
import Home from "../src/pages/Home";
const session = {
  user: { id: "guest-a", is_anonymous: true },
  access_token: "guest-token",
} as Session;
function Pages() {
  const { workspaceEpoch } = useApp();
  return (
    <Routes key={workspaceEpoch}>
      <Route path="/" element={<Home serviceReady />} />
      <Route path="/downloads" element={<h1>Downloads route</h1>} />
    </Routes>
  );
}
beforeEach(() => {
  state.session = null;
  localStorage.clear();
  state.signIn.mockReset().mockImplementation(async () => {
    state.session = session;
    state.listener?.("SIGNED_IN", session);
    return { data: { session }, error: null };
  });
  vi.stubEnv("VITE_TURNSTILE_SITE_KEY", "");
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  Object.defineProperty(document, "hidden", { configurable: true, value: false });
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async (url: string) =>
        new Response(
          JSON.stringify(
            url.endsWith("/api/analyze")
              ? { analysis_id: "analysis-1" }
              : url.endsWith("/api/downloads")
                ? { id: "job-1", status: "completed", title: "Permitted fixture", selected_format: "MP4", created_at: new Date().toISOString() }
                : url.endsWith("/file")
                  ? { url: "https://storage.example.test/video?download=youtubedown%20-%20Permitted%20fixture.mp4", filename: "youtubedown - Permitted fixture.mp4" }
                  : {
                    status: "completed",
                    title: "Permitted fixture",
                    platform: "Fixture",
                    duration: 1,
                    formats: [
                      { id: "v", label: "720p · MP4", kind: "video", ext: "mp4", has_audio: true, height: 720 },
                      { id: "a", label: "MP3 · 192 kbps", kind: "audio", ext: "mp3" },
                    ],
                  },
          ),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    ),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
it("paste checks formats with one guest, waits for Video/Audio selection, then explicitly downloads", async () => {
  const query = createQueryClient();
  render(
    <QueryClientProvider client={query}>
      <AppProvider>
        <MemoryRouter>
          <Pages />
        </MemoryRouter>
      </AppProvider>
    </QueryClientProvider>,
  );
  fireEvent.paste(screen.getByLabelText("Video URL"), {
    clipboardData: { getData: () => "https://example.com/fixture.mp4" },
  });
  await screen.findByText("Permitted fixture", {}, { timeout: 2500 });
  expect(state.signIn).toHaveBeenCalledOnce();
  expect(screen.getByLabelText("Video URL")).toHaveProperty(
    "value",
    "https://example.com/fixture.mp4",
  );
  const start = vi
    .mocked(fetch)
    .mock.calls.filter(([url]) => String(url).endsWith("/api/analyze"));
  expect(start).toHaveLength(1);
  expect(start[0][1]?.headers).toMatchObject({
    Authorization: "Bearer guest-token",
  });
  expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith("/api/downloads"))).toHaveLength(0);
  expect(HTMLAnchorElement.prototype.click).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Audio", exact: true }));
  expect(screen.queryByRole("option", { name: /720p/ })).toBeNull();
  expect(screen.getByLabelText("Audio format and quality")).toHaveProperty("value", "a");
  expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith("/api/downloads"))).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "Download audio", exact: true }));
  await screen.findByRole("button", { name: "Save file" });
  const created = vi.mocked(fetch).mock.calls.find(([url]) => String(url).endsWith("/api/downloads"))!;
  expect(JSON.parse(String(created[1]?.body)).format_id).toBe("a");
  await waitFor(() => expect(HTMLAnchorElement.prototype.click).toHaveBeenCalledOnce());
  expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith("/api/downloads"))).toHaveLength(1);
  query.clear();
});
it("switching from guest to an account clears guest queries and route state", async () => {
  state.session = session;
  const query = createQueryClient();
  render(
    <QueryClientProvider client={query}>
      <AppProvider>
        <MemoryRouter>
          <Pages />
        </MemoryRouter>
      </AppProvider>
    </QueryClientProvider>,
  );
  query.setQueryData(privateKey("guest-a", "jobs"), [
    { title: "Private guest title" },
  ]);
  fireEvent.change(screen.getByLabelText("Video URL"), {
    target: { value: "https://example.com/private-guest-url" },
  });
  await act(async () => {
    state.session = {
      ...session,
      user: { ...session.user, id: "account-b", is_anonymous: false },
    };
    state.listener?.("SIGNED_IN", state.session);
  });
  await waitFor(() =>
    expect(screen.getByLabelText("Video URL")).toHaveProperty("value", ""),
  );
  expect(query.getQueryData(privateKey("guest-a", "jobs"))).toBeUndefined();
  query.clear();
});
