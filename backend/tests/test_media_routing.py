"""Regression coverage for media work in containers without public DNS access.

The application validates URL syntax; the guarded egress proxy remains responsible
for resolving and checking every destination it connects to.
"""

import json
import socket
from unittest.mock import patch
from uuid import uuid4

import fakeredis
import httpx
import pytest
from fastapi.testclient import TestClient

from app import main, tasks
from app.config import Settings

OWNER = {"id": str(uuid4()), "is_anonymous": True, "app_metadata": {}}
URL = "https://video.example.com/watch?v=fixture"
PROXY = "http://egress:8080"


@pytest.fixture
def client():
    main.api_app.dependency_overrides[main.current_user] = lambda: OWNER
    try:
        with TestClient(main.app, raise_server_exceptions=False) as client:
            yield client
    finally:
        main.api_app.dependency_overrides.clear()


@pytest.fixture
def unavailable_public_dns():
    with patch("socket.getaddrinfo", side_effect=socket.gaierror("fixture: no public DNS here")) as resolver:
        yield resolver
        resolver.assert_not_called()


def test_analysis_queues_without_external_dns_in_api(client, unavailable_public_dns):
    redis = fakeredis.FakeRedis(decode_responses=True)
    with (
        patch("app.main.cache", return_value=redis),
        patch("app.main.guest_rate"),
        patch("app.main.rate"),
        patch("app.main.analyze") as queued,
    ):
        response = client.post("/api/analyze", json={"url": URL + "#player"})
    assert response.status_code == 202
    analysis_id = response.json()["analysis_id"]
    assert queued.apply_async.call_args.kwargs["args"] == [OWNER["id"], analysis_id]
    request = json.loads(redis.get(f"analysis_request:{OWNER['id']}:{analysis_id}"))
    assert request["url"] == URL
    assert request["policy"]["guest"] is True
    assert queued.apply_async.call_args.kwargs["expires"] == 180
    assert json.loads(redis.get(f"analysis:{OWNER['id']}:{analysis_id}")) == {"status": "queued"}


def test_admin_provider_test_queues_without_external_dns_in_api(client, unavailable_public_dns):
    administrator = {**OWNER, "is_anonymous": False, "app_metadata": {"role": "admin"}}
    main.api_app.dependency_overrides[main.current_user] = lambda: administrator
    provider_id = uuid4()
    provider = {"id": str(provider_id), "domains": ["example.com"], "adapter_key": "yt_dlp"}
    with (
        patch("app.main.Database") as database,
        patch("app.main.cache", return_value=fakeredis.FakeRedis(decode_responses=True)) as cache,
        patch("app.main.rate"),
        patch("app.main.analyze") as queued,
    ):
        database.return_value.rows.return_value = [provider]
        response = client.post(f"/api/providers/{provider_id}/test", json={"url": URL})
    assert response.status_code == 202
    analysis_id = response.json()["analysis_id"]
    assert queued.apply_async.call_args.kwargs["args"] == [administrator["id"], analysis_id]
    request = json.loads(cache().get(f"analysis_request:{administrator['id']}:{analysis_id}"))
    assert request["url"] == URL
    assert request["provider_test"] == provider


def test_thumbnail_uses_explicit_guarded_proxy_without_external_dns_in_api(client, unavailable_public_dns):
    analysis_id = uuid4()
    thumbnail = "https://images.example.com/fixture.jpg"
    with (
        patch("app.main.cache") as redis,
        patch("app.main.settings", return_value=Settings(media_proxy=PROXY)),
        patch("app.main.httpx.Client") as outbound,
    ):
        redis.return_value.get.return_value = json.dumps({"thumbnail": thumbnail})
        stream = outbound.return_value.__enter__.return_value.stream
        stream.return_value.__enter__.return_value = httpx.Response(
            200, headers={"content-type": "image/jpeg"}, content=b"fixture-image"
        )
        response = client.get(f"/api/analyze/{analysis_id}/thumbnail")
    assert response.status_code == 200
    assert response.content == b"fixture-image"
    assert outbound.call_args.kwargs["proxy"] == PROXY
    assert outbound.call_args.kwargs["trust_env"] is False
    assert outbound.call_args.kwargs["follow_redirects"] is True
    assert outbound.call_args.kwargs["max_redirects"] == 5
    stream.assert_called_once_with("GET", thumbnail)


def test_thumbnail_fails_closed_if_guarded_proxy_is_not_configured(client, unavailable_public_dns):
    with (
        patch("app.main.cache") as redis,
        patch("app.main.settings", return_value=Settings(media_proxy="")),
        patch("app.main.httpx.Client") as outbound,
    ):
        redis.return_value.get.return_value = json.dumps({"thumbnail": "https://images.example.com/fixture.jpg"})
        response = client.get(f"/api/analyze/{uuid4()}/thumbnail")
    assert response.status_code == 503
    outbound.assert_not_called()


def test_worker_analysis_reaches_guarded_media_process_without_external_dns(unavailable_public_dns):
    analysis_id = str(uuid4())
    redis = fakeredis.FakeRedis(decode_responses=True)
    with (
        patch("app.tasks.cache", return_value=redis),
        patch("app.tasks.select_provider", return_value={"id": None, "adapter_key": "yt_dlp"}),
        patch("app.tasks.run_media", return_value={"title": "Fixture", "formats": []}) as media,
    ):
        tasks.analyze.run(OWNER["id"], analysis_id, URL)
    assert media.call_args.args[0]["url"] == URL
    assert media.call_args.args[0]["mode"] == "analyze"
    result = json.loads(redis.get(f"analysis:{OWNER['id']}:{analysis_id}"))
    assert result["status"] == "completed"
    assert result["analysis_id"] == analysis_id


def test_worker_download_reaches_guarded_media_process_without_external_dns(unavailable_public_dns):
    job_id = str(uuid4())
    job = {"id": job_id, "user_id": OWNER["id"], "status": "queued", "source_url": URL, "format_spec": {}}
    with (
        patch("app.tasks.JobStore") as store,
        patch("app.tasks.Database"),
        patch("app.tasks.cache") as redis,
        patch("app.tasks.select_provider", return_value={"id": None, "adapter_key": "yt_dlp"}),
        patch("app.tasks.run_media", side_effect=tasks.MediaFailure("EXTRACTION_FAILED")) as media,
    ):
        store.return_value.job.return_value = job
        redis.return_value.lock.return_value.acquire.return_value = True
        tasks.download.run(job_id)
    assert media.call_args.args[0]["url"] == URL
    assert media.call_args.args[0]["mode"] == "download"
    assert media.call_args.args[0]["format"] == job["format_spec"]
    store.return_value.update_job.assert_any_call(
        job_id, status="failed", error_code="EXTRACTION_FAILED", error_stage="downloading", progress=None
    )
    redis.return_value.lock.return_value.release.assert_called_once()
