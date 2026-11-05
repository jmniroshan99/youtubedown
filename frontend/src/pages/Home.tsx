import {
  ArrowDownToLine, ArrowRight, ArrowUpRight, AudioLines, Check,
  Clipboard, Clock3, Download, Film, Link2,
  LockKeyhole, ShieldCheck, SlidersHorizontal, X, RefreshCw,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Notice } from "../components/feedback";
import { ServiceConnection } from "../components/ServiceStatus";
import { Button } from "../components/ui/button";
import { ProcessingMark } from "../components/ProcessingMark";
import { useApp } from "../context";
import { apiBase, bytes, duration, supabase } from "../lib";
import { useAutoDownload, videoURL } from "../autoDownload";

function Thumbnail({ analysisId }: { analysisId: string }) {
  const [url, setUrl] = useState("");
  useEffect(() => {
    let alive = true;
    let blobURL = "";
    const controller = new AbortController();
    (async () => {
      const session = (await supabase?.auth.getSession())?.data.session;
      if (!session) return;
      const response = await fetch(apiBase + "/api/analyze/" + analysisId + "/thumbnail", {
        headers: { Authorization: "Bearer " + session.access_token },
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
        cache: "no-store",
      });
      if (!response.ok) return;
      blobURL = URL.createObjectURL(await response.blob());
      if (alive) setUrl(blobURL);
      else URL.revokeObjectURL(blobURL);
    })().catch(() => {});
    return () => { alive = false; controller.abort(); if (blobURL) URL.revokeObjectURL(blobURL); };
  }, [analysisId]);
  return <div className="video-thumb">{url ? <img src={url} alt="Video thumbnail" width={320} height={180} loading="lazy" decoding="async" /> : <Film size={42} />}</div>;
}

export default function Home({ serviceReady }: { serviceReady: boolean }) {
  const { session, loading } = useApp();
  const flow = useAutoDownload();
  const [message, setMessage] = useState("");
  const choice = flow.analysis?.formats.find((f) => f.id === flow.selected);
  const analysisPending = ["starting", "analyzing"].includes(flow.phase);
  async function paste() {
    try { flow.changeURL(await navigator.clipboard.readText()); setMessage(""); }
    catch { setMessage("Paste your link manually using Ctrl+V or your device paste menu."); }
  }
  return (
    <div className="home-page">
      <div className="hero-heading">
        <div className="eyebrow"><span className="tiny-dot" />PASTE. CHOOSE. DOWNLOAD.</div>
        <h1>Your videos,<br /><span>within reach.</span></h1>
        <p>Paste a link, choose video or audio, and download the format you want.</p>
      </div>
      <section className="download-panel panel">
        <div className="panel-top">
          <div><span className="icon-tile small"><Link2 size={19} /></span><strong>Start with a video link</strong></div>
          <span className="badge subtle"><LockKeyhole size={12} />{session?.user.is_anonymous ? "Guest workspace" : session ? "Private workspace" : "No login required"}</span>
        </div>
        <form onSubmit={(event) => { event.preventDefault(); void flow.run(); }}>
          <label className="sr-only" htmlFor="video-url">Video URL</label>
          <div className="url-input">
            <Link2 className="input-icon" size={21} />
            <input id="video-url" type="url" required placeholder="Paste your video link here…" value={flow.url}
              onChange={(e) => flow.changeURL(e.target.value)}
              onPaste={(e) => {
                const text = e.clipboardData.getData("text").trim();
                if (videoURL(text)) { e.preventDefault(); flow.changeURL(text); }
              }}
            />
            <Button type="button" variant="ghost" size="small" onClick={paste}><Clipboard size={16} />Paste</Button>
          </div>
          <div className="form-bottom">
            <span><ShieldCheck size={15} />Pasting checks formats only. You choose what to download.</span>
            {flow.processing ? (
              <Button type="button" variant="secondary" onClick={() => void flow.cancel()}><X size={17} />Cancel</Button>
            ) : (
              <Button disabled={loading || !videoURL(flow.url) || !!flow.analysis}><Link2 size={17} />Analyze link<ArrowRight size={17} /></Button>
            )}
          </div>
        </form>
        {message && <Notice>{message}</Notice>}
        {flow.error && <Notice kind="error">{flow.error}{flow.diagnostic && <p className="small-text">{flow.diagnostic}</p>}</Notice>}
        {["failed", "cancelled", "expired"].includes(flow.phase) && (
          <Button variant="secondary" size="small" onClick={() => void flow.retry()}><RefreshCw size={16} />Retry</Button>
        )}
        {!serviceReady && <ServiceConnection />}
      </section>
      {analysisPending && (
        <div className="analysis-skeleton panel" role="status" aria-live="polite">
          <ProcessingMark size="large" /><div>
            <strong>{flow.phase === "starting" ? "Starting your private session" : "Analyzing your link"}</strong>
            <p>{flow.phase === "starting" ? "Opening your private session…" : "Finding available video and audio formats…"}</p>
          </div>
        </div>
      )}
      {flow.analysis && (
        <section className="panel result-panel">
          <div className="video-overview">
            <Thumbnail key={flow.analysisId} analysisId={flow.analysisId} />
            <div><span className="badge"><Check size={13} />Formats checked</span><h2>{flow.analysis.title}</h2>
              <div className="meta"><span>{flow.analysis.platform}</span><span><Clock3 size={14} />{duration(flow.analysis.duration)}</span></div>
            </div>
          </div>
          {flow.note && <p className="muted">{flow.note}</p>}
          <div className="format-picker">
            <div className="download-kind-options" role="group" aria-label="Download type">
              <button type="button" className="download-kind-option" aria-pressed={flow.kind === "video"} disabled={flow.processing || !flow.analysis.formats.some((format) => format.kind === "video")} onClick={() => flow.changeKind("video")}><Film size={20} />Video</button>
              <button type="button" className="download-kind-option" aria-pressed={flow.kind === "audio"} disabled={flow.processing || !flow.analysis.formats.some((format) => format.kind === "audio")} onClick={() => flow.changeKind("audio")}><AudioLines size={20} />Audio</button>
            </div>
            <label className="field-label" htmlFor="format">{flow.kind === "audio" ? "Audio format and quality" : "Video format and quality"}</label>
            <select id="format" value={flow.selected} disabled={flow.processing || !flow.formats.length} onChange={(e) => flow.setSelected(e.target.value)}>
              {!flow.formats.length && <option value="">No formats available within your limits</option>}
              {flow.formats.map((format) => <option key={format.id} value={format.id}>{format.label}{format.size ? " · " + bytes(format.size) : format.estimated_size ? " · ~" + bytes(format.estimated_size) : " · Size unknown"}</option>)}
            </select>
            <div className="result-actions">
              <p className="muted format-help">{choice?.merging ? "Video and audio will be merged without upscaling." : choice?.kind === "audio" ? "Audio only. The video will not be included." : choice?.has_audio === false ? "This source format contains video without audio." : "Original source quality, without upscaling."} {choice?.kind === "video" && choice.ext !== "mp4" ? `This download keeps the ${choice.ext.toUpperCase()} container; a compatible player may be needed. ` : ""}Size: {choice?.size ? bytes(choice.size) : choice?.estimated_size ? "About " + bytes(choice.estimated_size) : "Unknown until processed"}</p>
              <Button disabled={!choice || flow.processing || flow.saving} onClick={() => void flow.prepareSelected()}><Download size={17} />{flow.reusePrepared ? "Save prepared file" : flow.kind === "audio" ? "Download audio" : "Download video"}</Button>
            </div>
          </div>
          {(flow.job || flow.phase === "creating") && (
            <div className="auto-download-status" role="status" aria-live="polite">
              <strong>{flow.phase === "completed" ? "File ready" : flow.phase === "creating" ? "Adding your download to the queue…" : flow.phase === "cancelled" ? "Preparation cancelled" : "Preparing your download: " + flow.phase}</strong>
              {flow.job && <p className="muted">Requested format: {flow.job.selected_format}</p>}
              {flow.job?.progress != null && flow.processing && (
                <div className="progress-track" role="progressbar" aria-label="Download preparation" aria-valuemin={0} aria-valuemax={100} aria-valuenow={flow.job.progress}>
                  <span style={{ width: flow.job.progress + "%" }} />
                </div>
              )}
              {flow.processing && <p className="processing-line"><ProcessingMark size="small" /><span>Keep this page open. Your browser download will start when the file is ready.</span></p>}
              {flow.job?.status === "completed" && (
                <>
                  <p>{flow.downloadStarted ? "Download started. Check your browser downloads; saving may require browser permission." : "Your file is ready. Select Save file if your browser needs a click to start."}</p>
                  <Button disabled={flow.saving} onClick={() => void flow.save()}><Download size={17} />{flow.saving ? "Opening download…" : "Save file"}</Button>
                  <p className="muted small-text">Your browser chooses the Downloads folder or asks where to save. Prepared files and current jobs expire automatically.</p>
                </>
              )}
              <p><Link to="/downloads">View Current downloads</Link></p>
            </div>
          )}
        </section>
      )}
      <div className="source-strip"><span>POPULAR SOURCES</span><div>
        {["YouTube", "Vimeo", "TikTok", "Instagram", "Facebook", "X"].map((name) => <span key={name}><span className={"source-symbol source-" + name.toLowerCase()}>{name[0]}</span>{name}</span>)}
        <Link to="/sources">Explore sources<ArrowUpRight size={14} /></Link>
      </div><small>Availability depends on the video and the source website.</small></div>
      <section className="how-section"><div className="section-title"><h2>From a link to your device.</h2><span>THREE SIMPLE STEPS</span></div>
        <div className="steps-grid">
          {[
            { icon: Link2, number: "01", title: "Drop your link", text: "Paste a complete video URL. Analysis starts automatically with a private session." },
            { icon: SlidersHorizontal, number: "02", title: "Choose what you need", text: "Select Video or Audio, then choose your preferred available format and quality." },
            { icon: ArrowDownToLine, number: "03", title: "Download to your device", text: "Select Download to start preparation. Your browser saves the ready file; use Save file if it requires another click." },
          ].map(({ icon: Icon, number, title, text }) => <article className="step-card" key={number}><div className="step-top"><span className="icon-tile"><Icon size={21} /></span><span className="step-number">{number}</span></div><h3>{title}</h3><p>{text}</p></article>)}
        </div>
      </section>
      <div className="quality-note"><AudioLines size={22} /><div><strong>Save to your device.</strong><p>No permanent video library is kept on the server. Temporary prepared files expire.</p></div><span className="badge subtle">MP4 / WEBM / MP3</span></div>
    </div>
  );
}
