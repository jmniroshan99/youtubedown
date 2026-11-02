import socket
from unittest.mock import patch

import pytest

from app.security import DNSResolutionError, UnsafeURL, public_addresses, validate_media_url, validate_url


@pytest.mark.parametrize(
    "url",
    [
        "file:///etc/passwd",
        "ftp://example.com/video",
        "https://user:pass@example.com/",
        "http://localhost/",
        "https://example.com:8080/",
        "http://example.com/\r\nHost: localhost",
        "http://[fe80::1%25eth0]/",
        "http://example.com:bad/",
    ],
)
def test_invalid_url(url):
    with pytest.raises(UnsafeURL):
        validate_url(url, resolve=False)


@pytest.mark.parametrize(
    "ip",
    [
        "224.0.0.1",
        "ff02::1",
        "127.0.0.1",
        "10.0.0.2",
        "192.168.1.1",
        "169.254.169.254",
        "100.64.0.1",
        "::1",
        "::ffff:127.0.0.1",
        "2002:7f00:1::",
    ],
)
def test_private_dns_answers(ip):
    with patch("socket.getaddrinfo", return_value=[(socket.AF_INET, socket.SOCK_STREAM, 6, "", (ip, 443))]):
        with pytest.raises(UnsafeURL):
            public_addresses("video.test", 443)


def test_mixed_dns_answers_fail_closed():
    answers = [(2, 1, 6, "", ("8.8.8.8", 443)), (2, 1, 6, "", ("127.0.0.1", 443))]
    with patch("socket.getaddrinfo", return_value=answers):
        with pytest.raises(UnsafeURL):
            validate_url("https://video.example/")


def test_fragment_removed_and_query_preserved():
    with patch("app.security.public_addresses", return_value=["8.8.8.8"]):
        assert validate_url("https://example.com/v?token=abc#fragment") == "https://example.com/v?token=abc"


@pytest.mark.parametrize(
    "url",
    [
        "https://127.0.0.1/",
        "https://169.254.169.254/",
        "http://10.0.0.2/",
        "https://[::1]/",
        "https://[::ffff:127.0.0.1]/",
        "https://[2002:7f00:1::]/",
        "http://subdomain.localhost/",
    ],
)
def test_media_precheck_rejects_private_literals_without_dns(url):
    with patch("socket.getaddrinfo") as resolver:
        with pytest.raises(UnsafeURL):
            validate_media_url(url)
        resolver.assert_not_called()


def test_dns_failure_is_distinct_from_target_rejection():
    with patch("socket.getaddrinfo", side_effect=socket.gaierror("private resolver details")):
        with pytest.raises(DNSResolutionError, match="^Host could not be resolved\\.$"):
            public_addresses("video.example", 443)
