"""Credential-free media subprocess. Only local files reach FFmpeg postprocessing."""

import json
import os
import subprocess
import sys
import threading
import time
from pathlib import Path

from .media_errors import media_error_code
from .media_runtime import PublicYoutubeDL
from .providers import matching_provider

VIDEO_CONTAINERS = {"mp4", "webm", "mov", "mkv", "flv", "avi", "3gp", "m4v", "ts"}
NATIVE_PROTOCOLS = {None, "http", "https", "m3u8", "m3u8_native", "http_dash_segments", "dash"}


def usable_format(fmt):
    return not fmt.get("has_drm") and fmt.get("protocol") in NATIVE_PROTOCOLS and bool(fmt.get("format_id"))


def emit(data):
    print(json.dumps(data, ensure_ascii=True), flush=True)


class QuietLogger:
    def debug(self, _):
        pass

    def warning(self, _):
        pass

    def error(self, _):
        pass


def normalize(info):
    if info.get("_type") in {"playlist", "multi_video"} or "entries" in info:
        raise ValueError("PLAYLIST_UNSUPPORTED")
    if info.get("is_live") or info.get("live_status") in {"is_live", "is_upcoming"}:
        raise ValueError("LIVE_UNSUPPORTED")
    if info.get("has_drm"):
        raise ValueError("DRM_UNSUPPORTED")
    formats = info.get("formats") or [info]
    usable = [f for f in formats if usable_format(f)]
    options = []
    seen = set()
    for f in reversed(usable):
        fid = str(f.get("format_id", ""))
        ext = f.get("ext")
        if not fid or f.get("has_drm") or f.get("vcodec") == "none" or ext not in VIDEO_CONTAINERS:
            continue
        unknown_streams = f.get("vcodec") is None and f.get("acodec") is None
        audio = f.get("acodec") not in {None, "none"}
        audio_ext = {"mp4": "m4a", "webm": "webm"}.get(ext)
        available_audio = [
            x
            for x in usable
            if x.get("vcodec") == "none"
            and x.get("acodec") not in {None, "none"}
            and (ext == "mkv" or (audio_ext and x.get("ext") == audio_ext))
            and not x.get("has_drm")
        ]
        merging = not audio and bool(available_audio)
        key = (f.get("height"), ext, audio or merging, unknown_streams)
        if key in seen:
            continue
        seen.add(key)
        selector = f"{fid}+{available_audio[-1]['format_id']}" if merging else fid
        quality = f"{f['height']}p" if f.get("height") else "Original"
        options.append(
            {
                "id": f"video-{len(options)}",
                "label": f"{quality} · {ext.upper()}"
                + (" · video only" if not unknown_streams and not audio and not merging else ""),
                "kind": "video",
                "ext": ext,
                "height": f.get("height"),
                "size": f.get("filesize") if audio else None,
                "estimated_size": f.get("filesize_approx") if audio else None,
                "has_audio": None if unknown_streams else bool(audio or merging),
                "merging": merging,
                "_selector": selector,
            }
        )
    # Leave room for audio even on sources with many resolutions/codecs.
    options = options[:78]
    audio_formats = [f for f in usable if f.get("acodec") not in {None, "none"}]
    if audio_formats:
        source = next((f for f in reversed(audio_formats) if f.get("vcodec") == "none"), audio_formats[-1])
        codec = str(source["acodec"]).lower().split(".")[0]
        output = {
            "aac": "m4a",
            "mp4a": "m4a",
            "opus": "opus",
            "vorbis": "ogg",
            "mp3": "mp3",
            "flac": "flac",
            "alac": "m4a",
            "pcm_s16le": "wav",
        }.get(codec)
        if output:
            options.append(
                {
                    "id": "audio-original",
                    "label": f"Original audio · {output.upper()}",
                    "kind": "audio",
                    "ext": output,
                    "_selector": str(source["format_id"]),
                    "_audio_codec": "m4a" if codec in {"aac", "mp4a"} else "wav" if codec == "pcm_s16le" else codec,
                }
            )
        options.append(
            {
                "id": "audio-mp3",
                "label": "MP3 · converted",
                "kind": "audio",
                "ext": "mp3",
                "_selector": str(source["format_id"]),
                "_audio_codec": "mp3",
            }
        )
    if not options:
        raise ValueError("DRM_UNSUPPORTED" if any(f.get("has_drm") for f in formats) else "NO_FORMATS")
    return {
        "title": str(info.get("title") or "Untitled video")[:300],
        "duration": info.get("duration"),
        "platform": info.get("extractor_key") or "Direct media",
        "thumbnail": info.get("thumbnail"),
        "formats": options,
    }


def probe_direct(info, proxy, require_duration=False, source_url=None, source_rules=()):
    """Probe direct files through the same guarded egress; do not infer codecs from an extension."""
    need_duration = require_duration and not info.get("duration")
    formats = info.get("formats") or [info]
    unknown_codecs = any(f.get("vcodec") is None or f.get("acodec") is None for f in formats)
    if not info.get("direct") and not need_duration and not unknown_codecs:
        return
    for fmt in formats[:8]:
        need_duration = require_duration and not info.get("duration")
        # A pasted page can embed a direct file or a segmented manifest. Probe
        # the extracted media, never the HTML page in place of that media.
        url = fmt.get("manifest_url") or fmt.get("url") or source_url
        if not url or (fmt.get("vcodec") is not None and fmt.get("acodec") is not None and not need_duration):
            continue
        rule = matching_provider(url, source_rules)
        if rule and not rule["enabled"]:
            raise ValueError("SOURCE_DISABLED")
        # Carry only the public playback headers needed by sources such as
        # Pornhub/xHamster. Never accept injected CR/LF or source credentials.
        headers = {**info.get("http_headers", {}), **fmt.get("http_headers", {})}
        public_headers = "".join(
            f"{key}: {value}\r\n"
            for key, value in headers.items()
            if key.lower() in {"referer", "origin", "user-agent"} and not any(c in str(value) for c in "\r\n")
        )
        try:
            result = subprocess.run(
                [
                    "ffprobe",
                    "-v",
                    "error",
                    "-http_proxy",
                    proxy,
                    *(["-headers", public_headers] if public_headers else []),
                    "-rw_timeout",
                    "10000000",
                    "-probesize",
                    "4000000",
                    "-analyzeduration",
                    "4000000",
                    "-protocol_whitelist",
                    "http,https,tcp,tls,httpproxy",
                    "-show_entries",
                    "stream=codec_type,codec_name,height:format=duration,size",
                    "-of",
                    "json",
                    url,
                ],
                capture_output=True,
                timeout=15,
                check=True,
            )
            data = json.loads(result.stdout)
            video = next((s for s in data.get("streams", []) if s.get("codec_type") == "video"), None)
            audio = next((s for s in data.get("streams", []) if s.get("codec_type") == "audio"), None)
            if fmt.get("vcodec") is None:
                fmt["vcodec"] = video["codec_name"] if video else "none"
            if fmt.get("acodec") is None:
                fmt["acodec"] = audio["codec_name"] if audio else "none"
            if not fmt.get("height"):
                fmt["height"] = video.get("height") if video else None
            if data.get("format", {}).get("duration"):
                info["duration"] = float(data["format"]["duration"])
        except (OSError, subprocess.SubprocessError, ValueError, KeyError):
            # Original container remains selectable, but no unverified audio formats are advertised.
            continue


def main(request):
    maximum = request["max_bytes"]
    rejection = [None]
    configured_fragments = request.get("fragment_concurrency", 4)
    # The parent overwrites this setting from validated server config. Bound it
    # here too so malformed internal requests cannot start unbounded transfers.
    fragments = max(1, min(8, configured_fragments)) if type(configured_fragments) is int else 4
    progress_lock = threading.Lock()
    last_progress = [None]

    def progress(data):
        if data["status"] == "downloading":
            done = data.get("downloaded_bytes", 0)
            if done > maximum:
                raise ValueError("FILE_TOO_LARGE")
            total = data.get("total_bytes") or data.get("total_bytes_estimate")
            # Keep per-event safety checks, but avoid flooding the process pipe
            # with progress JSON for every small block/parallel fragment.
            with progress_lock:
                now = time.monotonic()
                if last_progress[0] is None or now - last_progress[0] >= 0.25:
                    last_progress[0] = now
                    emit(
                        {
                            "type": "progress",
                            "progress": min(99, round(done / total * 100, 1)) if total else None,
                            "speed": data.get("speed"),
                            "eta": data.get("eta"),
                        }
                    )
        elif data["status"] == "finished":
            emit({"type": "stage", "status": "processing"})

    def post(data):
        if data.get("status") == "started":
            emit({"type": "stage", "status": "processing"})

    def match(info, *, incomplete=False):
        if info.get("has_drm"):
            rejection[0] = "DRM_UNSUPPORTED"
            return "Protected content is unavailable"
        if info.get("is_live"):
            rejection[0] = "LIVE_UNSUPPORTED"
            return "Live content is unavailable"
        if (
            request.get("require_duration")
            and not incomplete
            and request["mode"] == "download"
            and not info.get("duration")
        ):
            probe_direct(info, request["proxy"], True, request["url"], request.get("source_rules", ()))
            if not info.get("duration"):
                rejection[0] = "DURATION_UNKNOWN"
                return "A known duration is required for guest downloads"
        if (info.get("duration") or 0) > request["max_duration"]:
            rejection[0] = "DURATION_LIMIT"
            return "Duration limit exceeded"
        return None

    options = {
        "quiet": True,
        "no_warnings": True,
        "logger": QuietLogger(),
        "noplaylist": True,
        "geo_bypass": False,
        "proxy": request["proxy"],
        "socket_timeout": 20,
        "retries": 2,
        "fragment_retries": 2,
        "skip_unavailable_fragments": False,
        "concurrent_fragment_downloads": fragments if request["mode"] == "download" else 1,
        "max_filesize": maximum,
        "cachedir": False,
        "restrictfilenames": True,
        "hls_prefer_native": True,
        "external_downloader": {"default": "native"},
        "js_runtimes": {"node": {}},
        "remote_components": [],
        "progress_hooks": [progress],
        "postprocessor_hooks": [post],
        "match_filter": match,
    }
    # All registry adapters use the normal dedicated -> generic routing chain.
    # The registry controls availability; it is not an extractor whitelist.
    if request["mode"] == "analyze":
        with PublicYoutubeDL(options, request.get("source_rules", ())) as downloader:
            result = downloader.extract_info(request["url"], download=False)
        if not result:
            raise ValueError(rejection[0] or "NO_FORMATS")
        probe_direct(
            result,
            request["proxy"],
            request.get("require_duration", False),
            request["url"],
            request.get("source_rules", ()),
        )
        if request.get("require_duration") and not result.get("duration"):
            raise ValueError("DURATION_UNKNOWN")
        if (result.get("duration") or 0) > request["max_duration"]:
            raise ValueError("DURATION_LIMIT")
        emit({"type": "result", "data": normalize(result)})
        return
    output = Path(request["directory"])
    choice = request["format"]
    options.update(
        {
            "outtmpl": str(output / "media.%(ext)s"),
            "format": choice["_selector"],
            "overwrites": True,
            "merge_output_format": choice["ext"] if choice["kind"] == "video" else None,
        }
    )
    if choice["kind"] == "audio":
        options["postprocessors"] = [
            {
                "key": "FFmpegExtractAudio",
                "preferredcodec": choice.get("_audio_codec", "mp3" if choice["ext"] == "mp3" else "best"),
                "preferredquality": "192",
            }
        ]
    with PublicYoutubeDL(options, request.get("source_rules", ())) as downloader:
        result = downloader.extract_info(request["url"], download=True)
    if not result:
        raise ValueError(rejection[0] or "NO_FORMATS")
    files = [p for p in output.glob("media.*") if p.suffix not in {".part", ".ytdl", ".json", ".temp"}]
    if len(files) != 1 or files[0].stat().st_size > maximum:
        raise ValueError("OUTPUT_INVALID")
    emit({"type": "result", "file": str(files[0])})


if __name__ == "__main__":
    try:
        main(json.loads(Path(sys.argv[1]).read_text()))
    except Exception as exc:
        # Never send raw extractor errors containing source URLs, headers or tokens.
        emit({"type": "error", "code": media_error_code(exc)})
        os._exit(1)
