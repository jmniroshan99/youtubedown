"""Server-owned guest policy and atomic, privacy-conscious abuse budgets."""

import hashlib
import hmac
import ipaddress
import time

from fastapi import HTTPException, Request

from .config import settings
from .queue import cache

# Check every budget before incrementing any: simultaneous API instances cannot overspend.
RATE_SCRIPT = """
for i,key in ipairs(KEYS) do
  if tonumber(redis.call('GET',key) or '0') >= tonumber(ARGV[(i-1)*2+1]) then
    return {0, math.max(1,redis.call('TTL',key))}
  end
end
for i,key in ipairs(KEYS) do
  local n=redis.call('INCR',key)
  if n==1 then redis.call('EXPIRE',key,tonumber(ARGV[(i-1)*2+2])) end
end
return {1,0}
"""


def media_policy(guest=False, stored=None):
    config = settings()
    stored = stored or {}
    is_guest = guest or stored.get("guest") is True
    return {
        "guest": is_guest,
        "max_bytes": min(
            config.max_file_size_mb * 1024 * 1024,
            config.guest_max_file_size_mb * 1024 * 1024 if is_guest else config.max_file_size_mb * 1024 * 1024,
            stored.get("max_bytes", config.max_file_size_mb * 1024 * 1024),
        ),
        "max_duration": min(
            config.max_video_duration_seconds,
            config.guest_max_video_duration_seconds if is_guest else config.max_video_duration_seconds,
            stored.get("max_duration", config.max_video_duration_seconds),
        ),
        "retention_seconds": min(
            config.file_retention_hours * 3600,
            config.guest_file_retention_minutes * 60 if is_guest else config.file_retention_hours * 3600,
            stored.get("retention_seconds", config.file_retention_hours * 3600),
        ),
    }


def network_identity(request: Request):
    """Use the actual peer unless an explicitly trusted proxy forwarded the chain."""
    config = settings()
    trusted = [ipaddress.ip_network(item.strip()) for item in config.trusted_proxy_cidrs.split(",") if item.strip()]
    try:
        peer = ipaddress.ip_address(request.client.host)
        if any(peer in net for net in trusted):
            forwarded = request.headers.get("x-forwarded-for", "")
            if not forwarded or len(forwarded) > 2048:
                raise ValueError("Missing proxy client address")
            # Walk right to left; the first untrusted hop is the client boundary.
            chain = [ipaddress.ip_address(part.strip()) for part in forwarded.split(",")]
            for address in reversed(chain):
                peer = address
                if not any(peer in net for net in trusted):
                    break
        if isinstance(peer, ipaddress.IPv6Address) and peer.ipv4_mapped:
            peer = peer.ipv4_mapped
        address = str(ipaddress.ip_network(f"{peer}/64", strict=False)) if peer.version == 6 else str(peer)
    except (ValueError, AttributeError):
        raise HTTPException(
            503, detail={"code": "PROXY_CONFIGURATION", "message": "Guest access is temporarily unavailable."}
        ) from None
    # Raw IP addresses never enter Redis keys. The server secret is not exposed to clients.
    secret = config.guest_rate_limit_secret or config.supabase_secret_key
    if not secret:
        raise HTTPException(503, detail={"code": "NOT_CONFIGURED", "message": "Guest limits are not configured."})
    return hmac.new(secret.encode(), address.encode(), hashlib.sha256).hexdigest()


def guest_rate(user, request, action):
    if not user.get("is_anonymous"):
        return
    config = settings()
    network = network_identity(request)
    now = int(time.time())
    if action == "analyze":
        budgets = [
            (f"user:{user['id']}", 60, config.guest_analysis_per_minute),
            (f"user:{user['id']}", 86400, config.guest_analysis_per_day),
            (f"network:{network}", 60, config.guest_network_analysis_per_minute),
            (f"network:{network}", 86400, config.guest_network_analysis_per_day),
        ]
    else:
        budgets = [
            (f"network:{network}", 60, config.guest_network_creates_per_minute),
            (f"network:{network}", 86400, config.guest_network_creates_per_day),
        ]
    keys, args = [], []
    for identity, window, limit in budgets:
        keys.append(f"guest:{action}:{identity}:{window}:{now // window}")
        args.extend([limit, window - now % window])
    allowed, retry = cache().eval(RATE_SCRIPT, len(keys), *keys, *args)
    if not allowed:
        raise HTTPException(
            429,
            detail={"code": "GUEST_RATE_LIMIT", "message": "Guest usage limit reached. Please try again later."},
            headers={"Retry-After": str(retry)},
        )
