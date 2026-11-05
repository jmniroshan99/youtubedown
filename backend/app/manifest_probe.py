"""Bounded verified manifest/fragment reads for local-only codec probing.

Production callers retain their mandatory guarded proxy; this helper never asks
FFmpeg to fetch a manifest, key, initialization object or media fragment.
"""

import math
import re
import xml.etree.ElementTree as ET
from urllib.parse import urljoin, urlsplit

from yt_dlp.networking import Request
from yt_dlp.utils import parse_duration, parse_m3u8_attributes

from .media_runtime import PublicYoutubeDL

MANIFEST_LIMIT = 1024 * 1024
SAMPLE_LIMIT = 4 * 1024 * 1024


class _QuietLogger:
    def debug(self, _message):
        pass

    def warning(self, _message):
        pass

    def error(self, _message):
        pass


def _url(value):
    if not isinstance(value, str) or len(value) > 4096 or any(ord(char) < 32 or ord(char) == 127 for char in value):
        raise ValueError("INVALID_URL")
    try:
        parsed = urlsplit(value)
        parsed.port
        if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password:
            raise ValueError
    except ValueError:
        raise ValueError("INVALID_URL") from None
    return value


def _positive(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value > 0


def _read(engine, url, headers, limit):
    url = _url(url)
    # PublicYoutubeDL checks the requested and final redirected source against
    # administrator rules. The existing proxy validates/pins each outbound hop.
    with engine.urlopen(Request(url, headers=headers)) as response:
        final = _url(response.url)
        body = response.read(limit + 1)
    return (body if len(body) <= limit else None), final


def _sample(engine, urls, headers):
    chunks, remaining = [], SAMPLE_LIMIT
    for url in urls:
        data, _final = _read(engine, url, headers, remaining)
        if not data:
            return None
        chunks.append(data)
        remaining -= len(data)
    return b"".join(chunks) or None


def _hls(engine, url, headers, need_sample):
    encrypted = False
    for depth in range(3):
        data, final = _read(engine, url, headers, MANIFEST_LIMIT)
        if data is None:
            return None, None
        try:
            lines = [line.strip() for line in data.decode("utf-8-sig").splitlines() if line.strip()]
        except UnicodeDecodeError:
            return None, None
        if not lines or lines[0] != "#EXTM3U":
            return None, None
        for line in lines:
            if line.startswith(("#EXT-X-KEY:", "#EXT-X-SESSION-KEY:")):
                key = parse_m3u8_attributes(line.split(":", 1)[1])
                method = key.get("METHOD")
                if method not in {"NONE", "AES-128"} or key.get("KEYFORMAT", "identity") != "identity":
                    raise ValueError("DRM_UNSUPPORTED")
                encrypted = encrypted or method == "AES-128"
        if any(line.startswith("#EXT-X-STREAM-INF:") for line in lines):
            variants = [line for line in lines if not line.startswith("#")]
            if len(variants) != 1 or depth == 2:
                return None, None
            # A selected format's variant URL takes precedence over a master.
            # Follow a master only when there is exactly one possible variant.
            url = _url(urljoin(final, variants[0]))
            continue
        if "#EXT-X-ENDLIST" not in lines:
            raise ValueError("LIVE_UNSUPPORTED")
        duration, segments, initialization = 0.0, [], []
        awaiting = False
        ranged = False
        for line in lines:
            if line.startswith("#EXTINF:"):
                try:
                    length = float(line.split(":", 1)[1].split(",", 1)[0])
                except ValueError:
                    return None, None
                if not _positive(length) or awaiting:
                    return None, None
                duration += length
                awaiting = True
            elif line.startswith("#EXT-X-BYTERANGE:"):
                ranged = True
            elif line.startswith("#EXT-X-MAP:"):
                attributes = parse_m3u8_attributes(line.split(":", 1)[1])
                if not attributes.get("URI"):
                    return None, None
                initialization.append(_url(urljoin(final, attributes["URI"])))
                ranged = ranged or "BYTERANGE" in attributes
            elif not line.startswith("#"):
                if not awaiting:
                    return None, None
                segments.append(_url(urljoin(final, line)))
                awaiting = False
        if awaiting or not segments or not _positive(duration):
            return None, None
        if not need_sample or encrypted or ranged or len(set(initialization)) > 1:
            return duration, None
        sample_urls = initialization[:1] + segments[:1]
        return duration, _sample(engine, sample_urls, headers)
    return None, None


def _dash(engine, fmt, url, headers, need_sample):
    data, final = _read(engine, url, headers, MANIFEST_LIMIT)
    if data is None:
        return None, None
    try:
        text = data.decode("utf-8-sig")
        if "\x00" in text or re.search(r"<!\s*(?:DOCTYPE|ENTITY)", text, re.I):
            return None, None
        root = ET.fromstring(text)
    except (UnicodeDecodeError, ET.ParseError):
        return None, None
    def local_name(element):
        return element.tag.rsplit("}", 1)[-1]
    if local_name(root) != "MPD":
        return None, None
    if root.get("type") == "dynamic":
        raise ValueError("LIVE_UNSUPPORTED")
    if root.get("type", "static") != "static":
        return None, None
    if any(local_name(element) == "ContentProtection" for element in root.iter()):
        raise ValueError("DRM_UNSUPPORTED")
    duration = parse_duration(root.get("mediaPresentationDuration"))
    if not _positive(duration):
        periods = [element for element in root if local_name(element) == "Period"]
        if len(periods) == 1:
            duration = parse_duration(periods[0].get("duration"))
    duration = duration if _positive(duration) else None
    if not need_sample:
        return duration, None
    fragments = fmt.get("fragments")
    if not isinstance(fragments, (list, tuple)) or not fragments or not isinstance(fragments[0], dict):
        return duration, None
    # yt-dlp prepends an initialization fragment without a duration, followed by
    # media fragments with durations. Ambiguous fragment lists stay unprobed.
    first = fragments[0]
    has_initialization = any(
        local_name(element) == "Initialization" or
        (local_name(element) == "SegmentTemplate" and element.get("initialization"))
        for element in root.iter()
    )
    if _positive(first.get("duration")):
        selected = [first]
    elif has_initialization and len(fragments) > 1 and isinstance(fragments[1], dict):
        if not _positive(fragments[1].get("duration")):
            return duration, None
        selected = fragments[:2]
    else:
        return duration, None
    if any(any(key in fragment for key in ("range", "byte_range", "byterange")) for fragment in selected):
        return duration, None
    if any(any(key.lower().endswith("range") for key in element.attrib) for element in root.iter()):
        return duration, None
    base = _url(fmt.get("fragment_base_url") or final)
    urls = []
    for fragment in selected:
        location = fragment.get("url") or fragment.get("path")
        if not isinstance(location, str) or not location:
            return duration, None
        urls.append(_url(urljoin(base, location)))
    return duration, _sample(engine, urls, headers)


def manifest_sample(fmt, proxy, headers, source_rules):
    """Return verified non-live duration and bounded bytes for local FFprobe.

    Ambiguous metadata returns None rather than choosing another rendition or
    inventing codecs. TLS, source-policy, live and DRM failures propagate.
    """
    if proxy:
        parsed_proxy = urlsplit(proxy)
        if parsed_proxy.scheme != "http" or not parsed_proxy.hostname or parsed_proxy.username or parsed_proxy.password:
            raise ValueError("EGRESS_NOT_CONFIGURED")
    protocol = fmt.get("protocol") or ""
    is_dash = protocol in {"dash", "http_dash_segments"} or any(
        urlsplit(str(fmt.get(key) or "")).path.lower().endswith(".mpd") for key in ("url", "manifest_url")
    )
    url = (fmt.get("manifest_url") or fmt.get("url")) if is_dash else (fmt.get("url") or fmt.get("manifest_url"))
    if not url:
        return None, None
    url = _url(url)
    public_headers = {
        key: str(value) for key, value in headers.items()
        if key.lower() in {"referer", "origin", "user-agent"} and not any(char in str(value) for char in "\r\n")
    }
    need_sample = fmt.get("vcodec") is None or fmt.get("acodec") is None
    options = {
        "proxy": proxy,
        "socket_timeout": 10,
        "retries": 0,
        "fragment_retries": 0,
        "cachedir": False,
        "quiet": True,
        "no_warnings": True,
        "logger": _QuietLogger(),
    }
    with PublicYoutubeDL(options, source_rules) as engine:
        return _dash(engine, fmt, url, public_headers, need_sample) if is_dash else _hls(
            engine, url, public_headers, need_sample,
        )
