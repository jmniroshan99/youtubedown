from urllib.parse import urlsplit

from .db import Database


class UnsupportedProvider(ValueError):
    def __init__(self, message, code="ADAPTER_UNAVAILABLE"):
        super().__init__(message)
        self.code = code


def select_provider(url):
    host = urlsplit(url).hostname.lower().rstrip(".")
    providers = Database().rows("video_providers")
    matched = [p for p in providers if any(host == d or host.endswith("." + d) for d in p["domains"])]
    if matched:
        # Explicit subdomain rules take priority over broader parent domains.
        provider = max(matched, key=lambda p: max(len(d) for d in p["domains"] if host == d or host.endswith("." + d)))
        if not provider["enabled"]:
            raise UnsupportedProvider("This source has been disabled.", "SOURCE_DISABLED")
        if provider["adapter_key"] not in {"yt_dlp", "generic", "direct"}:
            raise UnsupportedProvider("This source requires a deployed adapter.")
        return provider
    return {"id": None, "name": "Automatic detection", "adapter_key": "yt_dlp"}
