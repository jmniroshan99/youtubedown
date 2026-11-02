"""Bounded media throughput checks; loopback fixtures bypass only the test engine's URL gate."""

import functools
import http.server
import json
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path
from unittest.mock import patch

import pytest
from pydantic import ValidationError

from app.config import Settings
from app.extract import main
from app.tasks import run_media


def request(tmp_path, mode="download", fragments=4):
    return {
        "mode": mode, "url": "https://example.com/video.mp4",
        "proxy": "http://egress:8080", "max_bytes": 100,
        "max_duration": 60, "directory": str(tmp_path),
        "fragment_concurrency": fragments,
        "format": {"kind": "video", "ext": "mp4", "_selector": "18"},
    }


def downloader_stub(monkeypatch):
    captured = {}

    class Downloader:
        def __init__(self, options):
            captured.update(options)

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def extract_info(self, _url, download):
            if download:
                Path(captured["outtmpl"].replace("%(ext)s", "mp4")).write_bytes(b"fixture")
            return {
                "title": "Fixture", "duration": 1,
                "formats": [{"format_id": "18", "ext": "mp4", "vcodec": "h264", "acodec": "aac", "height": 180}],
            }

    monkeypatch.setattr("app.extract.yt_dlp.YoutubeDL", Downloader)
    monkeypatch.setattr("app.extract.emit", lambda _data: None)
    return captured


@pytest.mark.parametrize(("value", "expected"), [(1, 1), (4, 4), (8, 8), (99, 8), (0, 1), ("8", 4), (True, 4)])
def test_fragment_parallelism_is_bounded_without_changing_proxy_or_video_codecs(tmp_path, monkeypatch, value, expected):
    options = downloader_stub(monkeypatch)
    main(request(tmp_path, fragments=value))
    assert options["concurrent_fragment_downloads"] == expected
    assert options["proxy"] == "http://egress:8080"
    assert options["max_filesize"] == 100
    assert options["skip_unavailable_fragments"] is False
    # Progressive video uses original codecs; do not add a video re-encoding postprocessor.
    assert "postprocessors" not in options


def test_analysis_never_starts_parallel_media_downloads(tmp_path, monkeypatch):
    options = downloader_stub(monkeypatch)
    main(request(tmp_path, mode="analyze", fragments=8))
    assert options["concurrent_fragment_downloads"] == 1


def test_progress_throttling_keeps_every_size_check_and_final_stage(tmp_path, monkeypatch):
    options = downloader_stub(monkeypatch)
    main(request(tmp_path, mode="analyze"))
    output = []
    monkeypatch.setattr("app.extract.emit", output.append)
    monkeypatch.setattr("app.extract.time.monotonic", lambda: 1.0)
    hook = options["progress_hooks"][0]
    for downloaded in range(1, 100):
        hook({"status": "downloading", "downloaded_bytes": downloaded, "total_bytes": 100})
    assert len(output) == 1
    assert output[0]["type"] == "progress"
    with pytest.raises(ValueError, match="FILE_TOO_LARGE"):
        hook({"status": "downloading", "downloaded_bytes": 101, "total_bytes": 100})
    hook({"status": "finished"})
    assert output[-1] == {"type": "stage", "status": "processing"}


@pytest.mark.parametrize("invalid", [0, 9, -1])
def test_server_rejects_unsafe_fragment_parallelism(invalid):
    with pytest.raises(ValidationError):
        Settings(media_fragment_concurrency=invalid)


def test_parent_overwrites_untrusted_request_parallelism(tmp_path):
    real_popen = subprocess.Popen
    captured = {}

    def child(args, **kwargs):
        captured.update(json.loads(Path(args[-1]).read_text()))
        return real_popen(
            [sys.executable, "-c", 'print(\'{"type":"result","data":{"ok":true}}\')'], **kwargs,
        )

    config = Settings(temp_root=str(tmp_path), media_fragment_concurrency=2)
    with patch("app.tasks.settings", return_value=config), patch("app.tasks.subprocess.Popen", side_effect=child):
        assert run_media({"mode": "analyze", "url": "https://example.com/v", "fragment_concurrency": 99}) == {"ok": True}
    assert captured["fragment_concurrency"] == 2
    assert captured["proxy"] == config.media_proxy


@pytest.mark.skipif(not shutil.which("ffmpeg"), reason="FFmpeg required")
@pytest.mark.parametrize("fragments", [1, 4])
def test_real_hls_download_obeys_parallel_bound_and_keeps_both_streams(tmp_path, fragments):
    fixture = tmp_path / "fixture"
    fixture.mkdir()
    subprocess.run([
        "ffmpeg", "-v", "error", "-f", "lavfi", "-i", "color=c=red:s=320x180:r=10",
        "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100", "-t", "4",
        "-c:v", "libx264", "-g", "5", "-keyint_min", "5", "-sc_threshold", "0",
        "-pix_fmt", "yuv420p", "-c:a", "aac", "-f", "hls", "-hls_time", "0.5",
        "-hls_list_size", "0", "-hls_playlist_type", "vod",
        "-hls_segment_filename", str(fixture / "part-%02d.ts"), str(fixture / "stream.m3u8"),
    ], check=True, timeout=20)
    assert len(list(fixture.glob("*.ts"))) >= 4
    counters = {"active": 0, "peak": 0}
    lock = threading.Lock()

    class Handler(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_GET(self):
            fragment = self.path.split("?")[0].endswith(".ts")
            if fragment:
                with lock:
                    counters["active"] += 1
                    counters["peak"] = max(counters["peak"], counters["active"])
            try:
                if fragment:
                    time.sleep(0.08)  # Controlled latency makes actual overlapping requests observable.
                return super().do_GET()
            finally:
                if fragment:
                    with lock:
                        counters["active"] -= 1

    server = http.server.ThreadingHTTPServer(
        ("127.0.0.1", 0), functools.partial(Handler, directory=str(fixture)),
    )
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    output_dir = tmp_path / "output"
    output_dir.mkdir()
    data = {
        **request(output_dir, fragments=fragments),
        "url": f"http://127.0.0.1:{server.server_port}/stream.m3u8",
        "proxy": "", "adapter": "direct", "max_bytes": 10 * 1024 * 1024,
        "format": {"kind": "video", "ext": "mp4", "_selector": "best"},
    }
    request_file = tmp_path / "request.json"
    request_file.write_text(json.dumps(data))
    try:
        result = subprocess.run(
            [sys.executable, "-m", "app.extract", str(request_file)],
            capture_output=True, text=True, timeout=30,
        )
        events = [json.loads(line) for line in result.stdout.splitlines() if line.startswith("{")]
        assert result.returncode == 0, events
        path = next(Path(event["file"]) for event in events if event["type"] == "result")
        assert path.is_file()
        probe = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "stream=codec_type", "-of", "json", str(path)],
            capture_output=True, check=True,
        )
        assert {s["codec_type"] for s in json.loads(probe.stdout)["streams"]} == {"video", "audio"}
        assert 1 <= counters["peak"] <= fragments
        if fragments > 1:
            assert counters["peak"] >= 2
    finally:
        server.shutdown()
        server.server_close()

