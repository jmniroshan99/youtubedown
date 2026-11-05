"""Public-source compatibility without bypassing production URL/access checks."""

import functools
import http.server
import io
import json
import shutil
import subprocess
import sys
import threading
from pathlib import Path
from unittest.mock import patch
from uuid import uuid4

import fakeredis
import pytest
from yt_dlp.networking.common import Response
from yt_dlp.networking.exceptions import HTTPError, TransportError
from yt_dlp.utils import DownloadError, ExtractorError, GeoRestrictedError, UnsupportedError

from app import tasks
from app.extract import normalize, probe_direct
from app.media_errors import media_error_code
from app.providers import UnsupportedProvider, select_provider


def test_unknown_public_host_uses_normal_extractors_without_registry_writes():
    with patch("app.providers.Database") as database:
        database.return_value.rows.return_value = []
        selected = select_provider("https://videos.fixture.example/watch/1")
    assert selected == {"id": None, "name": "Automatic detection", "adapter_key": "yt_dlp", "_source_rules": []}
    database.return_value.rows.assert_called_once_with("video_providers")
    database.return_value.insert.assert_not_called()


def test_specific_disabled_subdomain_cannot_escape_through_parent_or_fallback():
    parent = {"id": "parent", "domains": ["example.com"], "enabled": True, "adapter_key": "yt_dlp"}
    child = {"id": "child", "domains": ["private.example.com"], "enabled": False, "adapter_key": "generic"}
    with patch("app.providers.Database") as database:
        database.return_value.rows.return_value = [parent, child]
        with pytest.raises(UnsupportedProvider) as exc:
            select_provider("https://private.example.com/watch/1")
    assert exc.value.code == "SOURCE_DISABLED"


@pytest.mark.parametrize("extension", ["mov", "mkv", "flv", "avi", "3gp", "m4v", "ts"])
def test_native_video_containers_keep_their_real_extension(extension):
    info = {
        "extractor_key": "FixtureSource",
        "formats": [
            {
                "format_id": "source",
                "ext": extension,
                "vcodec": "h264",
                "acodec": "aac",
                "height": 480,
            }
        ],
    }
    result = normalize(info)
    assert result["platform"] == "FixtureSource"
    video = next(option for option in result["formats"] if option["kind"] == "video")
    assert video["ext"] == extension and video["has_audio"] is True
    assert video["_selector"] == "source"
    assert any(option["id"] == "audio-mp3" for option in result["formats"])


def test_native_mov_does_not_claim_incompatible_webm_audio_merge():
    result = normalize(
        {
            "formats": [
                {"format_id": "video", "ext": "mov", "vcodec": "h264", "acodec": "none"},
                {"format_id": "audio", "ext": "webm", "vcodec": "none", "acodec": "opus"},
            ]
        }
    )
    video = next(option for option in result["formats"] if option["kind"] == "video")
    assert video["merging"] is False and video["has_audio"] is False
    assert video["_selector"] == "video"


def test_drm_only_audio_does_not_advertise_downloadable_formats():
    with pytest.raises(ValueError, match="DRM_UNSUPPORTED"):
        normalize(
            {"formats": [{"format_id": "protected", "ext": "m4a", "vcodec": "none", "acodec": "aac", "has_drm": True}]}
        )


@pytest.mark.parametrize(
    ("error", "code"),
    [
        (UnsupportedError("https://example.com/private?token=do-not-leak"), "UNSUPPORTED_URL"),
        (GeoRestrictedError("Not in region"), "REGION_RESTRICTED"),
        (ExtractorError("Please log in to continue", expected=True), "LOGIN_REQUIRED"),
        (ExtractorError("This video is only available for registered users", expected=True), "LOGIN_REQUIRED"),
        (ExtractorError("Sign in to confirm you're not a bot", expected=True), "SOURCE_BLOCKED"),
        (ExtractorError("Please confirm your age", expected=True), "AGE_RESTRICTED"),
        (ExtractorError("This video is protected by DRM", expected=True), "DRM_UNSUPPORTED"),
        (ExtractorError("This video is unavailable", expected=True), "SOURCE_UNAVAILABLE"),
        (ExtractorError("Requested format is not available", expected=True), "NO_FORMATS"),
        (ValueError("DURATION_UNKNOWN"), "DURATION_UNKNOWN"),
        (ValueError("https://example.com/private?token=do-not-leak"), "EXTRACTION_FAILED"),
        (TransportError("private network diagnostics do-not-leak"), "SOURCE_NETWORK_ERROR"),
    ],
)
def test_safe_error_categories_never_return_provider_messages(error, code):
    assert media_error_code(error) == code
    assert "do-not-leak" not in media_error_code(error)


@pytest.mark.parametrize(
    ("status", "code"),
    [
        (401, "LOGIN_REQUIRED"),
        (403, "SOURCE_BLOCKED"),
        (404, "SOURCE_UNAVAILABLE"),
        (410, "SOURCE_UNAVAILABLE"),
        (429, "SOURCE_RATE_LIMITED"),
        (503, "SOURCE_UNAVAILABLE"),
    ],
)
def test_nested_http_failures_have_specific_safe_codes(status, code):
    response = Response(
        io.BytesIO(b"private"), url="https://example.com/media?token=private", headers={}, status=status
    )
    cause = HTTPError(response)
    extraction = ExtractorError("Private provider diagnostics", cause=cause)
    wrapped = DownloadError("Private source URL", exc_info=(type(extraction), extraction, None))
    assert media_error_code(wrapped) == code


def test_exception_chain_cycles_are_bounded():
    error = ExtractorError("Unclassified source failure")
    error.cause = error
    assert media_error_code(error) == "EXTRACTION_FAILED"


@pytest.mark.parametrize("manifest", [None, "https://cdn.example.com/video.mpd"])
def test_missing_duration_probes_extracted_media_not_original_html(manifest):
    info = {"formats": [{"url": "https://cdn.example.com/video.mp4", "manifest_url": manifest}]}
    with patch("app.extract.subprocess.run") as probe:
        probe.return_value.stdout = json.dumps(
            {
                "streams": [
                    {"codec_type": "video", "codec_name": "h264", "height": 720},
                    {"codec_type": "audio", "codec_name": "aac"},
                ],
                "format": {"duration": "2"},
            }
        ).encode()
        probe_direct(info, "http://egress:8080", True, "https://site.example.com/page")
    assert probe.call_args.args[0][-1] == (manifest or "https://cdn.example.com/video.mp4")
    assert probe.call_args.args[0][probe.call_args.args[0].index("-http_proxy") + 1] == "http://egress:8080"
    assert info["duration"] == 2


def test_disabled_provider_failure_is_preserved_without_running_media():
    uid, aid = str(uuid4()), str(uuid4())
    redis = fakeredis.FakeRedis(decode_responses=True)
    with (
        patch("app.tasks.cache", return_value=redis),
        patch("app.tasks.select_provider", side_effect=UnsupportedProvider("disabled", "SOURCE_DISABLED")),
        patch("app.tasks.run_media") as media,
    ):
        tasks.analyze.run(uid, aid, "https://example.com/video")
    assert json.loads(redis.get(f"analysis:{uid}:{aid}"))["error_code"] == "SOURCE_DISABLED"
    media.assert_not_called()


@pytest.mark.skipif(not shutil.which("ffmpeg"), reason="FFmpeg required")
@pytest.mark.parametrize("guest", [False, True])
def test_real_generic_html5_embed_and_native_container(tmp_path, guest):
    # Disposable media engine fixture only. The production API rejects loopback
    # URLs; these local requests do not test or weaken the guarded egress gate.
    fixture = tmp_path / "fixture"
    fixture.mkdir()
    subprocess.run(
        [
            "ffmpeg",
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "color=c=green:s=320x180:r=10",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:sample_rate=44100",
            "-t",
            "1",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            str(fixture / "sample.mp4"),
        ],
        check=True,
        timeout=20,
    )
    subprocess.run(
        [
            "ffmpeg",
            "-v",
            "error",
            "-i",
            str(fixture / "sample.mp4"),
            "-c",
            "copy",
            str(fixture / "sample.mkv"),
        ],
        check=True,
        timeout=20,
    )
    (fixture / "page.html").write_text(
        '<!doctype html><title>Public embedded fixture</title><video controls><source src="sample.mp4" type="video/mp4"></video>'
    )

    class Handler(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *_args):
            pass

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Handler, directory=str(fixture)))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()

    def invoke(request):
        request_file = tmp_path / "request.json"
        request_file.write_text(json.dumps(request))
        result = subprocess.run(
            [sys.executable, "-m", "app.extract", str(request_file)], capture_output=True, text=True, timeout=40
        )
        events = [json.loads(line) for line in result.stdout.splitlines() if line.startswith("{")]
        assert result.returncode == 0, events
        return next(event for event in events if event["type"] == "result")

    try:
        for source in ["page.html", "sample.mkv"]:
            request = {
                "url": f"http://127.0.0.1:{server.server_port}/{source}",
                "proxy": "",
                "adapter": "yt_dlp",
                "mode": "analyze",
                "max_bytes": 10 * 1024 * 1024,
                "max_duration": 60,
                "require_duration": guest,
            }
            info = invoke(request)["data"]
            video = next(option for option in info["formats"] if option["kind"] == "video")
            assert video["has_audio"] is True
            assert info["duration"] > 0
            assert video["ext"] == ("mp4" if source.endswith("html") else "mkv")
            directory = tmp_path / source
            directory.mkdir()
            output = invoke({**request, "mode": "download", "format": video, "directory": str(directory)})
            path = Path(output["file"])
            assert path.suffix == "." + video["ext"]
            assert path.stat().st_size > 1000
    finally:
        server.shutdown()
        server.server_close()
