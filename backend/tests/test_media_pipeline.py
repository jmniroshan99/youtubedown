"""Real yt-dlp + FFmpeg test against a disposable local synthetic media fixture.
This intentionally exercises the media engine in isolation, NOT the production URL gate.
The production API must reject this fixture's loopback address.
"""

import functools
import http.server
import json
import shutil
import subprocess
import sys
import threading
from pathlib import Path

import pytest


@pytest.mark.skipif(not shutil.which("ffmpeg"), reason="FFmpeg is required")
@pytest.mark.parametrize("guest", [False, True])
def test_direct_video_and_mp3_conversion(tmp_path, guest):
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
            "color=c=blue:s=320x180:r=10",
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
            "-movflags",
            "+faststart",
            str(fixture / "sample.mp4"),
        ],
        check=True,
        timeout=20,
    )

    class QuietHandler(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *_args):
            pass

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(QuietHandler, directory=str(fixture)))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    url = f"http://127.0.0.1:{server.server_port}/sample.mp4"
    common = {
        "url": url,
        "proxy": "",
        "adapter": "direct",
        "max_bytes": 10 * 1024 * 1024,
        "max_duration": 60,
        "require_duration": guest,
    }

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
        analysis = invoke({**common, "mode": "analyze"})["data"]
        video = next(f for f in analysis["formats"] if f["kind"] == "video")
        mp3 = next(f for f in analysis["formats"] if f["id"] == "audio-mp3")
        assert video["height"] == 180
        for index, choice in enumerate([video, mp3]):
            directory = tmp_path / f"output{index}"
            directory.mkdir()
            result = invoke({**common, "mode": "download", "format": choice, "directory": str(directory)})
            path = Path(result["file"])
            assert path.exists() and path.stat().st_size > 1000
            assert path.suffix == (".mp3" if choice["kind"] == "audio" else ".mp4")
        # Exercise both segmented protocols, including separate video/audio DASH tracks.
        for protocol in ["dash", "hls"]:
            manifest = fixture / ("manifest.mpd" if protocol == "dash" else "stream.m3u8")
            subprocess.run(
                [
                    "ffmpeg",
                    "-v",
                    "error",
                    "-i",
                    str(fixture / "sample.mp4"),
                    "-map",
                    "0",
                    "-c",
                    "copy",
                    "-f",
                    protocol,
                    str(manifest),
                ],
                check=True,
                timeout=20,
            )
            segmented = {**common, "url": f"http://127.0.0.1:{server.server_port}/{manifest.name}"}
            info = invoke({**segmented, "mode": "analyze"})["data"]
            choice = next(f for f in info["formats"] if f["kind"] == "video")
            if protocol == "dash":
                assert choice["merging"]
            directory = tmp_path / protocol
            directory.mkdir()
            output = invoke({**segmented, "mode": "download", "format": choice, "directory": str(directory)})
            probe = subprocess.run(
                ["ffprobe", "-v", "error", "-show_entries", "stream=codec_type", "-of", "json", output["file"]],
                capture_output=True,
                check=True,
            )
            streams = {stream["codec_type"] for stream in json.loads(probe.stdout)["streams"]}
            assert streams == {"video", "audio"}
    finally:
        server.shutdown()
        server.server_close()
