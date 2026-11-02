import json
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit
from uuid import uuid4

import fakeredis
import pytest
from fastapi.testclient import TestClient

from app.db import Database
from app.filenames import download_filename, temporary_path_expiry
from app.jobs import JobStore, ReservationError
from app.main import api_app, app, current_user


@pytest.fixture
def store():
    return JobStore(fakeredis.FakeRedis(decode_responses=True))


def reserve(store, **kwargs):
    data = dict(
        user_id=str(uuid4()),
        source_url="https://example.com/video",
        title="Fixture",
        platform="Test",
        spec={"label": "1080p MP4", "kind": "video", "_policy": {"retention_seconds": 1800}},
        key=str(uuid4()),
        max_active=2,
        daily_limit=5,
    )
    return store.reserve(**{**data, **kwargs})


def test_simultaneous_retries_create_one_job_and_one_quota_charge():
    server = fakeredis.FakeServer()
    uid, key = str(uuid4()), str(uuid4())

    def attempt(_):
        s = JobStore(fakeredis.FakeRedis(server=server, decode_responses=True))
        return reserve(s, user_id=uid, key=key)

    with ThreadPoolExecutor(max_workers=12) as pool:
        outcomes = list(pool.map(attempt, range(12)))
    assert len({job["id"] for job, _ in outcomes}) == 1
    assert sum(created for _, created in outcomes) == 1
    redis = fakeredis.FakeRedis(server=server, decode_responses=True)
    assert redis.get(f"yd:daily:{uid}:{int(time.time()) // 86400}") == "1"
    assert len(redis.keys("yd:job:*")) == 1


def test_simultaneous_different_jobs_cannot_exceed_active_quota():
    server, uid = fakeredis.FakeServer(), str(uuid4())

    def attempt(_):
        try:
            reserve(JobStore(fakeredis.FakeRedis(server=server, decode_responses=True)), user_id=uid, max_active=2)
            return True
        except ReservationError as exc:
            assert str(exc) == "quota"
            return False

    with ThreadPoolExecutor(max_workers=12) as pool:
        assert sum(pool.map(attempt, range(12))) == 2


def test_reusing_key_for_different_format_is_conflict_without_charge(store):
    uid, key = str(uuid4()), str(uuid4())
    reserve(store, user_id=uid, key=key)
    with pytest.raises(ReservationError, match="conflict"):
        reserve(store, user_id=uid, key=key, spec={"label": "MP3"})
    assert store.redis.get(f"yd:daily:{uid}:{int(time.time()) // 86400}") == "1"


def test_cancelling_releases_active_slot_but_not_daily_quota(store):
    uid = str(uuid4())
    job, _ = reserve(store, user_id=uid, max_active=1, daily_limit=2)
    with pytest.raises(ReservationError, match="quota"):
        reserve(store, user_id=uid, max_active=1, daily_limit=2)
    store.cancel(job["id"])
    job2, _ = reserve(store, user_id=uid, max_active=1, daily_limit=2)
    store.cancel(job2["id"])
    with pytest.raises(ReservationError, match="quota"):
        reserve(store, user_id=uid, max_active=1, daily_limit=2)


def test_cancel_cannot_be_overwritten_by_late_worker_progress(store):
    job, _ = reserve(store)
    store.cancel(job["id"])
    assert not store.update_job(job["id"], status="completed", progress=100)
    assert store.job(job["id"])["status"] == "cancelled"
    assert store.redis.get(f"cancel:{job['id']}") == "1"


def test_expiring_private_metadata_and_owner_scoped_list(store):
    uid = str(uuid4())
    own, _ = reserve(store, user_id=uid)
    other, _ = reserve(store)
    assert store.job(own["id"], str(uuid4())) is None
    assert [j["id"] for j in store.list(uid)] == [own["id"]]
    assert store.redis.ttl(f"yd:job:{own['id']}") > 0
    store.redis.delete(f"yd:job:{own['id']}")
    assert store.list(uid) == []
    assert store.job(other["id"])


def test_cleanup_pointer_survives_job_metadata_and_transfer_extension(store):
    job, _ = reserve(store)
    path = f"ephemeral/{job['user_id']}__{job['id']}__{int(time.time()) + 20000}.mp4"
    store.update_job(job["id"], status="completed", storage_path=path)
    store.track_file(job["id"], path, 10)
    assert store.file_due(job["id"], path, 11)
    store.extend_file(job["id"], 100)
    store.extend_file(job["id"], 20)
    assert not store.file_due(job["id"], path, 99)
    store.redis.delete(f"yd:job:{job['id']}")
    assert store.due_files(101) == [(job["id"], path)]
    store.untrack_file(job["id"], path)
    assert store.due_files(101) == []


def test_forget_removes_source_metadata_without_truncating_transfer_lease(store):
    job, _ = reserve(store)
    store.track_file(job["id"], "opaque-path", 100)
    assert store.forget(job["id"])
    assert store.job(job["id"]) is None
    assert store.due_files(101) == [(job["id"], "opaque-path")]


@pytest.mark.parametrize("title", ["../../CON", "a\r\nContent-Type: evil", 'x<>:"/\\|?*', " . ", "සිංහල වීඩියෝ", "ශ්‍රී ලංකා"])
def test_suggested_filenames_are_safe_and_brand_prefixed(title):
    name = download_filename(title, ".mp4")
    assert name.startswith("youtubedown - ") and name.endswith(".mp4")
    assert not any(c in name for c in '\r\n<>:"/\\|?*')
    assert ".." not in name
    assert len(name.encode()) <= 210
    if title in {"සිංහල වීඩියෝ", "ශ්‍රී ලංකා"}:
        assert title in name


def test_filename_length_preserves_valid_unicode_and_actual_extension():
    name = download_filename("අ" * 500, "WEBM")
    assert name.endswith(".webm")
    assert len(name.encode("utf-8")) < 210
    with pytest.raises(ValueError):
        download_filename("Video", "mp4\r\nheader")


def test_storage_signed_link_keeps_token_and_carries_utf8_download_name():
    filename = "youtubedown - සිංහල වීඩියෝ.mp4"
    with patch.object(
        Database, "request", return_value={"signedURL": "/object/sign/downloads/ephemeral/x?token=private"}
    ):
        url = Database().signed_url("ephemeral/x", filename)
    query = parse_qs(urlsplit(url).query)
    assert query == {"token": ["private"], "download": [filename]}


def test_orphan_sweep_only_targets_expired_new_namespace_objects():
    uid, jid, now = str(uuid4()), str(uuid4()), int(time.time())
    valid = f"{uid}__{jid}__{now - 100}.mp4"
    values = [
        {"name": valid},
        {"name": f"{uid}__{jid}__{now + 100}.mp4"},
        {"name": "videoflow.mp4"},
        {"name": "../legacy/file"},
    ]
    with (
        patch.object(Database, "request", return_value=values) as request,
        patch("app.db.cache", return_value=fakeredis.FakeRedis(decode_responses=True)),
    ):
        assert Database().temporary_files(now) == ["ephemeral/" + valid]
        assert request.call_args.kwargs["json"]["prefix"] == "ephemeral"
    assert temporary_path_expiry("ephemeral/" + valid, str(uuid4()), jid) is None


def test_api_downloads_never_call_permanent_tables_or_reserve_rpc(store):
    uid = str(uuid4())
    aid, key = str(uuid4()), str(uuid4())
    analysis = {
        "status": "completed",
        "duration": 10,
        "url": "https://example.com/video",
        "title": "Fixture",
        "platform": "Test",
        "formats": [{"id": "video-0", "label": "MP4", "kind": "video", "ext": "mp4"}],
    }
    store.redis.setex(f"analysis:{uid}:{aid}", 900, json.dumps(analysis))
    api_app.dependency_overrides[current_user] = lambda: {"id": uid}
    try:
        with (
            patch("app.main.JobStore", return_value=store),
            patch("app.main.cache", return_value=store.redis),
            patch("app.main.download") as download,
            patch("app.main.Database") as database,
            TestClient(app) as client,
        ):
            body = {"analysis_id": aid, "format_id": "video-0", "idempotency_key": key}
            first = client.post("/api/downloads", json=body)
            again = client.post("/api/downloads", json=body)
            assert first.status_code == again.status_code == 202
            jid = first.json()["id"]
            assert jid == again.json()["id"]
            assert download.apply_async.call_count == 1
            assert client.get("/api/downloads").json()[0]["id"] == jid
            assert client.post(f"/api/downloads/{jid}/cancel").json()["status"] == "cancelled"
            assert client.delete(f"/api/downloads/{jid}").status_code == 200
            database.assert_not_called()
    finally:
        api_app.dependency_overrides.clear()


def test_signed_link_lease_protects_browser_transfer(store):
    job, _ = reserve(store)
    now = time.time()
    path = f"ephemeral/{job['user_id']}__{job['id']}__{int(now) + 10000}.mp4"
    store.update_job(
        job["id"],
        status="completed",
        storage_path=path,
        expires_at=(datetime.now(timezone.utc) + timedelta(minutes=5)).isoformat(),
    )
    store.track_file(job["id"], path, now + 300)
    api_app.dependency_overrides[current_user] = lambda: {"id": job["user_id"]}
    try:
        with (
            patch("app.main.JobStore", return_value=store),
            patch("app.main.cache", return_value=store.redis),
            patch("app.main.Database.signed_url", return_value="https://storage.test/file?download=title") as sign,
            TestClient(app) as client,
        ):
            result = client.get(f"/api/downloads/{job['id']}/file")
            assert result.status_code == 200
            assert result.json()["filename"] == "youtubedown - Fixture.mp4"
            assert not store.file_due(job["id"], path, now + 3500)
            sign.assert_called_once_with(path, "youtubedown - Fixture.mp4")
    finally:
        api_app.dependency_overrides.clear()


def test_storage_orphan_cursor_does_not_starve_behind_noneligible_objects():
    redis = fakeredis.FakeRedis(decode_responses=True)
    uid, jid, now = str(uuid4()), str(uuid4()), int(time.time())
    expired = {"name": f"{uid}__{jid}__{now - 100}.mp4"}
    pages = [[{"name": "malformed-object"}], [expired], []]
    with patch("app.db.cache", return_value=redis), patch.object(Database, "request", side_effect=pages) as request:
        assert Database().temporary_files(now, limit=1) == []
        assert Database().temporary_files(now, limit=1) == ["ephemeral/" + expired["name"]]
        assert Database().temporary_files(now, limit=1) == []
        assert [call.kwargs["json"]["offset"] for call in request.call_args_list] == [0, 1, 2]
        assert redis.get("yd:storage-sweep-offset") == "0"


def test_status_indexes_do_not_keep_expired_job_ids_forever(store):
    job, _ = reserve(store)
    store.update_job(job["id"], status="completed")
    store.update_job(job["id"], status="expired")
    assert store.redis.ttl("yd:status:expired") > 0
    store.redis.delete(f"yd:job:{job['id']}")
    store.prune_indices()
    assert store.redis.zcard("yd:status:expired") == 0
