"""Credential-free worker-to-egress diagnostic. No video/page is downloaded."""

import argparse
import http.client
import ssl
from urllib.parse import urlsplit

import certifi

from .config import settings


def tunnel_status(proxy_url, target, connection_factory=http.client.HTTPConnection):
    try:
        parsed = urlsplit(proxy_url)
        port = parsed.port or 80
    except ValueError:
        return "PROXY_CONFIGURATION"
    if parsed.scheme != "http" or not parsed.hostname or parsed.username or parsed.password:
        return "PROXY_CONFIGURATION"
    connection = None
    try:
        connection = connection_factory(parsed.hostname, port, timeout=10)
        connection.request("CONNECT", target, headers={"Host": target})
        response = connection.getresponse()
        if response.status == 200:
            return "CONNECTED"
        code = response.getheader("X-VideoFlow-Egress-Error")
        if response.status == 403 and code == "TARGET_REJECTED":
            return "TARGET_REJECTED"
        if response.status == 502 and code == "DNS_RESOLUTION_FAILED":
            return "DNS_RESOLUTION_FAILED"
        return "UPSTREAM_UNAVAILABLE"
    except TimeoutError:
        return "CONNECTION_TIMEOUT"
    except (OSError, http.client.HTTPException, ValueError):
        return "PROXY_UNREACHABLE"
    finally:
        if connection is not None:
            connection.close()


def check(proxy_url):
    # Fixed targets only. Never accept a user URL or expose a resolver endpoint.
    results = [
        ("Source-host DNS and TCP through egress", tunnel_status(proxy_url, "www.youtube.com:443"), "CONNECTED"),
        ("Private metadata target rejected", tunnel_status(proxy_url, "169.254.169.254:443"), "TARGET_REJECTED"),
    ]
    for label, status, expected in results:
        print(f"{'PASS' if status == expected else 'FAIL'}: {label} ({status}).")
    return all(status == expected for _, status, expected in results)


def tls_status(proxy_url, host, connection_factory=http.client.HTTPSConnection):
    """Verified HEAD through CONNECT. No page/video body or raw diagnostics leave this check."""
    connection = None
    try:
        proxy = urlsplit(proxy_url)
        port = proxy.port or 80
        if proxy.scheme != "http" or not proxy.hostname or proxy.username or proxy.password:
            return "PROXY_CONFIGURATION"
        # Match yt-dlp's pinned CA bundle. Do not trust an intercepted leaf or
        # disable verification to turn a certificate failure into apparent success.
        context = ssl.create_default_context(cafile=certifi.where())
        connection = connection_factory(proxy.hostname, port, timeout=12, context=context)
        connection.set_tunnel(host, 443)
        connection.request("HEAD", "/", headers={"Host": host, "Connection": "close"})
        response = connection.getresponse()
        if response.status == 401:
            return "LOGIN_REQUIRED"
        if response.status == 403:
            return "SOURCE_BLOCKED"
        if response.status == 429:
            return "SOURCE_RATE_LIMITED"
        if response.status >= 500:
            return "SOURCE_UNAVAILABLE"
        return "HTTPS_REACHABLE"
    except ssl.SSLCertVerificationError:
        return "SOURCE_TLS_ERROR"
    except ssl.SSLError:
        return "TLS_HANDSHAKE_ERROR"
    except TimeoutError:
        return "CONNECTION_TIMEOUT"
    except ValueError:
        return "PROXY_CONFIGURATION"
    except (OSError, http.client.HTTPException):
        return "SOURCE_NETWORK_ERROR"
    finally:
        if connection is not None:
            connection.close()


def check_tls(proxy_url):
    results = [
        ("Control HTTPS certificate and response", tls_status(proxy_url, "www.youtube.com")),
        ("xHamster HTTPS certificate and response", tls_status(proxy_url, "xhamster.com")),
        ("Pornhub HTTPS certificate and response", tls_status(proxy_url, "www.pornhub.com")),
    ]
    for label, status in results:
        print(f"{'PASS' if status == 'HTTPS_REACHABLE' else 'FAIL'}: {label} ({status}).")
    return all(status == "HTTPS_REACHABLE" for _, status in results)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tls", action="store_true", help="Also verify fixed source HTTPS HEAD connections")
    arguments = parser.parse_args()
    healthy = check(settings().media_proxy)
    if arguments.tls:
        healthy = check_tls(settings().media_proxy) and healthy
    raise SystemExit(0 if healthy else 1)
