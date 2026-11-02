import ipaddress
import socket
from urllib.parse import urlsplit, urlunsplit


class UnsafeURL(ValueError):
    pass


class DNSResolutionError(UnsafeURL):
    pass


def require_public_address(address):
    ip = ipaddress.ip_address(address)
    mapped = getattr(ip, "ipv4_mapped", None)
    if (
        not ip.is_global
        or ip.is_multicast
        or ip.is_unspecified
        or (mapped and (not mapped.is_global or mapped.is_multicast))
    ):
        raise UnsafeURL("Only public internet addresses are allowed.")
    if ip.version == 6 and (ip.sixtofour or ip.teredo):
        raise UnsafeURL("IPv6 transition addresses are not allowed.")


def public_addresses(host, port):
    try:
        addresses = list({item[4][0] for item in socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)})
    except socket.gaierror as exc:
        raise DNSResolutionError("Host could not be resolved.") from exc
    if not addresses:
        raise DNSResolutionError("Host could not be resolved.")
    for address in addresses:
        require_public_address(address)
    return addresses


def validate_url(url: str, resolve=True):
    if len(url) > 4096 or any(ord(c) < 32 or ord(c) == 127 for c in url):
        raise UnsafeURL("Invalid URL.")
    try:
        parts = urlsplit(url.strip())
        port = parts.port
        host = parts.hostname
    except ValueError as exc:
        raise UnsafeURL("Invalid URL.") from exc
    if parts.scheme not in {"http", "https"} or not host or parts.username or parts.password:
        raise UnsafeURL("Use a public HTTP or HTTPS URL without credentials.")
    expected = 443 if parts.scheme == "https" else 80
    if port is not None and port != expected:
        raise UnsafeURL("Only standard web ports are allowed.")
    canonical_host = host.rstrip(".").lower()
    if canonical_host in {"localhost", "localhost.localdomain"} or canonical_host.endswith(".localhost") or "%" in host:
        raise UnsafeURL("Local addresses are not allowed.")
    # Literal addresses need no DNS. Reject private targets before queueing even
    # when destination DNS is deferred to the guarded egress proxy.
    try:
        literal = ipaddress.ip_address(canonical_host)
    except ValueError:
        literal = None
    if literal is not None:
        require_public_address(literal)
    if resolve:
        public_addresses(host, expected)
    return urlunsplit((parts.scheme, parts.netloc, parts.path or "/", parts.query, ""))


def validate_media_url(url: str):
    """Validate syntax/literals locally; egress validates and pins destination DNS.

    Application containers have internal-only networks, so external DNS must
    happen where the outbound socket is opened. Every consumer of this helper
    must use the mandatory guarded proxy; this helper alone is not an SSRF gate.
    """
    return validate_url(url, resolve=False)
