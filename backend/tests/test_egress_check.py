"""The diagnostic checks CONNECT through the proxy, never resolves source DNS locally."""

import socket
import ssl
from http.server import BaseHTTPRequestHandler, HTTPServer
from threading import Thread
from unittest.mock import MagicMock, patch

import pytest

from app.egress_check import check, check_tls, tls_status, tunnel_status


def test_tunnel_diagnostic_sends_destination_to_real_local_proxy_without_resolving_it():
    requests = []

    class Handler(BaseHTTPRequestHandler):
        def do_CONNECT(self):
            requests.append((self.command, self.path, self.headers.get("Host")))
            self.send_response(200)
            self.end_headers()
            self.close_connection = True

        def log_message(self, *_args):
            pass

    resolved = []
    original_resolver = socket.getaddrinfo

    def only_proxy_dns(host, *args, **kwargs):
        resolved.append(host)
        if host != "127.0.0.1":
            raise AssertionError("The application must not resolve the source hostname")
        return original_resolver(host, *args, **kwargs)

    with HTTPServer(("127.0.0.1", 0), Handler) as server:
        thread = Thread(target=lambda: server.serve_forever(poll_interval=0.01), daemon=True)
        thread.start()
        try:
            with patch("socket.getaddrinfo", side_effect=only_proxy_dns):
                result = tunnel_status(f"http://127.0.0.1:{server.server_port}", "www.youtube.com:443")
        finally:
            server.shutdown()
            thread.join(timeout=2)
    assert result == "CONNECTED"
    assert requests == [("CONNECT", "www.youtube.com:443", "www.youtube.com:443")]
    assert resolved == ["127.0.0.1"]


@pytest.mark.parametrize(
    "status,header,expected",
    [
        (200, None, "CONNECTED"),
        (403, "TARGET_REJECTED", "TARGET_REJECTED"),
        (502, "DNS_RESOLUTION_FAILED", "DNS_RESOLUTION_FAILED"),
        (403, "DNS_RESOLUTION_FAILED", "UPSTREAM_UNAVAILABLE"),
        (502, "TARGET_REJECTED", "UPSTREAM_UNAVAILABLE"),
        (503, "private response detail", "UPSTREAM_UNAVAILABLE"),
    ],
)
def test_tunnel_diagnostic_requires_matching_status_and_fixed_error_header(status, header, expected):
    factory = MagicMock()
    response = factory.return_value.getresponse.return_value
    response.status = status
    response.getheader.return_value = header
    assert tunnel_status("http://egress:8080", "video.example.com:443", factory) == expected
    factory.assert_called_once_with("egress", 8080, timeout=10)
    factory.return_value.request.assert_called_once_with(
        "CONNECT", "video.example.com:443", headers={"Host": "video.example.com:443"}
    )
    factory.return_value.close.assert_called_once()


def test_tunnel_diagnostic_hides_connection_errors_and_closes_connection():
    factory = MagicMock()
    factory.return_value.request.side_effect = OSError("private URL and credential fixture")
    assert tunnel_status("http://egress:8080", "video.example.com:443", factory) == "PROXY_UNREACHABLE"
    factory.return_value.close.assert_called_once()


def test_tunnel_timeout_does_not_claim_the_proxy_itself_is_offline():
    factory = MagicMock()
    factory.return_value.getresponse.side_effect = TimeoutError("private connection detail")
    assert tunnel_status("http://egress:8080", "video.example.com:443", factory) == "CONNECTION_TIMEOUT"
    factory.return_value.close.assert_called_once()


@pytest.mark.parametrize(
    "proxy",
    [
        "",
        "https://egress:8080",
        "http://name:secret@egress:8080",
        "file:///tmp/proxy",
        "http://[broken",
        "http://egress:invalid",
    ],
)
def test_tunnel_diagnostic_rejects_invalid_proxy_configuration_before_connecting(proxy):
    factory = MagicMock()
    assert tunnel_status(proxy, "video.example.com:443", factory) == "PROXY_CONFIGURATION"
    factory.assert_not_called()


def test_diagnostic_uses_fixed_targets_and_reports_only_known_statuses(capsys):
    with patch("app.egress_check.tunnel_status", side_effect=["DNS_RESOLUTION_FAILED", "TARGET_REJECTED"]) as tunnel:
        assert check("http://egress:8080") is False
    assert [call.args for call in tunnel.call_args_list] == [
        ("http://egress:8080", "www.youtube.com:443"),
        ("http://egress:8080", "169.254.169.254:443"),
    ]
    output = capsys.readouterr().out
    assert "FAIL: Source-host DNS and TCP through egress (DNS_RESOLUTION_FAILED)." in output
    assert "PASS: Private metadata target rejected (TARGET_REJECTED)." in output
    assert "http://egress" not in output
    assert "www.youtube.com" not in output
    assert "169.254.169.254" not in output


@pytest.mark.parametrize(
    "status,expected",
    [
        (200, "HTTPS_REACHABLE"),
        (302, "HTTPS_REACHABLE"),
        (401, "LOGIN_REQUIRED"),
        (403, "SOURCE_BLOCKED"),
        (429, "SOURCE_RATE_LIMITED"),
        (503, "SOURCE_UNAVAILABLE"),
    ],
)
def test_https_diagnostic_enforces_verification_and_uses_only_head(status, expected):
    factory = MagicMock()
    factory.return_value.getresponse.return_value.status = status
    assert tls_status("http://egress:8080", "source.example.com", factory) == expected
    context = factory.call_args.kwargs["context"]
    assert context.check_hostname is True
    assert context.verify_mode == ssl.CERT_REQUIRED
    factory.return_value.set_tunnel.assert_called_once_with("source.example.com", 443)
    factory.return_value.request.assert_called_once_with(
        "HEAD",
        "/",
        headers={"Host": "source.example.com", "Connection": "close"},
    )
    factory.return_value.close.assert_called_once()


@pytest.mark.parametrize(
    "failure,expected",
    [
        (ssl.SSLCertVerificationError(1, "private cert and URL"), "SOURCE_TLS_ERROR"),
        (ssl.SSLError(1, "private TLS response"), "TLS_HANDSHAKE_ERROR"),
        (TimeoutError("private details"), "CONNECTION_TIMEOUT"),
        (OSError("private network details"), "SOURCE_NETWORK_ERROR"),
    ],
)
def test_https_diagnostic_hides_transport_details_and_never_retries_insecurely(failure, expected):
    factory = MagicMock()
    factory.return_value.request.side_effect = failure
    assert tls_status("http://egress:8080", "source.example.com", factory) == expected
    factory.assert_called_once()
    factory.return_value.request.assert_called_once()
    factory.return_value.close.assert_called_once()


@pytest.mark.parametrize("proxy", ["", "https://egress:8080", "http://user:secret@egress", "http://egress:invalid"])
def test_https_diagnostic_rejects_invalid_proxy_before_connecting(proxy):
    factory = MagicMock()
    assert tls_status(proxy, "source.example.com", factory) == "PROXY_CONFIGURATION"
    factory.assert_not_called()


def test_optional_https_check_keeps_control_separate_from_source_certificate_failures(capsys):
    with patch(
        "app.egress_check.tls_status", side_effect=["HTTPS_REACHABLE", "SOURCE_TLS_ERROR", "SOURCE_TLS_ERROR"]
    ) as probe:
        assert check_tls("http://egress:8080") is False
    assert [call.args[1] for call in probe.call_args_list] == ["www.youtube.com", "xhamster.com", "www.pornhub.com"]
    output = capsys.readouterr().out
    assert "PASS: Control HTTPS certificate and response (HTTPS_REACHABLE)" in output
    assert "FAIL: xHamster HTTPS certificate and response (SOURCE_TLS_ERROR)" in output
    assert "http://egress" not in output
