from urllib.parse import urlsplit

from .db import Database


class UnsupportedProvider(ValueError):
    def __init__(self, message, code="ADAPTER_UNAVAILABLE"):
        super().__init__(message)
        self.code = code


def matching_provider(url, providers):
    host = urlsplit(url).hostname.lower().rstrip(".")
    matched = [p for p in providers if any(host == d or host.endswith("." + d) for d in p["domains"])]
    return (
        max(matched, key=lambda p: max(len(d) for d in p["domains"] if host == d or host.endswith("." + d)))
        if matched
        else None
    )


def select_provider(url):
    providers = Database().rows("video_providers")
    provider = matching_provider(url, providers)
    rules = [{"domains": p["domains"], "enabled": p["enabled"]} for p in providers]
    if provider:
        # Explicit subdomain rules take priority over broader parent domains.
        if not provider["enabled"]:
            raise UnsupportedProvider("This source has been disabled.", "SOURCE_DISABLED")
        if provider["adapter_key"] not in {"yt_dlp", "generic", "direct"}:
            raise UnsupportedProvider("This source requires a deployed adapter.")
        return {**provider, "_source_rules": rules}
    return {"id": None, "name": "Automatic detection", "adapter_key": "yt_dlp", "_source_rules": rules}
