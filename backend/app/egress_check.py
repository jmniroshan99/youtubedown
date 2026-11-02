"""Credential-free worker-to-egress diagnostic. No video/page is downloaded."""

import http.client
from urllib.parse import urlsplit

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


if __name__ == "__main__":
    raise SystemExit(0 if check(settings().media_proxy) else 1)
