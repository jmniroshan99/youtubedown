"""Temporary processing lifecycle never needs a permanent download table."""

import json
import subprocess
from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock, patch
from uuid import uuid4

import fakeredis

from app import tasks
from app.config import Settings
from app.guest import media_policy
from app.queue import celery


def queued_job():
    return {
        "id": str(uuid4()),
        "user_id": str(uuid4()),
        "status": "queued",
        "source_url": "https://example.com/video.mp4",
        "format_spec": {"_policy": media_policy(True)},
        "created_at": datetime.now(timezone.utc).isoformat(),
    }


def test_analysis_request_consumed_from_expiring_redis_without_source_in_task_args():
    redis = fakeredis.FakeRedis(decode_responses=True)
    user, analysis = str(uuid4()), str(uuid4())
    key = f"analysis_request:{user}:{analysis}"
    redis.setex(key, 900, json.dumps({"url": "https://example.com/video.mp4", "policy": media_policy(True)}))
    with (
        patch("app.tasks.cache", return_value=redis),
        patch("app.tasks.select_provider", return_value={"id": None, "adapter_key": "direct"}),
        patch("app.tasks.run_media", return_value={"title": "Example", "formats": []}) as media,
    ):
        tasks.analyze.run(user, analysis)
    assert redis.get(key) is None
    result = json.loads(redis.get(f"analysis:{user}:{analysis}"))
    assert result["status"] == "completed"
    assert 0 < redis.ttl(f"analysis:{user}:{analysis}") <= 900
    assert media.call_args.args[0]["url"] == "https://example.com/video.mp4"


def test_missing_analysis_request_does_not_start_media_or_probe_provider():
    redis = fakeredis.FakeRedis(decode_responses=True)
    user, analysis = str(uuid4()), str(uuid4())
    with (
        patch("app.tasks.cache", return_value=redis),
        patch("app.tasks.select_provider") as provider,
        patch("app.tasks.run_media") as media,
    ):
        tasks.analyze.run(user, analysis)
    media.assert_not_called()
    provider.assert_not_called()
    assert json.loads(redis.get(f"analysis:{user}:{analysis}"))["error_code"] == "ANALYSIS_EXPIRED"


def test_download_uses_temporary_store_and_tracks_before_upload(tmp_path):
    job = queued_job()
    file = tmp_path / "actual.mp4"
    file.write_bytes(b"small fixture")
    order = []
    store = MagicMock()
    store.job.return_value = job
    store.update_job.return_value = [job]
    store.track_file.side_effect = lambda *_args: order.append("track")
    database = MagicMock()
    database.upload.side_effect = lambda *_args: order.append("upload")
    redis = MagicMock()
    redis.lock.return_value.acquire.return_value = True
    redis.get.return_value = None
    with (
        patch("app.tasks.JobStore", return_value=store),
        patch("app.tasks.Database", return_value=database),
        patch("app.tasks.cache", return_value=redis),
        patch("app.tasks.select_provider", return_value={"id": None, "adapter_key": "direct"}),
        patch("app.tasks.run_media", return_value=file),
        patch(
            "app.tasks.subprocess.run", return_value=subprocess.CompletedProcess([], 0, b'{"format":{"duration":"1"}}')
        ),
    ):
        tasks.download.run(job["id"])
    assert order == ["track", "upload", "track"]
    path = database.upload.call_args.args[0]
    assert path.startswith(f"ephemeral/{job['user_id']}__{job['id']}__")
    assert path.endswith(".mp4")
    assert "example.com" not in path
    completed = next(
        call.kwargs for call in store.update_job.call_args_list if call.kwargs.get("status") == "completed"
    )
    assert completed["output_extension"] == ".mp4"
    assert completed["storage_path"] == path
    database.event.assert_not_called()
    database.insert.assert_not_called()
    database.patch.assert_not_called()
    assert not file.exists()


def test_partial_upload_failure_retains_cleanup_pointer_if_deletion_fails(tmp_path):
    job = queued_job()
    file = tmp_path / "actual.mp4"
    file.write_bytes(b"small fixture")
    store = MagicMock()
    store.job.return_value = job
    store.update_job.return_value = [job]
    database = MagicMock()
    database.upload.side_effect = RuntimeError("do not log private response")
    database.remove_file.side_effect = RuntimeError("storage offline")
    redis = MagicMock()
    redis.lock.return_value.acquire.return_value = True
    redis.get.return_value = None
    with (
        patch("app.tasks.JobStore", return_value=store),
        patch("app.tasks.Database", return_value=database),
        patch("app.tasks.cache", return_value=redis),
        patch("app.tasks.select_provider", return_value={"id": None, "adapter_key": "direct"}),
        patch("app.tasks.run_media", return_value=file),
        patch(
            "app.tasks.subprocess.run", return_value=subprocess.CompletedProcess([], 0, b'{"format":{"duration":"1"}}')
        ),
    ):
        tasks.download.run(job["id"])
    assert store.track_file.call_count == 2
    assert store.track_file.call_args_list[-1].args[2] < store.track_file.call_args_list[0].args[2]
    store.untrack_file.assert_not_called()
    store.update_job.assert_any_call(job["id"], status="failed", error_code="PROCESSING_FAILED", progress=None)
    assert not file.exists()


def test_cleanup_removes_ledger_file_even_after_job_metadata_expired(tmp_path):
    store = MagicMock()
    store.scan.return_value = []
    store.due_files.return_value = [("job", "owner/job/youtubedown-tmp-1.mp4")]
    store.job.return_value = None
    redis = MagicMock()
    redis.exists.return_value = False
    with (
        patch("app.tasks.JobStore", return_value=store),
        patch("app.tasks.Database") as database,
        patch("app.tasks.cache", return_value=redis),
        patch("app.tasks.settings", return_value=Settings(temp_root=str(tmp_path))),
    ):
        tasks.cleanup.run()
    database.return_value.remove_file.assert_called_once_with("owner/job/youtubedown-tmp-1.mp4")
    store.untrack_file.assert_called_once_with("job", "owner/job/youtubedown-tmp-1.mp4")
    database.return_value.rows.assert_not_called()


def test_cleanup_preserves_locked_files_and_deletion_retry_ledger(tmp_path):
    store = MagicMock()
    store.scan.return_value = []
    store.due_files.return_value = [("active", "a"), ("offline", "b")]
    redis = MagicMock()

    def worker_lock(key, **_kwargs):
        lock = MagicMock()
        lock.acquire.return_value = key != "job-lock:active"
        return lock

    redis.lock.side_effect = worker_lock
    with (
        patch("app.tasks.JobStore", return_value=store),
        patch("app.tasks.Database") as database,
        patch("app.tasks.cache", return_value=redis),
        patch("app.tasks.settings", return_value=Settings(temp_root=str(tmp_path))),
    ):
        database.return_value.remove_file.side_effect = RuntimeError("storage offline")
        tasks.cleanup.run()
    database.return_value.remove_file.assert_called_once_with("b")
    store.untrack_file.assert_not_called()


def test_cleanup_requeues_recent_queued_jobs_and_expires_stale_queue(tmp_path):
    now = datetime.now(timezone.utc)
    recent = {**queued_job(), "created_at": (now - timedelta(seconds=90)).isoformat()}
    old = {**queued_job(), "created_at": (now - timedelta(days=1)).isoformat()}
    store = MagicMock()
    store.scan.side_effect = [[], [recent, old], []]
    store.due_files.return_value = []
    with (
        patch("app.tasks.JobStore", return_value=store),
        patch("app.tasks.Database"),
        patch("app.tasks.cache"),
        patch("app.tasks.download.apply_async") as enqueue,
        patch("app.tasks.settings", return_value=Settings(temp_root=str(tmp_path))),
    ):
        tasks.cleanup.run()
    assert enqueue.call_count == 1
    assert enqueue.call_args.kwargs["args"] == [recent["id"]]
    store.update_job.assert_called_once_with(old["id"], status="failed", error_code="QUEUE_TIMEOUT")


def test_worker_does_not_keep_task_results_or_publish_argument_events():
    assert celery.conf.task_ignore_result
    assert not celery.conf.task_store_errors_even_if_ignored
    assert not celery.conf.worker_send_task_events
    assert not celery.conf.task_send_sent_event
    assert celery.conf.result_expires <= 300


def test_cleanup_lease_recheck_keeps_a_file_extended_after_due_scan():
    store, database, redis = MagicMock(), MagicMock(), MagicMock()
    store.file_due.return_value = False
    assert not tasks.cleanup_file(database, store, redis, "job", "path", due_at=10)
    database.remove_file.assert_not_called()
    redis.lock.return_value.release.assert_called_once()


def test_independent_storage_sweep_survives_lost_redis_without_touching_legacy(tmp_path):
    owner, job_id = str(uuid4()), str(uuid4())
    expired = f"ephemeral/{owner}__{job_id}__1.mp4"
    future = f"ephemeral/{owner}__{job_id}__9999999999.mp4"
    legacy = f"{owner}/{job_id}/videoflow.mp4"
    store, redis, database = MagicMock(), MagicMock(), MagicMock()
    store.scan.return_value = []
    store.due_files.return_value = []
    store.job.return_value = None
    database.temporary_files.return_value = [expired, future, legacy, "unexpected"]
    with (
        patch("app.tasks.JobStore", return_value=store),
        patch("app.tasks.Database", return_value=database),
        patch("app.tasks.cache", return_value=redis),
        patch("app.tasks.settings", return_value=Settings(temp_root=str(tmp_path))),
    ):
        tasks.cleanup.run()
    database.remove_file.assert_called_once_with(expired)


def test_analysis_redelivery_does_not_overwrite_completed_result():
    redis = fakeredis.FakeRedis(decode_responses=True)
    user, analysis = str(uuid4()), str(uuid4())
    result = {"status": "completed", "title": "Fixture", "formats": []}
    key = f"analysis:{user}:{analysis}"
    redis.set(key, json.dumps(result), ex=900)
    with patch("app.tasks.cache", return_value=redis), patch("app.tasks.run_media") as media:
        tasks.analyze.run(user, analysis)
    media.assert_not_called()
    assert json.loads(redis.get(key)) == result
