"""Reduce extractor failures to safe public codes, never raw URLs or messages."""

import ssl

from yt_dlp.networking.exceptions import CertificateVerifyError, HTTPError, RequestError
from yt_dlp.utils import ExtractorError, GeoRestrictedError, UnsupportedError

KNOWN_MEDIA_ERRORS = {
    "NO_FORMATS",
    "LIVE_UNSUPPORTED",
    "DRM_UNSUPPORTED",
    "PLAYLIST_UNSUPPORTED",
    "DURATION_LIMIT",
    "DURATION_UNKNOWN",
    "FILE_TOO_LARGE",
    "OUTPUT_INVALID",
    "SOURCE_DISABLED",
    "SOURCE_TLS_ERROR",
    "EXTRACTOR_VERSION_MISMATCH",
}


def media_error_code(error):
    """Inspect a bounded exception chain; text is used only for typed extractor errors."""
    pending, seen, chain = [error], set(), []
    while pending and len(chain) < 12:
        current = pending.pop(0)
        if not isinstance(current, BaseException) or id(current) in seen:
            continue
        seen.add(id(current))
        chain.append(current)
        info = getattr(current, "exc_info", None)
        if isinstance(info, tuple) and len(info) > 1:
            pending.append(info[1])
        pending.extend([getattr(current, "cause", None), current.__cause__, current.__context__])
    for current in chain:
        if isinstance(current, (CertificateVerifyError, ssl.SSLCertVerificationError)):
            return "SOURCE_TLS_ERROR"
        if isinstance(current, ValueError) and str(current) in KNOWN_MEDIA_ERRORS:
            return str(current)
        if isinstance(current, UnsupportedError):
            return "UNSUPPORTED_URL"
        if isinstance(current, GeoRestrictedError):
            return "REGION_RESTRICTED"
    for current in chain:
        if isinstance(current, HTTPError):
            if current.status == 401:
                return "LOGIN_REQUIRED"
            if current.status == 403:
                return "SOURCE_BLOCKED"
            if current.status in {404, 410}:
                return "SOURCE_UNAVAILABLE"
            if current.status == 429:
                return "SOURCE_RATE_LIMITED"
            if current.status >= 500:
                return "SOURCE_UNAVAILABLE"
        elif isinstance(current, RequestError):
            return "SOURCE_NETWORK_ERROR"
    for current in chain:
        if not isinstance(current, ExtractorError):
            continue
        # Login failures have no dedicated yt-dlp class. Map narrow, conventional
        # extractor messages locally; do not send their title/URL/token text out.
        message = str(getattr(current, "orig_msg", "")).lower()
        if any(part in message for part in ("drm protected", "drm-protected", "protected by drm")):
            return "DRM_UNSUPPORTED"
        if any(part in message for part in ("confirm your age", "verify your age", "age verification", "age restricted", "age-restricted")):
            return "AGE_RESTRICTED"
        if any(part in message for part in ("captcha", "cloudflare", "not a bot", "access denied", "bot detection")):
            return "SOURCE_BLOCKED"
        if any(
            part in message
            for part in (
                "login required",
                "login is required",
                "log in",
                "sign in",
                "private video",
                "authentication required",
                "only available for registered users",
                "is locked",
                "require login",
            )
        ):
            return "LOGIN_REQUIRED"
        if any(part in message for part in ("paywall", "premium only", "premium-only", "subscription required", "purchase required")):
            return "PAYWALL_RESTRICTED"
        if any(part in message for part in ("too many requests", "rate limit")):
            return "SOURCE_RATE_LIMITED"
        if any(part in message for part in ("not available in your country", "geo restricted", "geo-restricted")):
            return "REGION_RESTRICTED"
        if any(
            part in message
            for part in ("video unavailable", "video is unavailable", "has been removed", "no longer available")
        ):
            return "SOURCE_UNAVAILABLE"
        if any(
            part in message
            for part in ("no video formats found", "requested format is not available", "no video could be found")
        ):
            return "NO_FORMATS"
    # DownloadError can contain arbitrarily detailed diagnostics. Unknown errors
    # remain generic; neither raw messages nor provider credentials reach clients.
    return "EXTRACTION_FAILED"
