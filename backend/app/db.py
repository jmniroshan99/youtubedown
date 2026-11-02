from urllib.parse import parse_qsl, quote, urlencode, urlsplit, urlunsplit

import httpx

from .config import settings
from .filenames import temporary_path_expiry
from .queue import cache


class Database:
    def __init__(self):
        config = settings()
        self.base = config.supabase_url.rstrip("/")
        self.headers = {"apikey": config.supabase_secret_key}

    def request(self, method, path, **kwargs):
        headers = {**self.headers, **kwargs.pop("headers", {})}
        timeout = kwargs.pop("timeout", 45)
        with httpx.Client(timeout=timeout) as client:
            response = client.request(method, self.base + path, headers=headers, **kwargs)
        response.raise_for_status()
        return response.json() if response.content else None

    def rows(self, table, *, timeout=45, **params):
        return self.request("GET", "/rest/v1/" + table, params=params, timeout=timeout)

    def insert(self, table, data):
        return self.request("POST", "/rest/v1/" + table, json=data, headers={"Prefer": "return=representation"})

    def patch(self, table, filters, data):
        return self.request(
            "PATCH", "/rest/v1/" + table, params=filters, json=data, headers={"Prefer": "return=representation"}
        )

    def upload(self, path, file):
        length = file.stat().st_size

        def chunks():
            with file.open("rb") as stream:
                while chunk := stream.read(1024 * 1024):
                    yield chunk

        with httpx.Client(timeout=httpx.Timeout(600, connect=20)) as client:
            response = client.post(
                self.base + "/storage/v1/object/downloads/" + quote(path, safe="/"),
                headers={
                    **self.headers,
                    "Content-Type": "application/octet-stream",
                    "Content-Length": str(length),
                    "x-upsert": "false",
                },
                content=chunks(),
            )
        response.raise_for_status()

    def remove_file(self, path):
        if path:
            self.request("DELETE", "/storage/v1/object/downloads", json={"prefixes": [path]})

    def signed_url(self, path, filename=None):
        result = self.request(
            "POST",
            "/storage/v1/object/sign/downloads/" + quote(path, safe="/"),
            json={"expiresIn": settings().signed_url_ttl_seconds},
        )
        url = result.get("signedURL") or result.get("signedUrl")
        if not url:
            raise RuntimeError("Storage did not return a URL.")
        url = self.base + "/storage/v1" + url if url.startswith("/") else url
        if filename:
            parsed = urlsplit(url)
            params = [(key, value) for key, value in parse_qsl(parsed.query) if key != "download"]
            params.append(("download", filename))
            url = urlunsplit(parsed._replace(query=urlencode(params)))
        return url

    def temporary_files(self, before_epoch, limit=100):
        # Flat, dedicated namespace only. A hard expiry in each opaque object name
        # makes orphan cleanup independent of Redis state or job JSON TTLs.
        redis = cache()
        page_size = max(1, min(limit, 100))
        offset = max(0, int(redis.get("yd:storage-sweep-offset") or 0))
        objects = (
            self.request(
                "POST",
                "/storage/v1/object/list/downloads",
                json={
                    "prefix": "ephemeral",
                    "limit": page_size,
                    "offset": offset,
                    "sortBy": {"column": "created_at", "order": "asc"},
                },
            )
            or []
        )
        # Advance across noneligible/malformed entries too; deletions may shift
        # offsets but the bounded sweep wraps and catches skipped items next pass.
        redis.set("yd:storage-sweep-offset", offset + len(objects) if len(objects) == page_size else 0, ex=86400)
        paths = []
        for item in objects:
            path = "ephemeral/" + str(item.get("name", ""))
            expiry = temporary_path_expiry(path)
            if expiry is not None and expiry <= before_epoch:
                paths.append(path)
        return paths
