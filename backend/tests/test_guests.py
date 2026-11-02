import json
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock, patch
from uuid import uuid4

import fakeredis
import httpx
import pytest
from fastapi import HTTPException, Request
from fastapi.security import HTTPAuthorizationCredentials
from fastapi.testclient import TestClient

from app.config import Settings
from app.guest import guest_rate, media_policy, network_identity
from app.main import admin, api_app, app, current_user, reserve
from app.tasks import cleanup

GUEST = {"id": str(uuid4()), "is_anonymous": True, "app_metadata": {}}
SECRET = "sb_secret_test_only_not_a_real_key"


def request(peer="203.0.113.10", forwarded=None):
    return Request(
        {
            "type": "http",
            "client": (peer, 1000),
            "headers": [(b"x-forwarded-for", forwarded.encode())] if forwarded else [],
        }
    )


def test_verified_anonymous_user_is_allowed():
    response = httpx.Response(200, json=GUEST)
    with (
        patch("app.main.settings", return_value=Settings(supabase_secret_key=SECRET)),
        patch("app.main.httpx.Client") as client,
    ):
        client.return_value.__enter__.return_value.get.return_value = response
        assert current_user(HTTPAuthorizationCredentials(scheme="Bearer", credentials="test-token")) == GUEST
        assert (
            client.return_value.__enter__.return_value.get.call_args.kwargs["headers"]["Authorization"]
            == "Bearer test-token"
        )


@pytest.mark.parametrize("status,expected", [(401, 401), (403, 401), (429, 503), (503, 503)])
def test_unverified_or_unavailable_auth_fails_closed(status, expected):
    with (
        patch("app.main.settings", return_value=Settings(supabase_secret_key=SECRET)),
        patch("app.main.httpx.Client") as client,
    ):
        client.return_value.__enter__.return_value.get.return_value = httpx.Response(status)
        with pytest.raises(HTTPException) as exc:
            current_user(HTTPAuthorizationCredentials(scheme="Bearer", credentials="invalid"))
        assert exc.value.status_code == expected


def test_guest_cannot_admin_even_with_app_role():
    with pytest.raises(HTTPException) as exc:
        admin({**GUEST, "app_metadata": {"role": "admin"}})
    assert exc.value.status_code == 403


def test_guest_can_be_disabled_without_blocking_permanent_accounts():
    config = Settings(supabase_secret_key=SECRET, guest_access_enabled=False)
    with patch("app.main.settings", return_value=config), patch("app.main.httpx.Client") as client:
        get = client.return_value.__enter__.return_value.get
        get.return_value = httpx.Response(200, json=GUEST)
        with pytest.raises(HTTPException) as exc:
            current_user(HTTPAuthorizationCredentials(scheme="Bearer", credentials="test"))
        assert exc.value.status_code == 403
        get.return_value = httpx.Response(200, json={**GUEST, "is_anonymous": False})
        assert current_user(HTTPAuthorizationCredentials(scheme="Bearer", credentials="test"))["id"] == GUEST["id"]


def test_network_header_is_ignored_unless_peer_is_trusted():
    with patch("app.guest.settings", return_value=Settings(supabase_secret_key=SECRET)):
        real = network_identity(request())
        assert network_identity(request(forwarded="198.51.100.99")) == real
        assert "203.0.113" not in real
    config = Settings(supabase_secret_key=SECRET, trusted_proxy_cidrs="10.1.0.2/32")
    with patch("app.guest.settings", return_value=config):
        assert network_identity(request("10.1.0.2", "198.51.100.99,203.0.113.10")) == real
        with pytest.raises(HTTPException):
            network_identity(request("10.1.0.2", "not-an-ip"))
        with pytest.raises(HTTPException):
            network_identity(request("10.1.0.2"))


def test_ipv6_addresses_in_one_prefix_share_budget():
    with patch("app.guest.settings", return_value=Settings(supabase_secret_key=SECRET)):
        assert network_identity(request("2001:db8:42::1")) == network_identity(request("2001:db8:42::ffff"))
        assert network_identity(request("2001:db8:42::1")) != network_identity(request("2001:db8:43::1"))


def test_atomic_budget_across_clients_and_new_identities():
    server = fakeredis.FakeServer()
    clients = [fakeredis.FakeRedis(server=server, decode_responses=True) for _ in range(12)]
    config = Settings(supabase_secret_key=SECRET, guest_network_analysis_per_minute=3)

    def attempt(index):
        try:
            guest_rate({**GUEST, "id": str(uuid4())}, request(), "analyze")
            return True
        except HTTPException as exc:
            assert exc.status_code == 429
            assert 1 <= int(exc.headers["Retry-After"]) <= 60
            return False

    # Same Lua script with shared FakeRedis state and Lua runtime; not a live Redis deployment.
    with (
        patch("app.guest.settings", return_value=config),
        patch("app.guest.cache", side_effect=lambda: fakeredis.FakeRedis(server=server, decode_responses=True)),
    ):
        with ThreadPoolExecutor(max_workers=12) as pool:
            assert sum(pool.map(attempt, range(12))) == 3
    assert all(clients[0].ttl(key) > 0 for key in clients[0].keys())
    assert not any("203.0.113" in key for key in clients[0].keys())


def test_rejected_budget_does_not_increment_other_counters():
    redis = fakeredis.FakeRedis(decode_responses=True)
    config = Settings(supabase_secret_key=SECRET, guest_analysis_per_minute=1)
    with patch("app.guest.settings", return_value=config), patch("app.guest.cache", return_value=redis):
        guest_rate(GUEST, request(), "analyze")
        before = {key: redis.get(key) for key in redis.keys()}
        with pytest.raises(HTTPException):
            guest_rate(GUEST, request(), "analyze")
        assert {key: redis.get(key) for key in redis.keys()} == before


def test_guest_network_creation_quota_survives_new_identity():
    redis = fakeredis.FakeRedis(decode_responses=True)
    config = Settings(supabase_secret_key=SECRET, guest_network_creates_per_day=1)
    with patch("app.guest.settings", return_value=config), patch("app.guest.cache", return_value=redis):
        guest_rate(GUEST, request(), "create")
        with pytest.raises(HTTPException):
            guest_rate({**GUEST, "id": str(uuid4())}, request(), "create")


def test_guest_policy_reaches_atomic_redis_reservation():
    with patch("app.main.JobStore") as store, patch("app.main.download"):
        store.return_value.reserve.return_value = ({"id": str(uuid4()), "status": "queued"}, True)
        reserve(GUEST, "https://example.com/v", "Fixture", "Test", {"label": "mp4"}, uuid4())
        payload = store.return_value.reserve.call_args.kwargs
        assert (payload["max_active"], payload["daily_limit"]) == (1, 5)
        assert payload["spec"]["_policy"]["max_bytes"] == 100 * 1024 * 1024
        assert payload["spec"]["_policy"]["max_duration"] == 900
        assert payload["spec"]["_policy"]["retention_seconds"] == 1800


def test_stored_policy_cannot_be_relaxed_on_retry_or_by_configuration():
    initial = media_policy(True)
    assert media_policy(False, initial) == initial
    with patch("app.guest.settings", return_value=Settings(guest_max_file_size_mb=10)):
        assert media_policy(False, initial)["max_bytes"] == 10 * 1024 * 1024


@pytest.fixture
def guest_client():
    api_app.dependency_overrides[current_user] = lambda: GUEST
    with TestClient(app, raise_server_exceptions=False) as client:
        yield client
    api_app.dependency_overrides.clear()


def test_guest_analysis_enqueue_and_owned_result(guest_client):
    redis = fakeredis.FakeRedis(decode_responses=True)
    with (
        patch("app.main.cache", return_value=redis),
        patch("app.main.rate"),
        patch("app.main.guest_rate"),
        patch("app.main.validate_url", side_effect=lambda x: x),
        patch("app.main.analyze") as analyze,
    ):
        response = guest_client.post("/api/analyze", json={"url": "https://example.com/v"})
        assert response.status_code == 202
        aid = response.json()["analysis_id"]
        assert analyze.apply_async.call_args.kwargs["args"] == [GUEST["id"], aid]
        assert json.loads(redis.get(f"analysis_request:{GUEST['id']}:{aid}"))["policy"]["guest"] is True
        assert guest_client.get(f"/api/analyze/{aid}").json()["status"] == "queued"
        api_app.dependency_overrides[current_user] = lambda: {**GUEST, "id": str(uuid4())}
        assert guest_client.get(f"/api/analyze/{aid}").status_code == 404


@pytest.mark.parametrize(
    "suffix,method", [("", "get"), ("/file", "get"), ("/cancel", "post"), ("/retry", "post"), ("", "delete")]
)
def test_guest_job_isolation(guest_client, suffix, method):
    with patch("app.main.JobStore.job", return_value=None):
        kwargs = {"json": {"idempotency_key": str(uuid4())}} if suffix == "/retry" else {}
        assert getattr(guest_client, method)(f"/api/downloads/{uuid4()}{suffix}", **kwargs).status_code == 404


def test_guest_can_cancel_and_get_own_signed_link(guest_client):
    import time

    jid = str(uuid4())
    job = {"id": jid, "user_id": GUEST["id"], "status": "queued"}
    with patch("app.main.JobStore") as store:
        store.return_value.job.return_value = job
        store.return_value.cancel.return_value = {**job, "status": "cancelled"}
        assert guest_client.post(f"/api/downloads/{jid}/cancel").json()["status"] == "cancelled"
        store.return_value.cancel.assert_called_once_with(jid)
    job.update(
        status="completed",
        title="Fixture",
        output_extension=".mp4",
        storage_path=f"ephemeral/{GUEST['id']}__{jid}__{int(time.time()) + 10000}.mp4",
        expires_at=(datetime.now(timezone.utc) + timedelta(minutes=5)).isoformat(),
    )
    with patch("app.main.JobStore") as store, patch("app.main.Database") as db, patch("app.main.cache"):
        store.return_value.job.return_value = job
        db.return_value.signed_url.return_value = "https://storage.example.test/private-signed-link"
        result = guest_client.get(f"/api/downloads/{jid}/file")
        assert result.status_code == 200
        assert result.json()["url"].startswith("https://storage.")
        assert result.json()["filename"] == "youtubedown - Fixture.mp4"
        assert result.headers["cache-control"] == "private, no-store"


def test_retry_after_header_survives_error_handler(guest_client):
    with patch(
        "app.main.guest_rate",
        side_effect=HTTPException(
            429, detail={"code": "GUEST_RATE_LIMIT", "message": "Wait"}, headers={"Retry-After": "17"}
        ),
    ):
        result = guest_client.post("/api/analyze", json={"url": "https://example.com/v"})
        assert result.status_code == 429
        assert result.headers["retry-after"] == "17"


@pytest.mark.parametrize("origin", ["http://localhost:5173", "http://127.0.0.1:5173"])
def test_both_explicit_development_origins(origin):
    with TestClient(app) as client:
        result = client.options(
            "/api/analyze",
            headers={
                "Origin": origin,
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "authorization,content-type",
            },
        )
        assert result.status_code == 200
        assert result.headers["access-control-allow-origin"] == origin
        assert (
            client.options(
                "/api/analyze", headers={"Origin": "https://evil.example", "Access-Control-Request-Method": "POST"}
            ).status_code
            == 400
        )


def test_cleanup_removes_expired_media_but_not_active_or_locked_files(tmp_path):
    expired = {"id": "expired", "status": "completed", "storage_path": "ephemeral/expired.mp4"}
    locked = {"id": "locked", "status": "cancelled", "storage_path": "ephemeral/locked.mp4"}

    def scan(statuses=None, **_filters):
        return [locked] if statuses == {"failed", "cancelled"} else []

    with (
        patch("app.tasks.JobStore") as store,
        patch("app.tasks.Database") as db,
        patch("app.tasks.cache") as redis,
        patch("app.tasks.settings", return_value=Settings(temp_root=str(tmp_path))),
    ):
        store.return_value.scan.side_effect = scan
        store.return_value.due_files.return_value = [(expired["id"], expired["storage_path"])]
        store.return_value.job.return_value = expired

        def worker_lock(key, **_kwargs):
            lock = MagicMock()
            lock.acquire.return_value = key != "job-lock:locked"
            return lock

        redis.return_value.lock.side_effect = worker_lock
        db.return_value.temporary_files.return_value = []
        cleanup.run()
        db.return_value.remove_file.assert_called_once_with(expired["storage_path"])
        store.return_value.update_job.assert_called_once_with("expired", status="expired", storage_path=None)
        db.return_value.patch.assert_not_called()


@pytest.mark.parametrize(
    "component,expected",
    [("redis", "redis_unavailable"), ("database", "database_unavailable"), ("worker", "worker_unavailable")],
)
def test_health_identifies_failed_component(component, expected):
    with (
        patch("app.main.settings", return_value=Settings(supabase_secret_key=SECRET)),
        patch("app.main.cache") as redis,
        patch("app.main.Database") as db,
        patch("app.main.celery") as celery,
        TestClient(app) as client,
    ):
        if component == "redis":
            redis.return_value.ping.side_effect = ConnectionError()
        if component == "database":
            db.return_value.rows.side_effect = ConnectionError()
        if component == "worker":
            celery.control.inspect.return_value.ping.return_value = None
        assert client.get("/health").json()["status"] == expected


@pytest.mark.parametrize("duration,size,expected", [(None, 1, 400), (901, 1, 400), (10, 105 * 1024 * 1024, 413)])
def test_guest_download_rejects_media_outside_limits(guest_client, duration, size, expected):
    data = {"status": "completed", "duration": duration, "formats": [{"id": "format", "size": size}]}
    with (
        patch("app.main.cache") as redis,
        patch("app.main.rate"),
        patch("app.main.guest_rate"),
        patch("app.main.reserve") as create,
    ):
        redis.return_value.get.return_value = json.dumps(data)
        response = guest_client.post(
            "/api/downloads", json={"analysis_id": str(uuid4()), "format_id": "format", "idempotency_key": str(uuid4())}
        )
        assert response.status_code == expected
        create.assert_not_called()


def test_guest_can_retry_owned_failed_job_with_same_limits(guest_client):
    jid = str(uuid4())
    job = {
        "id": jid,
        "status": "failed",
        "source_url": "https://example.com/v",
        "title": "Test",
        "platform": "Fixture",
        "format_spec": {"label": "MP4", "_policy": media_policy(True)},
    }
    with (
        patch("app.main.JobStore") as store,
        patch("app.main.rate"),
        patch("app.main.guest_rate"),
        patch("app.main.download"),
    ):
        store.return_value.job.return_value = job
        store.return_value.reserve.return_value = ({"id": str(uuid4()), "status": "queued"}, True)
        response = guest_client.post(f"/api/downloads/{jid}/retry", json={"idempotency_key": str(uuid4())})
        assert response.status_code == 202
        payload = store.return_value.reserve.call_args.kwargs
        assert payload["spec"]["_policy"] == media_policy(True)
        assert payload["max_active"] == 1
