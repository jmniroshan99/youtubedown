import { useQueryClient } from "@tanstack/react-query";
import {
  ArrowRight,
  AudioLines,
  Download,
  Film,
  ListVideo,
  Plus,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react";
import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Busy, Notice } from "../components/feedback";
import { Button } from "../components/ui/button";
import { ProcessingMark } from "../components/ProcessingMark";
import { useApp } from "../context";
import { api, bytes, errorMessage, type Job } from "../lib";

import { Heading } from "../components/feedback";
import { activeStatuses, useDownloadJobs } from "../downloadQueries";
import { isAbort, useRequestLifetime } from "../hooks";
import { privateKey } from "../queryClient";
import { savePreparedVideo } from "../downloadFile";
import { mediaFailureMessage, mediaFailureReference } from "../mediaErrors";
export default function Downloads() {
  const { session } = useApp();
  const query = useQueryClient();
  const [filter, setFilter] = useState("all");
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const retryKeys = useRef(new Map<string, string>());
  const pending = useRef(new Set<string>());
  const userId = session?.user.id ?? "";
  const jobs = useDownloadJobs(userId, offset);
  const requestSignal = useRequestLifetime();
  async function action(job: Job, type: string) {
    if (pending.current.has(job.id)) return;
    pending.current.add(job.id);
    setBusy(job.id);
    setError("");
    setMessage("");
    try {
      if (type === "file") {
        await savePreparedVideo(job.id, requestSignal());
        setMessage("Download started. Check your browser downloads; saving may require browser permission.");
      } else if (type === "delete") {
        if (!window.confirm("Remove this temporary download? Its prepared file will be cleaned up after active download links expire."))
          return;
        await api(`/api/downloads/${job.id}`, {
          method: "DELETE",
          signal: requestSignal(),
        });
      } else {
        if (type === "retry" && !retryKeys.current.has(job.id)) retryKeys.current.set(job.id, crypto.randomUUID());
        await api(`/api/downloads/${job.id}/${type}`, {
          method: "POST",
          signal: requestSignal(),
          body:
            type === "retry"
              ? JSON.stringify({ idempotency_key: retryKeys.current.get(job.id) })
              : undefined,
        });
      }
      await query.invalidateQueries({ queryKey: privateKey(userId, "jobs") });
    } catch (exc) {
      if (!isAbort(exc)) setError(errorMessage(exc));
    } finally {
      pending.current.delete(job.id);
      setBusy("");
    }
  }
  const visible =
    jobs.data?.filter(
      (job) =>
        filter === "all" ||
        (filter === "active"
          ? activeStatuses.includes(job.status)
          : job.status === filter),
    ) || [];
  return (
    <div className="standard-page">
      <Heading
        eyebrow={"TEMPORARY WORKSPACE"}
        title={"Current downloads"}
        description={"Follow active jobs and save prepared files before they expire. No permanent video history is created."}
      />
      <div className="toolbar">
        <div className="tabs">
          {[
            ["all", "All"],
            ["active", "In progress"],
            ["completed", "Ready"],
            ["failed", "Failed"],
          ].map(([id, label]) => (
            <button
              key={id}
              className={filter === id ? "selected" : ""}
              onClick={() => setFilter(id)}
            >
              {label}
            </button>
          ))}
        </div>
        <Button asChild size="small">
          <Link to="/">
            <Plus size={16} />
            {"New download"}
          </Link>
        </Button>
      </div>
      {message && <Notice>{message}</Notice>}
      {error && <Notice kind="error">{error}</Notice>}
      {jobs.isError && (
        <Notice kind="error">
          {errorMessage(jobs.error)}{" "}
          <button onClick={() => jobs.refetch()}>{"Retry"}</button>
        </Notice>
      )}
      {jobs.isPending ? (
        <Busy />
      ) : jobs.isError && !jobs.data ? null : visible.length === 0 ? (
        <div className="panel empty-state">
          <div className="empty-icon">
            <ListVideo size={34} />
          </div>
          <h2>{"A fresh start for your videos."}</h2>
          <p>{"Current jobs appear here temporarily. Expired jobs are removed automatically."}</p>
          <Button asChild>
            <Link to="/">
              {"Add a video link"}
              <ArrowRight size={16} />
            </Link>
          </Button>
        </div>
      ) : (
        <div className="job-list">
          {visible.map((job) => (
            <article className="panel job-card" key={job.id}>
              <div className="job-art">
                {activeStatuses.includes(job.status) ? (
                  <ProcessingMark size="small" />
                ) : job.selected_format.toLowerCase().includes("audio") ||
                job.selected_format.includes("MP3") ? (
                  <AudioLines size={25} />
                ) : (
                  <Film size={25} />
                )}
              </div>
              <div className="job-details">
                <div className="job-title">
                  <h3>{job.title}</h3>
                  <span className={`badge status-${job.status}`}>
                    {job.status}
                  </span>
                </div>
                <div className="meta">
                  <span>{job.platform}</span>
                  <span>{job.selected_format}</span>
                  <span>{bytes(job.file_size)}</span>
                  <span>
                    {new Date(job.created_at).toLocaleString("en-US")}
                  </span>
                </div>
                {activeStatuses.includes(job.status) && (
                  <>
                    <div
                      className={`progress-track ${job.progress == null ? "indeterminate" : ""}`}
                      role="progressbar"
                      aria-label={`${job.title}: ${job.status}`}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={job.progress ?? undefined}
                    >
                      <span
                        style={
                          job.progress == null
                            ? undefined
                            : { width: `${job.progress}%` }
                        }
                      />
                    </div>
                    <p className="progress-info">
                      {job.status === "downloading"
                        ? "Current stream"
                        : job.status}{" "}
                      {job.progress != null ? `${job.progress}%` : ""}
                      {job.speed ? ` · ${bytes(job.speed)}/s` : ""}
                      {job.eta ? ` · ${job.eta.toFixed(0)}s` : ""}
                    </p>
                  </>
                )}
                {job.error_code && (
                  <p className="job-error">
                    {mediaFailureMessage(job.error_code, "download")}
                    <br />{mediaFailureReference(job.error_code, job.error_stage ?? "download")}
                  </p>
                )}
                {job.status === "completed" && job.expires_at && (
                  <p className="progress-info">
                    {"File expires:"}{" "}
                    {new Date(job.expires_at).toLocaleString("en-US")}
                  </p>
                )}
              </div>
              <div className="job-actions">
                {busy === job.id ? (
                  <>
                    <ProcessingMark size="small" active={activeStatuses.includes(job.status)} />
                    <span className="sr-only">Updating this download…</span>
                  </>
                ) : (
                  <>
                    {job.status === "completed" && (
                      <Button size="small" onClick={() => action(job, "file")}>
                        <Download size={16} />
                        {"Save file"}
                      </Button>
                    )}
                    {activeStatuses.includes(job.status) ? (
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label="Cancel download"
                        onClick={() => action(job, "cancel")}
                      >
                        <X size={18} />
                      </Button>
                    ) : (
                      <>
                        {["failed", "cancelled", "expired"].includes(
                          job.status,
                        ) && (
                          <Button
                            variant="secondary"
                            size="icon"
                            aria-label="Retry download"
                            onClick={() => action(job, "retry")}
                          >
                            <RefreshCw size={16} />
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label="Delete download"
                          onClick={() => action(job, "delete")}
                        >
                          <Trash2 size={16} />
                        </Button>
                      </>
                    )}
                  </>
                )}
              </div>
            </article>
          ))}
        </div>
      )}
      <p className="muted small-text">
        Filters apply to the current page. Up to 30 temporary downloads are shown at a time. Your browser controls the final save location.
      </p>
      <div className="pagination">
        <Button
          variant="ghost"
          disabled={offset === 0 || jobs.isFetching}
          onClick={() => setOffset(Math.max(0, offset - 30))}
        >
          {"Previous"}
        </Button>
        <span>
          {"Page"} {Math.floor(offset / 30) + 1}
        </span>
        <Button
          variant="ghost"
          disabled={jobs.isFetching || (jobs.data?.length || 0) < 30}
          onClick={() => setOffset(offset + 30)}
        >
          {"Next"}
        </Button>
      </div>
    </div>
  );
}
