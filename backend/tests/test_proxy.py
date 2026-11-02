import importlib.util
import socket
from contextlib import contextmanager
from pathlib import Path
from threading import Thread
from unittest.mock import MagicMock, patch

import pytest

spec = importlib.util.spec_from_file_location(
    "videoflow_egress", Path(__file__).resolve().parents[2] / "egress" / "proxy.py"
)
proxy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(proxy)


def test_connection_is_pinned_after_validation():
    connection = MagicMock()
    with (
        patch.object(proxy, "public_addresses", return_value=["8.8.8.8"]) as resolver,
        patch.object(proxy.socket, "socket", return_value=connection),
    ):
        assert proxy.connect_public("video.example", 443) is connection
    resolver.assert_called_once_with("video.example", 443)
    connection.connect.assert_called_once_with(("8.8.8.8", 443))


def test_private_rebinding_never_reaches_socket():
    with (
        patch.object(proxy, "public_addresses", side_effect=proxy.UnsafeURL("private DNS")),
        patch.object(proxy.socket, "socket") as connect,
    ):
        try:
            proxy.connect_public("video.example", 443)
        except proxy.UnsafeURL:
            pass
        else:
            raise AssertionError("Private connection accepted")
        connect.assert_not_called()


@contextmanager
def running_proxy():
    """Real loopback proxy listener; outbound destinations are stubbed per test."""
    with proxy.Proxy(("127.0.0.1", 0), proxy.Handler) as server:
        thread = Thread(target=lambda: server.serve_forever(poll_interval=0.01), daemon=True)
        thread.start()
        try:
            yield server.server_address
        finally:
            server.shutdown()
            thread.join(timeout=2)


def exchange(address, payload):
    with socket.create_connection(address, timeout=2) as client:
        client.sendall(payload)
        data = bytearray()
        while chunk := client.recv(4096):
            data.extend(chunk)
            assert len(data) <= 16384
        return bytes(data)


@pytest.mark.parametrize(
    "failure,status,code",
    [
        (proxy.DNSResolutionError("private fixture detail"), b"502 Bad Gateway", b"DNS_RESOLUTION_FAILED"),
        (proxy.UnsafeURL("private fixture detail"), b"403 Forbidden", b"TARGET_REJECTED"),
        (ConnectionRefusedError("private fixture detail"), b"502 Bad Gateway", b"UPSTREAM_UNAVAILABLE"),
    ],
)
@pytest.mark.parametrize(
    "payload",
    [
        b"CONNECT video.example.com:443 HTTP/1.1\r\nHost: video.example.com:443\r\n\r\n",
        b"GET http://video.example.com/fixture.mp4 HTTP/1.1\r\nHost: video.example.com\r\n\r\n",
    ],
)
def test_proxy_reports_safe_dns_policy_and_connection_failures(failure, status, code, payload):
    with running_proxy() as address, patch.object(proxy, "connect_public", side_effect=failure):
        response = exchange(address, payload)
    assert response.startswith(b"HTTP/1.1 " + status + b"\r\n")
    assert b"X-VideoFlow-Egress-Error: " + code + b"\r\n" in response
    assert b"Cache-Control: no-store\r\n" in response
    assert b"Content-Length: 0\r\n" in response
    assert b"private fixture detail" not in response
    assert response.endswith(b"\r\n\r\n")


def test_mixed_public_private_dns_never_creates_an_outbound_socket():
    answers = [
        (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("8.8.8.8", 443)),
        (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("169.254.169.254", 443)),
    ]
    with (
        patch("app.security.socket.getaddrinfo", return_value=answers) as resolver,
        patch.object(proxy.socket, "socket") as outbound,
    ):
        with pytest.raises(proxy.UnsafeURL):
            proxy.connect_public("video.example.com", 443)
    resolver.assert_called_once_with("video.example.com", 443, type=socket.SOCK_STREAM)
    outbound.assert_not_called()


def test_established_connect_tunnel_failure_closes_without_plaintext_http_error():
    upstream = MagicMock()
    with (
        running_proxy() as address,
        patch.object(proxy, "connect_public", return_value=upstream) as connect,
        patch.object(proxy.select, "select", side_effect=OSError("private tunnel failure")),
    ):
        response = exchange(address, b"CONNECT video.example.com:443 HTTP/1.1\r\nHost: video.example.com:443\r\n\r\n")
    assert response == b"HTTP/1.1 200 Connection Established\r\n\r\n"
    connect.assert_called_once_with("video.example.com", 443)
    upstream.close.assert_called_once()
