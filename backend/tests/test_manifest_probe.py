"""Manifest metadata is bounded; only verified bytes reach local codec probing."""

import io
import shutil
import ssl
import subprocess
from http.server import BaseHTTPRequestHandler, HTTPServer
from threading import Thread
from unittest.mock import patch

import pytest
import yt_dlp
from yt_dlp.networking.common import Response
from yt_dlp.networking.exceptions import CertificateVerifyError

from app.manifest_probe import MANIFEST_LIMIT, SAMPLE_LIMIT, manifest_sample

BASE = "https://media.example/"
HLS = {"url": BASE + "video.m3u8", "protocol": "m3u8_native"}
PLAYLIST = b"#EXTM3U\n#EXT-X-MAP:URI=\"init.mp4\"\n#EXTINF:1.25,\nfirst.m4s\n#EXTINF:2.75,\nsecond.m4s\n#EXT-X-ENDLIST\n"
MPD = b'<MPD type="static" mediaPresentationDuration="PT4S"><Period><AdaptationSet><SegmentTemplate initialization="init.mp4"/></AdaptationSet></Period></MPD>'
DASH = {
    "url": BASE + "video.mpd",
    "protocol": "http_dash_segments",
    "fragment_base_url": BASE + "selected/",
    "fragments": [{"path": "init.mp4"}, {"path": "first.m4s", "duration": 2}, {"path": "second.m4s", "duration": 2}],
}


@pytest.fixture
def transport(monkeypatch):
    payloads, calls, responses = {}, [], []

    def serve(engine, request):
        calls.append(request)
        assert engine.params["socket_timeout"] == 10
        assert engine.params["retries"] == engine.params["fragment_retries"] == 0
        assert not engine.params.get("nocheckcertificate")
        assert not engine.params.get("legacyserverconnect")
        value = payloads[request.url]
        if isinstance(value, Exception):
            raise value
        body, final = value if isinstance(value, tuple) else (value, request.url)
        response = Response(io.BytesIO(body), url=final, headers={})
        responses.append(response)
        return response

    monkeypatch.setattr(yt_dlp.YoutubeDL, "urlopen", serve)
    return payloads, calls, responses


def test_hls_selected_variant_duration_and_only_first_init_media_sample(transport):
    payloads, calls, responses = transport
    payloads.update({HLS["url"]: PLAYLIST, BASE + "init.mp4": b"init", BASE + "first.m4s": b"media"})
    fmt = {**HLS, "manifest_url": BASE + "unselected-master.m3u8"}
    headers = {"Referer": "https://page.example/", "User-Agent": "Fixture", "Cookie": "private", "Origin": "bad\r\nvalue"}
    assert manifest_sample(fmt, "http://egress:8080", headers, ()) == (4.0, b"initmedia")
    assert [request.url for request in calls] == [HLS["url"], BASE + "init.mp4", BASE + "first.m4s"]
    assert all(request.headers.get("Referer") == "https://page.example/" for request in calls)
    assert all(not request.headers.get("Cookie") and not request.headers.get("Origin") for request in calls)
    assert all(response.closed for response in responses)


def test_hls_known_codecs_need_only_manifest_duration(transport):
    payloads, calls, _ = transport
    payloads[HLS["url"]] = PLAYLIST
    assert manifest_sample({**HLS, "vcodec": "h264", "acodec": "aac"}, "http://egress:8080", {}, ()) == (4, None)
    assert len(calls) == 1


@pytest.mark.parametrize("levels,expected", [(2, (4, None)), (3, (None, None))])
def test_hls_follows_at_most_two_unambiguous_master_levels(transport, levels, expected):
    payloads, calls, _ = transport
    for index in range(levels):
        payloads[BASE + f"level{index}.m3u8"] = f"#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100\nlevel{index + 1}.m3u8\n".encode()
    payloads[BASE + f"level{levels}.m3u8"] = PLAYLIST
    fmt = {"url": BASE + "level0.m3u8", "vcodec": "h264", "acodec": "aac"}
    assert manifest_sample(fmt, "http://egress:8080", {}, ()) == expected
    assert len(calls) == 3


def test_hls_does_not_choose_an_arbitrary_quality(transport):
    payloads, calls, _ = transport
    payloads[HLS["url"]] = b"#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100\na.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=200\nb.m3u8\n"
    assert manifest_sample(HLS, "http://egress:8080", {}, ()) == (None, None)
    assert len(calls) == 1


@pytest.mark.parametrize("key", [b'#EXT-X-KEY:METHOD=AES-128,URI="key"\n', b'#EXT-X-KEY:METHOD=AES-128,URI="key"\n#EXT-X-KEY:METHOD=NONE\n'])
def test_hls_public_aes_duration_does_not_fetch_keys_or_ciphertext(transport, key):
    payloads, calls, _ = transport
    payloads[HLS["url"]] = PLAYLIST.replace(b"#EXTM3U\n", b"#EXTM3U\n" + key)
    assert manifest_sample(HLS, "http://egress:8080", {}, ()) == (4, None)
    assert len(calls) == 1


@pytest.mark.parametrize("key", [b"METHOD=SAMPLE-AES", b'METHOD=AES-128,KEYFORMAT="com.example.drm"'])
def test_hls_rejects_protected_key_methods(transport, key):
    payloads, calls, _ = transport
    payloads[HLS["url"]] = PLAYLIST.replace(b"#EXTM3U\n", b"#EXTM3U\n#EXT-X-KEY:" + key + b"\n")
    with pytest.raises(ValueError, match="^DRM_UNSUPPORTED$"):
        manifest_sample(HLS, "http://egress:8080", {}, ())
    assert len(calls) == 1


def test_hls_rejects_live_before_segment_reads(transport):
    payloads, calls, _ = transport
    payloads[HLS["url"]] = PLAYLIST.replace(b"#EXT-X-ENDLIST\n", b"")
    with pytest.raises(ValueError, match="^LIVE_UNSUPPORTED$"):
        manifest_sample(HLS, "http://egress:8080", {}, ())
    assert len(calls) == 1


@pytest.mark.parametrize("playlist", [
    PLAYLIST.replace(b"#EXTINF:1.25,", b"#EXT-X-BYTERANGE:100@0\n#EXTINF:1.25,"),
    PLAYLIST.replace(b'URI="init.mp4"', b'URI="init.mp4",BYTERANGE="100@0"'),
])
def test_hls_byte_ranges_keep_duration_without_guessing_sample_bytes(transport, playlist):
    payloads, calls, _ = transport
    payloads[HLS["url"]] = playlist
    assert manifest_sample(HLS, "http://egress:8080", {}, ()) == (4, None)
    assert len(calls) == 1


def test_manifest_and_combined_sample_reads_are_bounded(transport):
    payloads, calls, _ = transport
    payloads[HLS["url"]] = b"x" * (MANIFEST_LIMIT + 1)
    assert manifest_sample(HLS, "http://egress:8080", {}, ()) == (None, None)
    payloads.update({HLS["url"]: PLAYLIST, BASE + "init.mp4": b"i" * (SAMPLE_LIMIT - 1), BASE + "first.m4s": b"oversized"})
    assert manifest_sample(HLS, "http://egress:8080", {}, ()) == (4, None)
    assert len(calls) == 4


def test_dash_uses_only_selected_init_and_first_fragment(transport):
    payloads, calls, _ = transport
    payloads.update({DASH["url"]: MPD, BASE + "selected/init.mp4": b"init", BASE + "selected/first.m4s": b"media"})
    assert manifest_sample(DASH, "http://egress:8080", {}, ()) == (4, b"initmedia")
    assert [request.url for request in calls] == [DASH["url"], BASE + "selected/init.mp4", BASE + "selected/first.m4s"]


@pytest.mark.parametrize("manifest,result", [
    (b'<!DOCTYPE MPD [<!ENTITY unsafe "payload">]><MPD type="static">&unsafe;</MPD>', (None, None)),
    (b"<invalid", (None, None)),
])
def test_dash_ambiguous_or_unsafe_xml_stays_unprobed(transport, manifest, result):
    payloads, calls, _ = transport
    payloads[DASH["url"]] = manifest
    assert manifest_sample(DASH, "http://egress:8080", {}, ()) == result
    assert len(calls) == 1


@pytest.mark.parametrize("manifest,duration", [
    (MPD.replace(b' type="static"', b""), 4),
    (b'<MPD type="static"><Period duration="PT4S"/></MPD>', 4),
    (b'<MPD type="static"><Period duration="PT4S"/><Period duration="PT2S"/></MPD>', None),
])
def test_dash_implicit_static_and_exact_single_period_duration(transport, manifest, duration):
    payloads, calls, _ = transport
    payloads[DASH["url"]] = manifest
    fmt = {**DASH, "vcodec": "h264", "acodec": "none"}
    assert manifest_sample(fmt, "http://egress:8080", {}, ()) == (duration, None)
    assert len(calls) == 1


@pytest.mark.parametrize("manifest,code", [
    (MPD.replace(b'"static"', b'"dynamic"'), "LIVE_UNSUPPORTED"),
    (MPD.replace(b"<Period>", b"<Period><ContentProtection/>"), "DRM_UNSUPPORTED"),
])
def test_dash_live_and_drm_are_rejected(transport, manifest, code):
    payloads, calls, _ = transport
    payloads[DASH["url"]] = manifest
    with pytest.raises(ValueError, match="^" + code + "$"):
        manifest_sample(DASH, "http://egress:8080", {}, ())
    assert len(calls) == 1


def test_dash_byte_ranges_or_ambiguous_fragments_do_not_guess_samples(transport):
    payloads, calls, _ = transport
    payloads[DASH["url"]] = MPD
    ranged = {**DASH, "fragments": [{"path": "init.mp4", "range": "0-99"}, {"path": "first.m4s", "duration": 2}]}
    assert manifest_sample(ranged, "http://egress:8080", {}, ()) == (4, None)
    assert manifest_sample({**DASH, "fragments": [{"path": "unknown.m4s"}]}, "http://egress:8080", {}, ()) == (4, None)
    assert len(calls) == 2


@pytest.mark.parametrize("url", ["file:///tmp/source", "ftp://media.example/video", "https://name:secret@media.example/video"])
def test_non_http_and_credential_urls_are_rejected_before_fetch(transport, url):
    _payloads, calls, _ = transport
    with pytest.raises(ValueError, match="^INVALID_URL$"):
        manifest_sample({"url": url}, "http://egress:8080", {}, ())
    assert not calls


def test_source_rules_apply_to_manifest_redirect_and_segment(transport):
    payloads, calls, responses = transport
    rules = [{"domains": ["disabled.example"], "enabled": False}]
    payloads[HLS["url"]] = (PLAYLIST, "https://disabled.example/final.m3u8")
    with pytest.raises(ValueError, match="^SOURCE_DISABLED$"):
        manifest_sample(HLS, "http://egress:8080", {}, rules)
    assert responses[-1].closed
    payloads[HLS["url"]] = b"#EXTM3U\n#EXTINF:4,\nhttps://disabled.example/segment.ts\n#EXT-X-ENDLIST\n"
    with pytest.raises(ValueError, match="^SOURCE_DISABLED$"):
        manifest_sample(HLS, "http://egress:8080", {}, rules)
    assert len(calls) == 2


@pytest.mark.skipif(not shutil.which("openssl"), reason="OpenSSL is required for the isolated TLS fixture")
def test_untrusted_https_segment_is_rejected_by_real_verified_transport(tmp_path):
    cert, key = tmp_path / "untrusted.pem", tmp_path / "untrusted.key"
    subprocess.run([
        "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
        "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost",
        "-keyout", str(key), "-out", str(cert),
    ], check=True, capture_output=True, timeout=15)
    requests = []

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            requests.append(self.path)
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"untrusted media fixture")

        def log_message(self, *_args):
            pass

    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(cert, key)
    original = yt_dlp.YoutubeDL.urlopen
    with HTTPServer(("127.0.0.1", 0), Handler) as server:
        server.socket = context.wrap_socket(server.socket, server_side=True)
        thread = Thread(target=server.serve_forever, daemon=True)
        thread.start()

        def transport(engine, request):
            if request.url == HLS["url"]:
                body = f"#EXTM3U\n#EXTINF:1,\nhttps://localhost:{server.server_port}/segment.ts\n#EXT-X-ENDLIST\n".encode()
                return Response(io.BytesIO(body), url=request.url, headers={})
            return original(engine, request)

        try:
            with patch.object(yt_dlp.YoutubeDL, "urlopen", transport):
                with pytest.raises(CertificateVerifyError):
                    manifest_sample(HLS, "", {}, ())
        finally:
            server.shutdown()
            thread.join(timeout=3)
    assert not requests, "An HTTP media request passed the untrusted TLS certificate"
