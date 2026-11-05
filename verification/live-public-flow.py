"""Opt-in live public-media + private Storage verification; no permanent job rows.

Run only with configured backend env and guarded egress. Uses isolated in-memory
Redis and invokes real Celery task bodies synchronously; does not use the broker.
Outputs only safe assertions, never signed URLs, secrets or provider responses.
"""

import hashlib
import json
import sys
from datetime import datetime, timedelta, timezone
from tempfile import TemporaryDirectory
from unittest.mock import patch
from urllib.parse import parse_qs, unquote, urlsplit
from uuid import uuid4

import fakeredis
import httpx
from fastapi.testclient import TestClient

from app import main, tasks
from app.config import settings
from app.db import Database
from app.jobs import JobStore
from app.media_runtime import YT_DLP_VERSION

PUBLIC_MEDIA = (
    sys.argv[1]
    if len(sys.argv) > 1
    else "https://raw.githubusercontent.com/mediaelement/mediaelement-files/master/big_buck_bunny.mp4"
)
TITLE = "සිංහල Unicode Test / Original: Title"


def verify():
    config = settings()
    assert config.configured and config.media_proxy, (
        "Configured backend and guarded egress required"
    )
    redis = fakeredis.FakeRedis(decode_responses=True)
    store = JobStore(redis)
    database = Database()
    owner = {"id": str(uuid4()), "is_anonymous": True}
    staged = []
    original_upload = database.upload

    def upload(path, file):
        staged.append(path)
        original_upload(path, file)

    def analyze_now(args, **_kwargs):
        tasks.analyze.run(*args)

    def download_now(args, **_kwargs):
        tasks.download.run(*args)

    main.api_app.dependency_overrides[main.current_user] = lambda: owner
    try:
        with (
            TemporaryDirectory(prefix="support-check-") as temp,
            patch.object(config, "temp_root", temp),
            patch("app.main.cache", return_value=redis),
            patch("app.tasks.cache", return_value=redis),
            patch("app.guest.cache", return_value=redis),
            patch("app.db.cache", return_value=redis),
            patch("app.main.JobStore", return_value=store),
            patch("app.tasks.JobStore", return_value=store),
            patch("app.tasks.Database", return_value=database),
            patch.object(database, "upload", side_effect=upload),
            patch("app.main.analyze.apply_async", side_effect=analyze_now),
            patch("app.main.download.apply_async", side_effect=download_now) as prepare,
            TestClient(
                main.app, raise_server_exceptions=False, client=("127.0.0.1", 50001)
            ) as client,
        ):
            begun = client.post("/api/analyze", json={"url": PUBLIC_MEDIA})
            assert begun.status_code == 202, (
                f"Analysis request rejected: HTTP {begun.status_code}"
            )
            aid = begun.json()["analysis_id"]
            result = client.get(f"/api/analyze/{aid}").json()
            assert result["status"] == "completed", "Analysis failed: " + result.get(
                "error_code", "UNKNOWN"
            )
            assert result["extractor_version"] == YT_DLP_VERSION
            assert prepare.call_count == 0, "Paste created a job"
            print(
                "PASS public HTTPS analysis through guarded egress; no job before selection",
                flush=True,
            )
            key = f"analysis:{owner['id']}:{aid}"
            private = json.loads(redis.get(key))
            private["title"] = TITLE
            redis.setex(key, 900, json.dumps(private))
            choices = [
                next(
                    f
                    for f in result["formats"]
                    if f["kind"] == "video" and f["ext"] == "mp4" and f["has_audio"]
                ),
                next(f for f in result["formats"] if f["id"] == "audio-mp3"),
            ]
            for choice in choices:
                body = {
                    "analysis_id": aid,
                    "format_id": choice["id"],
                    "idempotency_key": str(uuid4()),
                }
                response = client.post("/api/downloads", json=body)
                assert response.status_code == 202, "Preparation request rejected"
                job_id = response.json()["id"]
                job = client.get(f"/api/downloads/{job_id}").json()
                assert job["status"] == "completed", "Preparation failed: " + job.get(
                    "error_code", "UNKNOWN"
                )
                duplicate = client.post("/api/downloads", json=body)
                assert duplicate.json()["id"] == job_id
                count = prepare.call_count
                previous_digest = None
                for _ in range(2):
                    file = client.get(f"/api/downloads/{job_id}/file")
                    assert file.status_code == 200, "File delivery rejected"
                    data = file.json()
                    assert data["filename"].startswith(
                        "youtubedown - සිංහල Unicode Test"
                    )
                    assert data["filename"].endswith("." + choice["ext"])
                    assert parse_qs(urlsplit(data["url"]).query)["download"] == [
                        data["filename"]
                    ]
                    # Stream the complete response through a bounded buffer;
                    # no database bytes or persistent file is created.
                    with httpx.Client(follow_redirects=True, timeout=60) as transport:
                        with transport.stream("GET", data["url"]) as final:
                            assert final.status_code == 200, "Storage download failed"
                            disposition = unquote(
                                final.headers.get("content-disposition", "")
                            )
                            assert "attachment" in disposition.lower(), (
                                "No attachment disposition"
                            )
                            assert data["filename"] in disposition, (
                                "Final attachment filename mismatch"
                            )
                            digest, received = hashlib.sha256(), 0
                            for chunk in final.iter_bytes(1024 * 1024):
                                received += len(chunk)
                                digest.update(chunk)
                            assert received == job["file_size"] and received > 0, (
                                "Incomplete download"
                            )
                            if previous_digest:
                                assert digest.hexdigest() == previous_digest, (
                                    "Save returned different file bytes"
                                )
                            previous_digest = digest.hexdigest()
                assert prepare.call_count == count, "Save fallback recreated the job"
                print(
                    f"PASS {choice['ext'].upper()} preparation, private attachment, Unicode filename, same-file Save, idempotency",
                    flush=True,
                )
                main.api_app.dependency_overrides[main.current_user] = lambda: {
                    "id": str(uuid4())
                }
                assert client.get(f"/api/downloads/{job_id}/file").status_code == 404
                main.api_app.dependency_overrides[main.current_user] = lambda: owner
                store.update_job(
                    job_id,
                    expires_at=(
                        datetime.now(timezone.utc) - timedelta(seconds=1)
                    ).isoformat(),
                )
                assert client.get(f"/api/downloads/{job_id}/file").status_code == 410
            print("PASS owner isolation and prepared-file expiry", flush=True)
    finally:
        main.api_app.dependency_overrides.clear()
        cleanup_failed = False
        for path in staged:
            try:
                database.remove_file(path)
                remaining = database.request(
                    "POST",
                    "/storage/v1/object/list/downloads",
                    json={
                        "prefix": "ephemeral",
                        "search": path.split("/", 1)[1],
                        "limit": 10,
                    },
                )
                assert not remaining, "Deleted test object remains in Storage"
            except Exception:
                cleanup_failed = True
        redis.flushall()
        if cleanup_failed:
            raise RuntimeError(
                "Temporary Storage cleanup failed; scheduler hard-expiry sweep remains available"
            )
    print(
        "PASS temporary Storage objects deleted and isolated state cleared", flush=True
    )


if __name__ == "__main__":
    try:
        verify()
    except Exception as exc:
        # Assertions contain only fixed safe descriptions and application codes.
        print(
            "FAIL "
            + (str(exc) if isinstance(exc, AssertionError) else type(exc).__name__),
            flush=True,
        )
        sys.exit(1)
