import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ api: vi.fn(), channel: vi.fn() }));
vi.mock("../src/lib", () => ({ api: mocks.api, supabase: { channel: mocks.channel } }));
import { activeStatuses, jobsPollInterval, useDownloadJobs } from "../src/downloadQueries";
import { createQueryClient } from "../src/queryClient";
import type { Job } from "../src/lib";
const q = createQueryClient();
function wrapper({ children }: { children: ReactNode }) { return <QueryClientProvider client={q}>{children}</QueryClientProvider>; }
beforeEach(() => {
  Object.defineProperty(document, "hidden", { value: false, configurable: true });
  mocks.api.mockReset().mockResolvedValue([]);
  mocks.channel.mockReset();
});
afterEach(() => { cleanup(); q.clear(); });
describe("temporary downloads", () => {
  it.each(activeStatuses)("polls visible %s work within a bounded interval", (status) => {
    expect(jobsPollInterval([{ status } as Job], false)).toBe(5000);
  });
  it("backs off for idle jobs and errors", () => {
    expect(jobsPollInterval([], false)).toBe(30000);
    expect(jobsPollInterval(undefined, true)).toBe(30000);
  });
  it("passes pagination and cancellation signals without a database Realtime channel", async () => {
    const view = renderHook(() => useDownloadJobs("alice", 30), { wrapper });
    await waitFor(() => expect(mocks.api).toHaveBeenCalledOnce());
    expect(mocks.api.mock.calls[0][0]).toBe("/api/downloads?offset=30");
    const signal = mocks.api.mock.calls[0][1].signal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(mocks.channel).not.toHaveBeenCalled();
    view.unmount();
  });
  it("turns interval polling off when hidden", async () => {
    renderHook(() => useDownloadJobs("alice", 0), { wrapper });
    await waitFor(() => expect(mocks.api).toHaveBeenCalledOnce());
    act(() => {
      Object.defineProperty(document, "hidden", { value: true, configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    const observer = q.getQueryCache().find({ queryKey: ["private", "alice", "jobs", 0] });
    expect(observer).toBeDefined();
    expect(mocks.channel).not.toHaveBeenCalled();
  });
});
