export type MediaFailureStage = "analysis" | "download";

const messages: Record<string, string> = {
  UNSUPPORTED_URL: "This link is not supported. Try the video's own page or a direct media link.",
  SOURCE_DISABLED: "This source has been disabled by the site administrator.",
  ADAPTER_UNAVAILABLE: "This source needs a server adapter that is not available yet.",
  LOGIN_REQUIRED: "The source requires its own account. This video cannot be retrieved as a public link.",
  AGE_RESTRICTED: "The source restricts access to this video. Use a publicly accessible video.",
  SOURCE_BLOCKED: "The source blocked the media request. Try again later or choose another source.",
  SOURCE_RATE_LIMITED: "The source is limiting requests. Wait before trying again.",
  SOURCE_UNAVAILABLE: "This video is unavailable at its source. Check the original video page.",
  REGION_RESTRICTED: "The source restricts this video by region, so this server cannot retrieve it.",
  SOURCE_NETWORK_ERROR: "The video source could not be reached. Check the connection and try again.",
  MULTIPLE_VIDEOS: "This page contains several videos. Paste the direct link to one video.",
  PLAYLIST: "Paste one video's link instead of a playlist.",
  PLAYLIST_UNSUPPORTED: "Paste one video's link instead of a playlist.",
  DRM: "This stream is protected and cannot be downloaded here.",
  DRM_UNSUPPORTED: "This stream is protected and cannot be downloaded here.",
  LIVE: "Live streams are not supported. Use a finished video.",
  LIVE_UNSUPPORTED: "Live streams are not supported. Use a finished video.",
  NO_FORMATS: "The source did not expose an available video or audio format.",
  FILE_TOO_LARGE: "This selection exceeds the file-size limit. Choose a smaller format.",
  MEDIA_LIMIT: "This selection exceeds the allowed size or duration. Choose a smaller format or shorter video.",
  DURATION_LIMIT: "This video exceeds the allowed duration. Choose a shorter video.",
  DURATION_UNKNOWN: "The source did not report a usable duration. Try the video's direct media link or another source.",
  TIME_LIMIT: "Preparation took too long. Try a smaller format or another source.",
  OUTPUT_INVALID: "The source returned an unusable media file. Try another available format.",
  EGRESS_NOT_CONFIGURED: "The server's protected source connection is unavailable. Please contact the site owner.",
};

export function mediaFailureMessage(code: string | null | undefined, stage: MediaFailureStage = "analysis") {
  if (code && Object.hasOwn(messages, code)) return messages[code];
  return stage === "analysis"
    ? "This page could not be analyzed. Try the video's direct link or another public source."
    : "The file could not be prepared. Retry or analyze the link for fresh formats.";
}

