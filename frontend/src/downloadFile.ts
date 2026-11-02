import { api } from "./lib";

export type DownloadLink = { url: string; filename?: string; expires_in?: number };

// Normal browser downloads stream directly to the browser's download manager.
// The final response supplies Content-Disposition; cross-origin download attributes
// alone cannot select a filename. Never buffer a video in a Blob or browser DB.
export function startBrowserDownload(file: DownloadLink) {
  const url = new URL(file.url, window.location.href);
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    (window.location.protocol === "https:" && url.protocol !== "https:")
  )
    throw new Error("The service returned an invalid download address.");
  const anchor = document.createElement("a");
  anchor.href = url.href;
  anchor.rel = "noreferrer";
  anchor.referrerPolicy = "no-referrer";
  if (file.filename) anchor.download = file.filename;
  document.body.appendChild(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
  }
}

export async function savePreparedVideo(jobId: string, signal: AbortSignal) {
  const file = await api<DownloadLink>(`/api/downloads/${jobId}/file`, { signal });
  signal.throwIfAborted();
  startBrowserDownload(file);
  return file;
}
