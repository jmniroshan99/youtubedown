"""One pinned extractor runtime and public-access policy for analysis and preparation."""

import re
from itertools import islice
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

import yt_dlp
from yt_dlp.extractor.common import InfoExtractor
from yt_dlp.extractor.pornhub import PornHubIE as UpstreamPornHubIE
from yt_dlp.utils import ExtractorError
from yt_dlp.version import __version__

from .providers import matching_provider

YT_DLP_VERSION = "2026.10.26"


def verify_runtime():
    if __version__ != YT_DLP_VERSION:
        raise ValueError("EXTRACTOR_VERSION_MISMATCH")


def extractor_url(url):
    """Canonicalize ordinary share links without inventing alternate source hosts."""
    parts = urlsplit(url)
    host = (parts.hostname or "").lower().rstrip(".")
    if parts.scheme not in {"http", "https"} or not host or parts.username or parts.password:
        return url  # The public URL gate remains responsible for rejecting unsafe inputs.
    netloc = f"[{host}]" if ":" in host else host
    if parts.port and parts.port != (443 if parts.scheme == "https" else 80):
        netloc += f":{parts.port}"
    key = None
    if re.fullmatch(r"(?:[a-z0-9-]+\.)*pornhub(?:premium)?\.(?:com|net|org)", host) and parts.path in {
        "/view_video.php",
        "/video/show",
    }:
        key = "viewkey"
    elif (
        re.fullmatch(
            r"(?:[a-z0-9-]+\.)*(?:xhamster\.(?:com|one|desi)|xhms\.pro|xhamster\d+\.(?:com|desi)|xhday\.com|xhvid\.com)",
            host,
        )
        and parts.path == "/xembed.php"
    ):
        key = "video"
    query = parts.query
    if key:
        pairs = parse_qsl(query, keep_blank_values=True)
        # Preserve ambiguous/duplicate identifiers for upstream rejection.
        identifiers = [(name, value) for name, value in pairs if name == key]
        if len(identifiers) == 1:
            query = urlencode(identifiers + [(name, value) for name, value in pairs if name != key])
    return urlunsplit((parts.scheme, netloc, parts.path, query, ""))


class PornHubIE(UpstreamPornHubIE):
    """Keep upstream URL/format extraction without manufacturing age consent or solving challenges."""

    def _set_age_cookies(self, host):
        pass

    def _download_webpage_handle(self, *args, **kwargs):
        # The upstream base retries JS bot challenges through PhantomJS. Read the
        # public response once, without that challenge-solving fallback.
        result = InfoExtractor._download_webpage_handle(self, *args, **kwargs)
        if result:
            page = result[0]
            if re.search(
                r'document\.cookie\s*=\s*["\']RNKEY=|document\.location\.reload\(true\)|<body\b[^>]+\bonload=["\']go\(\)',
                page,
            ):
                raise ExtractorError("Bot detection", expected=True)
            if re.search(r"(?i)verify your age|age verification required|confirm your age", page):
                raise ExtractorError("Age verification required", expected=True)
        return result


class PublicYoutubeDL(yt_dlp.YoutubeDL):
    def __init__(self, options, source_rules=()):
        verify_runtime()
        self.source_rules = source_rules
        super().__init__(options)
        self.add_info_extractor(PornHubIE(self))

    def check_source(self, url):
        rule = matching_provider(url, self.source_rules)
        if rule and not rule["enabled"]:
            raise ValueError("SOURCE_DISABLED")

    def extract_info(self, url, *args, **kwargs):
        url = extractor_url(url)
        self.check_source(url)
        return super().extract_info(url, *args, **kwargs)

    def urlopen(self, request):
        self.check_source(request if isinstance(request, str) else request.url)
        response = super().urlopen(request)
        try:
            self.check_source(response.url)
        except Exception:
            response.close()
            raise
        return response

    def process_ie_result(self, result, download=True, extra_info=None):
        if result.get("_type") in {"playlist", "multi_video"}:
            # Inspect at most two entries. Never start downloading a collection
            # before discovering that it contains more than one item.
            if result.get("_type") != "multi_video" and result.get("extractor_key") != "Generic":
                raise ValueError("PLAYLIST_UNSUPPORTED")
            entries = list(islice(iter(result.get("entries") or []), 2))
            if len(entries) != 1 or not entries[0]:
                raise ValueError("PLAYLIST_UNSUPPORTED")
            result = entries[0]
        if result.get("is_live") or result.get("live_status") in {"is_live", "is_upcoming"}:
            raise ValueError("LIVE_UNSUPPORTED")
        if result.get("has_drm"):
            raise ValueError("DRM_UNSUPPORTED")
        return super().process_ie_result(result, download, extra_info)
