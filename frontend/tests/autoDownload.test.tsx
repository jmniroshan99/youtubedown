import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ api: vi.fn(), ensure: vi.fn(), checkApiBase: vi.fn() }));
vi.mock("../src/context", () => ({ useApp: () => ({ ensureSession: mocks.ensure }) }));
vi.mock("../src/lib", () => ({ api: mocks.api, apiBase: "https://api.example.test", checkApiBase: mocks.checkApiBase, errorMessage: (e: Error) => e.message }));
import { suggestedVideoFormat, useAutoDownload, videoURL } from "../src/autoDownload";
import { createQueryClient } from "../src/queryClient";
import type { Analysis, Format, Job } from "../src/lib";
const clients: ReturnType<typeof createQueryClient>[] = [];
function setup() {
  const q = createQueryClient(); clients.push(q);
  return renderHook(() => useAutoDownload(), { wrapper: ({ children }: { children: ReactNode }) => <QueryClientProvider client={q}>{children}</QueryClientProvider> });
}
const format: Format = { id: "v720", label: "720p MP4", kind: "video", ext: "mp4", height: 720, has_audio: true, size: 1024 };
const analysis: Analysis = { analysis_id: "a1", status: "completed", title: "Fixture", platform: "Test", duration: 10, formats: [format, { id: "a-mp3", label: "MP3 · 192 kbps", kind: "audio", ext: "mp3", size: 512 }], download_limits: { max_bytes: 100_000, max_duration: 900 } };
const job: Job = { id: "job1", status: "completed", title: "Fixture", platform: "Test", selected_format: "720p MP4", source_url: "https://example.com/v", created_at: "2026-01-01T00:00:00Z", progress: 100 };
beforeEach(() => {
  mocks.checkApiBase.mockReset().mockReturnValue("");
  Object.defineProperty(document, "hidden", { configurable: true, value: false });
  mocks.ensure.mockReset().mockResolvedValue({ user: { id: "guest1" } });
  mocks.api.mockReset().mockImplementation(async (path: string) => {
    if (path === "/api/analyze") return { analysis_id: "a1" };
    if (path === "/api/analyze/a1") return analysis;
    if (path === "/api/downloads") return job;
    if (path.endsWith("/file")) return { url: "https://storage.example.test/signed/video?download=youtubedown%20-%20Fixture.mp4", filename: "youtubedown - Fixture.mp4" };
    return { status: "cancelled" };
  });
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
});
afterEach(() => { cleanup(); clients.splice(0).forEach((q) => q.clear()); vi.restoreAllMocks(); });

describe("suggested video format", () => {
  it("suggests a smaller MP4 with proven audio within the size ceiling", () => {
    const result = suggestedVideoFormat({ ...analysis, formats: [
      { ...format, id: "silent", height: 1080, has_audio: false },
      { ...format, id: "4k", height: 2160 },
      { ...format, id: "v1080", height: 1080 },
      { ...format, id: "large", height: 1080, size: 1_000_000 },
      { ...format, id: "webm", height: 1080, ext: "webm" },
      format,
    ] });
    expect(result.format?.id).toBe("v720");
  });
  it("explains a WebM fallback and never auto-selects unknown or silent media", () => {
    expect(suggestedVideoFormat({ ...analysis, formats: [{ ...format, ext: "webm" }] }).note).toContain("WebM");
    for (const invalid of [{ ...format, has_audio: undefined }, { ...format, height: undefined }, { ...format, kind: "audio" as const }])
      expect(suggestedVideoFormat({ ...analysis, formats: [invalid] }).format).toBeUndefined();
  });
  it("accepts full HTTP URLs only without credentials", () => {
    expect(videoURL(" https://example.com/v ")).toBe("https://example.com/v");
    for (const invalid of ["example.com", "javascript:alert(1)", "https://user:secret@example.com/v", "not a link"])
      expect(videoURL(invalid)).toBe("");
  });
});

async function analyze(view: ReturnType<typeof setup>) {
  act(() => view.result.current.changeURL("https://example.com/v"));
  await act(async () => view.result.current.run());
  expect(view.result.current.phase).toBe("choose");
}

describe("choose before downloading", () => {
  it("reports an unconfigured hosted backend before starting guest authentication or network requests", async () => {
    mocks.checkApiBase.mockReturnValue("The download service has not been connected yet.");
    mocks.ensure.mockRejectedValue(new TypeError("Failed to fetch"));
    const view = setup();
    act(() => view.result.current.changeURL("https://example.com/v"));
    await act(async () => view.result.current.run());
    expect(view.result.current.phase).toBe("failed");
    expect(view.result.current.error).toBe("The download service has not been connected yet.");
    expect(mocks.ensure).not.toHaveBeenCalled();
    expect(mocks.api).not.toHaveBeenCalled();
    expect(HTMLAnchorElement.prototype.click).not.toHaveBeenCalled();
  });
  it("explains a restricted source without exposing internal codes or creating a download", async () => {
    const implementation = mocks.api.getMockImplementation()!;
    mocks.api.mockImplementation(async (path: string, init?: RequestInit) => path === "/api/analyze/a1"
      ? { status: "failed", error_code: "SOURCE_BLOCKED" }
      : implementation(path, init));
    const view = setup();
    act(() => view.result.current.changeURL("https://example.com/v"));
    await act(async () => view.result.current.run());
    expect(view.result.current.phase).toBe("failed");
    expect(view.result.current.error).toContain("The source blocked the media request");
    expect(view.result.current.error).not.toContain("SOURCE_BLOCKED");
    expect(mocks.api.mock.calls.filter(([path]) => path === "/api/downloads")).toHaveLength(0);
    expect(HTMLAnchorElement.prototype.click).not.toHaveBeenCalled();
  });
  it("debounces duplicate paste events into one analysis and never creates a job until Download", async () => {
    const view = setup();
    act(() => { view.result.current.changeURL("https://example.com/v"); view.result.current.changeURL("https://example.com/v"); });
    await waitFor(() => expect(view.result.current.phase).toBe("choose"), { timeout: 2500 });
    expect(mocks.ensure).toHaveBeenCalledOnce();
    expect(mocks.api.mock.calls.filter(([p]) => p === "/api/analyze")).toHaveLength(1);
    expect(mocks.api.mock.calls.filter(([p]) => p === "/api/downloads")).toHaveLength(0);
    expect(HTMLAnchorElement.prototype.click).not.toHaveBeenCalled();
    view.rerender();
    await act(async () => {});
    expect(mocks.api.mock.calls.filter(([p]) => p === "/api/downloads")).toHaveLength(0);
    await act(async () => view.result.current.prepareSelected());
    expect(mocks.api.mock.calls.filter(([p]) => p === "/api/downloads")).toHaveLength(1);
    expect(HTMLAnchorElement.prototype.click).toHaveBeenCalledOnce();
  });
  it("filters Audio choices and sends only the user's selected format after an explicit Download", async () => {
    const view = setup();
    await analyze(view);
    act(() => view.result.current.changeKind("audio"));
    expect(view.result.current.formats.map((format) => format.id)).toEqual(["a-mp3"]);
    expect(view.result.current.selected).toBe("a-mp3");
    expect(mocks.api.mock.calls.filter(([p]) => p === "/api/downloads")).toHaveLength(0);
    await act(async () => view.result.current.prepareSelected());
    const request = mocks.api.mock.calls.find(([p]) => p === "/api/downloads")!;
    expect(JSON.parse(request[1].body).format_id).toBe("a-mp3");
    expect(HTMLAnchorElement.prototype.click).toHaveBeenCalledOnce();
  });
  it("does not download on type or quality changes and rejects a selected ID outside that type", async () => {
    const view = setup();
    await analyze(view);
    act(() => view.result.current.changeKind("audio"));
    act(() => view.result.current.changeKind("video"));
    act(() => view.result.current.setSelected("a-mp3"));
    await act(async () => view.result.current.prepareSelected());
    expect(mocks.api.mock.calls.filter(([p]) => p === "/api/downloads")).toHaveLength(0);
  });
  it("deduplicates a rapid double Download click while session validation is pending", async () => {
    const view = setup();
    await analyze(view);
    let resolve!: (value: unknown) => void;
    mocks.ensure.mockImplementationOnce(() => new Promise((settle) => { resolve = settle; }));
    let first!: Promise<void>; let second!: Promise<void>;
    act(() => { first = view.result.current.prepareSelected(); second = view.result.current.prepareSelected(); });
    await act(async () => { resolve({ user: { id: "guest1" } }); await Promise.all([first, second]); });
    expect(mocks.api.mock.calls.filter(([p]) => p === "/api/downloads")).toHaveLength(1);
    expect(HTMLAnchorElement.prototype.click).toHaveBeenCalledOnce();
  });
  it("reuses the prepared file when Download is clicked again with the same selection", async () => {
    const view = setup();
    await analyze(view);
    await act(async () => view.result.current.prepareSelected());
    expect(view.result.current.reusePrepared).toBe(true);
    await act(async () => view.result.current.prepareSelected());
    expect(mocks.api.mock.calls.filter(([path]) => path === "/api/downloads")).toHaveLength(1);
    expect(mocks.api.mock.calls.filter(([path]) => path.endsWith("/file"))).toHaveLength(2);
  });
  it("coalesces rapid Save file clicks into one browser download request", async () => {
    const view = setup();
    await analyze(view);
    await act(async () => view.result.current.prepareSelected());
    const before = mocks.api.mock.calls.filter(([path]) => path.endsWith("/file")).length;
    await act(async () => { await Promise.all([view.result.current.save(), view.result.current.save()]); });
    expect(mocks.api.mock.calls.filter(([path]) => path.endsWith("/file"))).toHaveLength(before + 1);
  });
  it("reuses creation idempotency after an ambiguous network failure", async () => {
    let attempts = 0;
    const implementation = mocks.api.getMockImplementation()!;
    mocks.api.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === "/api/downloads" && ++attempts === 1) throw new Error("Connection interrupted");
      return implementation(path, init);
    });
    const view = setup();
    act(() => view.result.current.changeURL("https://example.com/v"));
    await act(async () => view.result.current.run());
    await act(async () => view.result.current.prepareSelected());
    expect(view.result.current.phase).toBe("failed");
    await act(async () => view.result.current.retry());
    expect(view.result.current.downloadStarted).toBe(true);
    const bodies = mocks.api.mock.calls.filter(([p]) => p === "/api/downloads").map(([, init]) => JSON.parse(init.body));
    expect(bodies).toHaveLength(2);
    expect(bodies[0].idempotency_key).toBe(bodies[1].idempotency_key);
    expect(mocks.api.mock.calls.filter(([p]) => p === "/api/analyze")).toHaveLength(1);
  });
  it("aborts stale analysis on replacement input before it can create a job", async () => {
    let settle!: (value: unknown) => void;
    const implementation = mocks.api.getMockImplementation()!;
    mocks.api.mockImplementation((path: string, init?: RequestInit) => path === "/api/analyze" ? new Promise((resolve) => { settle = resolve; }) : implementation(path, init));
    const view = setup();
    act(() => view.result.current.changeURL("https://example.com/old"));
    let running!: Promise<void>;
    act(() => { running = view.result.current.run(); });
    await waitFor(() => expect(settle).toBeDefined());
    act(() => view.result.current.changeURL("invalid new input"));
    await act(async () => { settle({ analysis_id: "a1" }); await running; });
    expect(view.result.current.analysis).toBeUndefined();
    expect(view.result.current.analysisId).toBe("");
    expect(mocks.api.mock.calls.filter(([p]) => p === "/api/downloads")).toHaveLength(0);
  });
  it("cancellation stops a pending debounce and no job is submitted", async () => {
    const view = setup();
    act(() => view.result.current.changeURL("https://example.com/v"));
    await act(async () => view.result.current.cancel());
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(mocks.api).not.toHaveBeenCalled();
    expect(view.result.current.phase).toBe("cancelled");
  });
  it("keeps a completed job ready when automatic link retrieval fails, allowing one-click save", async () => {
    const implementation = mocks.api.getMockImplementation()!;
    let first = true;
    mocks.api.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path.endsWith("/file") && first) { first = false; throw new Error("Signed link temporarily unavailable"); }
      return implementation(path, init);
    });
    const view = setup();
    act(() => view.result.current.changeURL("https://example.com/v"));
    await act(async () => view.result.current.run());
    await act(async () => view.result.current.prepareSelected());
    expect(view.result.current.phase).toBe("completed");
    expect(view.result.current.job?.status).toBe("completed");
    expect(view.result.current.downloadStarted).toBe(false);
    await act(async () => view.result.current.save());
    expect(view.result.current.downloadStarted).toBe(true);
    expect(HTMLAnchorElement.prototype.click).toHaveBeenCalledOnce();
  });
  it("re-analyzes the same input after an expired file instead of trapping Save in a loop", async () => {
    const implementation = mocks.api.getMockImplementation()!;
    let expired = true;
    mocks.api.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path.endsWith("/file") && expired) { expired = false; throw Object.assign(new Error("File expired"), { code: "FILE_EXPIRED" }); }
      return implementation(path, init);
    });
    const view = setup();
    act(() => view.result.current.changeURL("https://example.com/v"));
    await act(async () => view.result.current.run());
    await act(async () => view.result.current.prepareSelected());
    expect(view.result.current.phase).toBe("expired");
    await act(async () => view.result.current.retry());
    expect(view.result.current.phase).toBe("choose");
    expect(view.result.current.downloadStarted).toBe(false);
    await act(async () => view.result.current.prepareSelected());
    expect(view.result.current.downloadStarted).toBe(true);
    expect(mocks.api.mock.calls.filter(([p]) => p === "/api/analyze")).toHaveLength(2);
    const bodies = mocks.api.mock.calls.filter(([p]) => p === "/api/downloads").map(([, init]) => JSON.parse(init.body));
    expect(bodies[0].idempotency_key).not.toBe(bodies[1].idempotency_key);
  });
  it("leaves no auto-starting state across an unmount and remount", async () => {
    const first = setup();
    act(() => first.result.current.changeURL("https://example.com/v"));
    first.unmount();
    const next = setup();
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(next.result.current.url).toBe("");
    expect(mocks.api).not.toHaveBeenCalled();
  });
});
