import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useApp } from "./context";
import { api, errorMessage, type Analysis, type Format, type Job } from "./lib";
import { isAbort } from "./hooks";
import { privateKey } from "./queryClient";
import { savePreparedVideo } from "./downloadFile";
import { mediaFailureMessage } from "./mediaErrors";

export function videoURL(value: string) {
  try {
    const url = new URL(value.trim());
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password
      ? url.href
      : "";
  } catch {
    return "";
  }
}

export function suggestedVideoFormat(analysis: Analysis): { format?: Format; note: string } {
  const maximum = analysis.download_limits?.max_bytes ?? Infinity;
  const compatible = analysis.formats.filter((f) =>
    f.kind === "video" && f.has_audio === true &&
    (f.height != null && f.height <= 1080) &&
    (f.size ?? f.estimated_size ?? 0) <= maximum,
  );
  const sorted = (ext: string, height = 1080) => compatible.filter((f) => f.ext === ext && (f.height ?? 0) <= height)
    .sort((a, b) => (b.height ?? 0) - (a.height ?? 0));
  const format = sorted("mp4", 720)[0] ?? sorted("mp4")[0] ?? sorted("webm", 720)[0] ?? sorted("webm")[0];
  if (!format) return { note: "Choose an available format and select Download. No download starts until you request it." };
  const note = [
    format.ext !== "mp4" ? "MP4 with audio is unavailable within your limits. WebM is suggested instead; you can choose another available format." : "A smaller MP4 with audio is suggested for a lighter download. Choose your preferred quality before downloading.",
    !format.size && !format.estimated_size ? "Size is unknown; the worker will enforce your file-size limit." : "",
  ].filter(Boolean).join(" ");
  return { format, note };
}

function selectableFormats(analysis: Analysis, kind: Format["kind"]) {
  const maximum = analysis.download_limits?.max_bytes ?? Infinity;
  return analysis.formats.filter((format) => format.kind === kind && (format.size ?? format.estimated_size ?? 0) <= maximum);
}

function suggestedFormat(analysis: Analysis, kind: Format["kind"]) {
  const formats = selectableFormats(analysis, kind);
  if (kind === "audio") return formats.find((format) => format.ext === "mp3") ?? formats[0];
  return suggestedVideoFormat(analysis).format ?? formats[0];
}

function expiredRequest(error: unknown) {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  return ["FILE_EXPIRED", "JOB_EXPIRED", "ANALYSIS_EXPIRED", "NOT_FOUND"].includes(code);
}

const active = new Set(["queued", "downloading", "processing", "uploading"]);

function pause(milliseconds: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();
    const done = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); resolve(); };
    const abort = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(signal.reason); };
    const timer = setTimeout(done, milliseconds);
    signal.addEventListener("abort", abort, { once: true });
  });
}

function visible(signal: AbortSignal) {
  if (!document.hidden) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();
    const cleanup = () => { document.removeEventListener("visibilitychange", change); signal.removeEventListener("abort", abort); };
    const change = () => { if (!document.hidden) { cleanup(); resolve(); } };
    const abort = () => { cleanup(); reject(signal.reason); };
    document.addEventListener("visibilitychange", change);
    signal.addEventListener("abort", abort, { once: true });
  });
}

type Action = { url: string; controller: AbortController; key: string; analysisId?: string; job?: Job; retryKey?: string; format?: Format; preparing?: boolean; expired?: boolean };

export function useAutoDownload() {
  const { ensureSession } = useApp();
  const query = useQueryClient();
  const [url, setURL] = useState("");
  const [analysis, setAnalysis] = useState<Analysis>();
  const [analysisId, setAnalysisId] = useState("");
  const [job, setJob] = useState<Job>();
  const [selected, setSelected] = useState("");
  const [kind, setKind] = useState<Format["kind"]>("video");
  const [phase, setPhase] = useState("idle");
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [downloadStarted, setDownloadStarted] = useState(false);
  const [saving, setSaving] = useState(false);
  const current = useRef<Action | undefined>(undefined);
  const input = useRef("");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const mounted = useRef(true);
  const ensure = useRef(ensureSession);
  ensure.current = ensureSession;

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; clearTimeout(timer.current); current.current?.controller.abort(); };
  }, []);

  const fail = useCallback((action: Action, exc: unknown) => {
    if (action.controller.signal.aborted || !mounted.current || current.current !== action) return;
    setError(errorMessage(exc));
    if (expiredRequest(exc)) {
      action.expired = true;
      if (action.job) { action.job = { ...action.job, status: "expired" }; setJob(action.job); }
      setPhase("expired");
    } else setPhase(action.job?.status === "completed" ? "completed" : "failed");
  }, []);

  const cancelPrevious = useCallback(() => {
    const previous = current.current;
    previous?.controller.abort();
    if (previous?.job && active.has(previous.job.status))
      void api(`/api/downloads/${previous.job.id}/cancel`, { method: "POST" }).catch(() => {});
  }, []);

  const follow = useCallback(async (action: Action, initial: Job, userId: string) => {
    let next = initial;
    const signal = action.controller.signal;
    const started = Date.now();
    for (;;) {
      signal.throwIfAborted();
      if (!mounted.current || current.current !== action) return;
      action.job = next;
      setJob(next);
      setPhase(next.status);
      query.setQueryData(privateKey(userId, "job", next.id), next);
      if (next === initial || !active.has(next.status))
        void query.invalidateQueries({ queryKey: privateKey(userId, "jobs") });
      if (!active.has(next.status)) break;
      if (Date.now() - started > 30 * 60_000) throw new Error("Processing is taking longer than expected. Check Current downloads before retrying.");
      await pause(2000, signal);
      await visible(signal);
      next = await api<Job>(`/api/downloads/${next.id}`, { signal });
    }
    if (next.status === "completed") {
      await visible(signal);
      await savePreparedVideo(next.id, signal);
      if (mounted.current && current.current === action) setDownloadStarted(true);
    } else if (next.status === "failed") {
      throw new Error(mediaFailureMessage(next.error_code, "download"));
    }
  }, [query]);

  const prepare = useCallback(async (action: Action, format: Format, userId: string) => {
    const signal = action.controller.signal;
    action.preparing = true;
    action.format = format;
    setPhase("creating");
    try {
    const next = await api<Job>("/api/downloads", {
      // Let a committed create settle so a replacement input can cancel its job.
      // api() still enforces its timeout and the global account-change signal.
      method: "POST",
      body: JSON.stringify({ analysis_id: action.analysisId, format_id: format.id, idempotency_key: action.key }),
    });
    // A response may arrive after a replacement input. Stop that server job too.
    if (signal.aborted || current.current !== action) {
      void api(`/api/downloads/${next.id}/cancel`, { method: "POST" }).catch(() => {});
      return;
    }
    await follow(action, next, userId);
    } finally { action.preparing = false; }
  }, [follow]);

  const run = useCallback(async (value: string) => {
    clearTimeout(timer.current);
    const normalized = videoURL(value);
    if (!normalized) { setError("Paste a complete HTTP or HTTPS video URL."); return; }
    if (current.current?.url === normalized && !current.current.controller.signal.aborted) return;
    cancelPrevious();
    const action: Action = { url: normalized, controller: new AbortController(), key: crypto.randomUUID() };
    current.current = action;
    const signal = action.controller.signal;
    setAnalysis(undefined); setAnalysisId(""); setJob(undefined); setSelected(""); setError(""); setNote(""); setDownloadStarted(false); setPhase("starting");
    try {
      await ensure.current();
      signal.throwIfAborted();
      setPhase("analyzing");
      const begun = await api<{ analysis_id: string }>("/api/analyze", { method: "POST", signal, body: JSON.stringify({ url: normalized }) });
      signal.throwIfAborted();
      action.analysisId = begun.analysis_id;
      setAnalysisId(begun.analysis_id);
      const started = Date.now();
      let result: Analysis;
      for (;;) {
        await visible(signal);
        signal.throwIfAborted();
        if (Date.now() - started > 180_000) throw new Error("Analysis timed out. Retry to check fresh formats.");
        result = await api<Analysis>(`/api/analyze/${begun.analysis_id}`, { signal });
        if (result.status !== "queued") break;
        await pause(2000, signal);
      }
      signal.throwIfAborted();
      if (result.status !== "completed") throw new Error(mediaFailureMessage(result.error_code));
      setAnalysis(result);
      const nextKind = selectableFormats(result, "video").length ? "video" : "audio";
      const choice = suggestedVideoFormat(result);
      setKind(nextKind);
      setNote(nextKind === "video" ? choice.note : "Choose an available audio format, then select Download audio. The video will not be included.");
      setSelected(suggestedFormat(result, nextKind)?.id ?? "");
      // Analysis only discovers choices. Creation is an explicit user action.
      setPhase("choose");
    } catch (exc) {
      fail(action, exc);
    }
  }, [cancelPrevious, fail]);

  const changeURL = useCallback((value: string) => {
    setURL(value);
    if (value === input.current) return;
    input.current = value;
    clearTimeout(timer.current);
    cancelPrevious(); current.current = undefined;
    setAnalysis(undefined); setAnalysisId(""); setJob(undefined); setError(""); setNote(""); setDownloadStarted(false); setPhase("idle");
    if (videoURL(value)) timer.current = setTimeout(() => void run(value), 600);
  }, [cancelPrevious, run]);

  const cancel = useCallback(async () => {
    clearTimeout(timer.current);
    const action = current.current;
    action?.controller.abort();
    setPhase("cancelled");
    setNote("The request was cancelled. Paste another link or select Retry.");
    if (action?.job && active.has(action.job.status)) {
      try {
        const result = await api<{ status: string }>(`/api/downloads/${action.job.id}/cancel`, { method: "POST" });
        if (mounted.current) setJob({ ...action.job, status: result.status });
      } catch (exc) { if (mounted.current) setError(errorMessage(exc)); }
    }
  }, []);

  const retry = useCallback(async () => {
    const old = current.current;
    if (old?.preparing) return;
    if (old?.expired) { old.controller.abort(); current.current = undefined; await run(input.current); return; }
    if (!old?.job) {
      if (old?.analysisId && old.format) {
        const action: Action = { ...old, controller: new AbortController() };
        action.preparing = true;
        current.current = action;
        setError(""); setDownloadStarted(false);
        try {
          const session = await ensure.current();
          action.controller.signal.throwIfAborted();
          await prepare(action, old.format, session.user.id);
        } catch (exc) { fail(action, exc); }
        finally { action.preparing = false; }
      } else { current.current = undefined; await run(input.current); }
      return;
    }
    old.controller.abort();
    const action: Action = { ...old, controller: new AbortController(), retryKey: old.retryKey ?? crypto.randomUUID() };
    old.retryKey = action.retryKey;
    action.preparing = true;
    current.current = action;
    setError(""); setDownloadStarted(false); setPhase("creating");
    try {
      const session = await ensure.current();
      action.controller.signal.throwIfAborted();
      const next = await api<Job>(`/api/downloads/${old.job.id}/retry`, { method: "POST", signal: action.controller.signal, body: JSON.stringify({ idempotency_key: action.retryKey }) });
      await follow(action, next, session.user.id);
    } catch (exc) { fail(action, exc); }
    finally { action.preparing = false; }
  }, [fail, follow, prepare, run]);

  const prepareSelected = useCallback(async () => {
    const old = current.current;
    const format = analysis && selectableFormats(analysis, kind).find((f) => f.id === selected);
    if (!old?.analysisId || !format || old.preparing || (old.job && active.has(old.job.status))) return;
    old.controller.abort();
    const action: Action = { url: old.url, analysisId: old.analysisId, controller: new AbortController(), key: !old.job && old.format?.id === format.id ? old.key : crypto.randomUUID() };
    action.preparing = true;
    current.current = action;
    setJob(undefined); setError(""); setDownloadStarted(false); setPhase("creating");
    try {
      const session = await ensure.current();
      action.controller.signal.throwIfAborted();
      await prepare(action, format, session.user.id);
    } catch (exc) { fail(action, exc); }
    finally { action.preparing = false; }
  }, [analysis, fail, kind, prepare, selected]);

  const changeKind = useCallback((nextKind: Format["kind"]) => {
    if (!analysis || current.current?.preparing) return;
    setKind(nextKind);
    setSelected(suggestedFormat(analysis, nextKind)?.id ?? "");
    setNote(nextKind === "video" ? suggestedVideoFormat(analysis).note : "Choose an available audio format, then select Download audio. The video will not be included.");
  }, [analysis]);

  const save = useCallback(async () => {
    const action = current.current;
    if (!action?.job) return;
    setSaving(true); setError("");
    try {
      await savePreparedVideo(action.job.id, action.controller.signal);
      if (mounted.current) setDownloadStarted(true);
    } catch (exc) { if (!isAbort(exc)) fail(action, exc); }
    finally { if (mounted.current) setSaving(false); }
  }, [fail]);

  return { url, changeURL, run: () => run(input.current), analysis, analysisId, job, selected, setSelected, kind, changeKind, formats: analysis ? selectableFormats(analysis, kind) : [], phase, error, note, downloadStarted, saving, save, cancel, retry, prepareSelected, processing: ["starting", "analyzing", "creating", ...active].includes(phase) };
}
