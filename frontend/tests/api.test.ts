import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
const { getSession } = vi.hoisted(() => ({ getSession: vi.fn() }));
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ auth: { getSession } }),
}));
beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("VITE_SUPABASE_URL", "https://test.supabase.co");
  vi.stubEnv("VITE_SUPABASE_PUBLISHABLE_KEY", "test-publishable");
  vi.stubEnv("VITE_API_BASE_URL", "https://api.example.test");
  getSession.mockResolvedValue({
    data: { session: { access_token: "test-token" } },
  });
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ),
  );
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
describe("authenticated API requests", () => {
  it("uses the configured backend, bearer token and no-store cache", async () => {
    const { api } = await import("../src/lib");
    await api("/api/downloads");
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe("https://api.example.test/api/downloads");
    expect(init?.headers).toMatchObject({ Authorization: "Bearer test-token" });
    expect(init?.cache).toBe("no-store");
  });
  it("does not fetch or invent success when the backend is unconfigured", async () => {
    vi.stubEnv("VITE_API_BASE_URL", "");
    const { api } = await import("../src/lib");
    await expect(api("/api/downloads")).rejects.toMatchObject({
      code: "NOT_CONFIGURED",
    });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("does not call private endpoints while signed out", async () => {
    getSession.mockResolvedValue({ data: { session: null } });
    const { api } = await import("../src/lib");
    await expect(api("/api/downloads")).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("honors a caller cancellation even before fetching", async () => {
    const controller = new AbortController();
    controller.abort();
    const { api } = await import("../src/lib");
    await expect(
      api("/api/downloads", { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("aborts an in-flight request on an account change", async () => {
    vi.mocked(fetch).mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        }),
    );
    const { api } = await import("../src/lib");
    const { resetPrivateRequests } = await import("../src/requestScope");
    const pending = api("/api/downloads");
    const assertion = expect(pending).rejects.toMatchObject({
      name: "AbortError",
    });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    resetPrivateRequests();
    await assertion;
  });
  it("preserves server errors instead of claiming success", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            code: "WORKER_UNAVAILABLE",
            message: "The worker is offline.",
          },
        }),
        { status: 503 },
      ),
    );
    const { api } = await import("../src/lib");
    await expect(api("/api/downloads")).rejects.toMatchObject({
      code: "WORKER_UNAVAILABLE",
      message: "The worker is offline.",
    });
  });
  it("explains an unreachable backend without inventing success", async () => {
    vi.mocked(fetch).mockRejectedValue(new TypeError("Failed to fetch"));
    const { api } = await import("../src/lib");
    await expect(api("/api/downloads")).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
      message: expect.stringContaining("diagnose.bat"),
    });
  });
});

describe("backend configuration and response safety", () => {
  it("rejects local or insecure production API addresses", async () => {
    const { checkApiBase } = await import("../src/lib");
    const production = new URL("https://videoflow.example");
    expect(checkApiBase("http://localhost:8000", production)).not.toBe("");
    expect(checkApiBase("http://api.example", production)).not.toBe("");
    expect(checkApiBase("https://api.example", production)).toBe("");
    expect(
      checkApiBase("http://127.0.0.1:8000", new URL("http://localhost:5173")),
    ).toBe("");
  });
  it("surfaces Retry-After without retrying a paid operation automatically", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            code: "GUEST_RATE_LIMIT",
            message: "Guest usage limit reached.",
          },
        }),
        {
          status: 429,
          headers: { "Retry-After": "125", "Content-Type": "application/json" },
        },
      ),
    );
    const { api, errorMessage } = await import("../src/lib");
    try {
      await api("/api/analyze", { method: "POST" });
      throw new Error("Expected a rejection");
    } catch (error) {
      expect(errorMessage(error)).toContain("3 minute(s)");
    }
    expect(fetch).toHaveBeenCalledOnce();
  });
  it("does not accept an HTML fallback as a successful API result", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response("<html>Frontend page</html>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      }),
    );
    const { api } = await import("../src/lib");
    await expect(api("/api/analyze")).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
  });
});
