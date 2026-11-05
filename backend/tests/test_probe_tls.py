"""Verified FFprobe HTTPS against disposable synthetic media, never public sites.

The loopback fixture exercises only the media engine. The production URL gate
continues to reject loopback sources; no real CA store is modified here.
"""

import functools
import http.server
import json
import shutil
import ssl
import subprocess
import threading
from contextlib import contextmanager
from unittest.mock import patch

import pytest

from app.extract import probe_direct
from app.media_errors import media_error_code


def media_info(url="https://cdn.example.test/synthetic.mp4"):
    return {"formats": [{"format_id": "source", "ext": "mp4", "url": url}]}


def test_network_probe_uses_verified_pinned_ca_without_changing_guarded_proxy():
    info = media_info()
    with patch("app.extract.subprocess.run") as probe, patch("app.extract.certifi.where", return_value="/approved/ca.pem"):
        probe.return_value.stdout = json.dumps(
            {"streams": [{"codec_type": "audio", "codec_name": "aac"}], "format": {"duration": "1"}}
        ).encode()
        probe_direct(info, "http://egress:8080", require_duration=True)
    command = probe.call_args.args[0]
    assert command[command.index("-http_proxy") + 1] == "http://egress:8080"
    assert command[command.index("-tls_verify") + 1] == "1"
    assert command[command.index("-ca_file") + 1] == "/approved/ca.pem"
    permitted_formats = set(command[command.index("-format_whitelist") + 1].split(","))
    assert permitted_formats.isdisjoint({"hls", "dash", "concat"})
    # A fixed original hostname would incorrectly validate cross-host redirects.
    assert "-verifyhost" not in command
    assert command[-1] == "https://cdn.example.test/synthetic.mp4"
    assert probe.call_args.kwargs["check"] is True


@pytest.mark.parametrize(
    "diagnostic",
    [
        b"Peer certificate failed verification: private https://source.test/?token=secret",
        b"certificate verification failed: private certificate response",
        "certificate verify failed: private https://source.test/?token=secret",
        b"The certificate's owner does not match hostname private.test",
        b"hostname mismatch: private provider details",
    ],
)
def test_certificate_probe_failure_has_safe_code_without_an_insecure_retry(diagnostic):
    info = media_info()
    with patch(
        "app.extract.subprocess.run",
        side_effect=subprocess.CalledProcessError(1, ["ffprobe"], stderr=diagnostic),
    ) as probe:
        with pytest.raises(ValueError, match="^SOURCE_TLS_ERROR$") as failure:
            probe_direct(info, "http://egress:8080", require_duration=True)
    assert media_error_code(failure.value) == "SOURCE_TLS_ERROR"
    assert probe.call_count == 1
    assert "acodec" not in info["formats"][0]
    assert "vcodec" not in info["formats"][0]
    assert "duration" not in info


def test_other_probe_errors_remain_unverified_without_returning_raw_diagnostics():
    info = media_info()
    with patch(
        "app.extract.subprocess.run",
        side_effect=subprocess.CalledProcessError(1, ["ffprobe"], stderr=b"private unavailable media token=secret"),
    ) as probe:
        probe_direct(info, "http://egress:8080", require_duration=True)
    probe.assert_called_once()
    assert "acodec" not in info["formats"][0]
    assert "vcodec" not in info["formats"][0]
    assert "duration" not in info


@pytest.fixture(scope="module")
def tls_assets(tmp_path_factory):
    if not all(shutil.which(tool) for tool in ("openssl", "ffmpeg", "ffprobe")):
        pytest.skip("OpenSSL and FFmpeg tools are required for the isolated HTTPS fixture")
    root = tmp_path_factory.mktemp("probe-tls")

    def run(*command):
        subprocess.run(command, capture_output=True, check=True, timeout=20)

    ca = root / "test-ca.pem"
    ca_key = root / "test-ca.key"
    run(
        "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "2",
        "-keyout", str(ca_key), "-out", str(ca), "-subj", "/CN=Disposable probe TLS test CA",
    )
    certificates = {}
    for name, subject, alternatives in (
        ("valid", "localhost", "DNS:localhost,IP:127.0.0.1"),
        ("wrong-host", "wrong.example.test", "DNS:wrong.example.test"),
        ("ip-only", "127.0.0.1", "IP:127.0.0.1"),
    ):
        key, csr, cert = (root / f"{name}.{suffix}" for suffix in ("key", "csr", "pem"))
        extension = root / f"{name}.ext"
        extension.write_text(
            "basicConstraints=CA:FALSE\n"
            "keyUsage=digitalSignature,keyEncipherment\n"
            "extendedKeyUsage=serverAuth\n"
            f"subjectAltName={alternatives}\n"
        )
        run("openssl", "req", "-new", "-newkey", "rsa:2048", "-nodes", "-keyout", str(key),
            "-out", str(csr), "-subj", f"/CN={subject}")
        run("openssl", "x509", "-req", "-in", str(csr), "-CA", str(ca), "-CAkey", str(ca_key),
            "-CAcreateserial", "-out", str(cert), "-days", "2", "-sha256", "-extfile", str(extension))
        certificates[name] = (cert, key)
    self_key, self_cert = root / "untrusted.key", root / "untrusted.pem"
    run(
        "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "2",
        "-keyout", str(self_key), "-out", str(self_cert), "-subj", "/CN=localhost",
        "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
    )
    certificates["untrusted"] = (self_cert, self_key)
    run(
        "ffmpeg", "-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=160x90:r=10",
        "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100", "-t", "1",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+faststart",
        str(root / "sample.mp4"),
    )
    return {"root": root, "ca": ca, "certificates": certificates}


@contextmanager
def https_fixture(assets, certificate="valid", redirect=None):
    requests = []

    class Handler(http.server.SimpleHTTPRequestHandler):
        def do_GET(self):
            requests.append(self.path)
            if self.path == "/redirect":
                self.send_response(302)
                self.send_header("Location", redirect)
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            super().do_GET()

        def log_message(self, *_args):
            pass

    handler = functools.partial(Handler, directory=str(assets["root"]))
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(*map(str, assets["certificates"][certificate]))
    server.socket = context.wrap_socket(server.socket, server_side=True)
    thread = threading.Thread(target=lambda: server.serve_forever(poll_interval=0.01), daemon=True)
    thread.start()
    try:
        yield server.server_port, requests
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


def assert_proven_streams(info):
    assert 0 < info["duration"] < 2
    assert info["formats"][0]["vcodec"] == "h264"
    assert info["formats"][0]["acodec"] == "aac"


def test_real_https_probe_accepts_only_the_explicit_test_ca_and_matching_hostname(tls_assets):
    with https_fixture(tls_assets) as (port, requests), patch("app.extract.certifi.where", return_value=str(tls_assets["ca"])):
        info = media_info(f"https://127.0.0.1:{port}/sample.mp4")
        probe_direct(info, "", require_duration=True)
    assert_proven_streams(info)
    assert requests == ["/sample.mp4"]


@pytest.mark.parametrize("certificate", ["untrusted", "wrong-host"])
def test_real_https_probe_rejects_untrusted_or_wrong_hostname_certificates(tls_assets, certificate):
    with https_fixture(tls_assets, certificate) as (port, requests), patch(
        "app.extract.certifi.where", return_value=str(tls_assets["ca"])
    ):
        info = media_info(f"https://127.0.0.1:{port}/sample.mp4")
        with pytest.raises(ValueError, match="^SOURCE_TLS_ERROR$") as failure:
            probe_direct(info, "", require_duration=True)
    assert media_error_code(failure.value) == "SOURCE_TLS_ERROR"
    assert requests == []
    assert "acodec" not in info["formats"][0]
    assert "vcodec" not in info["formats"][0]


@pytest.mark.parametrize("target_certificate", ["valid", "untrusted", "ip-only"])
def test_real_https_redirect_verifies_the_new_destination_hostname_and_chain(tls_assets, target_certificate):
    with https_fixture(tls_assets, target_certificate) as (target_port, target_requests):
        # The ip-only certificate is valid for the original redirecting host,
        # but not for the new localhost destination. Pinning verifyhost to the
        # initial URL would incorrectly trust that destination certificate.
        target = f"https://localhost:{target_port}/sample.mp4"
        with https_fixture(tls_assets, redirect=target) as (port, requests), patch(
            "app.extract.certifi.where", return_value=str(tls_assets["ca"])
        ):
            info = media_info(f"https://127.0.0.1:{port}/redirect")
            if target_certificate == "valid":
                probe_direct(info, "", require_duration=True)
                assert_proven_streams(info)
            else:
                with pytest.raises(ValueError, match="^SOURCE_TLS_ERROR$") as failure:
                    probe_direct(info, "", require_duration=True)
                assert media_error_code(failure.value) == "SOURCE_TLS_ERROR"
                assert "acodec" not in info["formats"][0]
                assert "vcodec" not in info["formats"][0]
    assert requests == ["/redirect"]
    assert target_requests == (["/sample.mp4"] if target_certificate == "valid" else [])


def test_https_media_disguising_a_manifest_cannot_start_unverified_child_requests(tls_assets):
    with https_fixture(tls_assets, "untrusted") as (child_port, child_requests):
        # A media extension and content type cannot grant a playlist demuxer
        # access to additional URLs with FFmpeg's different child TLS defaults.
        (tls_assets["root"] / "disguised.mp4").write_text(
            "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\n"
            f"https://127.0.0.1:{child_port}/sample.mp4\n#EXT-X-ENDLIST\n"
        )
        with https_fixture(tls_assets) as (port, requests), patch(
            "app.extract.certifi.where", return_value=str(tls_assets["ca"])
        ):
            info = media_info(f"https://127.0.0.1:{port}/disguised.mp4")
            probe_direct(info, "", require_duration=True)
    assert requests == ["/disguised.mp4"]
    assert child_requests == []
    assert "acodec" not in info["formats"][0]
    assert "vcodec" not in info["formats"][0]
    assert "duration" not in info
