import json
import os
import selectors
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from uuid import UUID

import httpx

from .config import settings
from .db import Database
from .guest import media_policy
from .jobs import JobStore
from .media_runtime import YT_DLP_VERSION
from .providers import UnsupportedProvider, select_provider
from .queue import cache, celery
from .security import validate_media_url as validate_url


class MediaFailure(Exception):
    pass


def timestamp():
    return datetime.now(timezone.utc)


def stop(process):
    if process.poll() is None:
        os.killpg(process.pid, signal.SIGTERM)
        try:
            process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait(timeout=3)


def run_media(request, on_event=None, cancelled=lambda: False, timeout=None):
    config = settings()
    if not config.media_proxy:
        raise MediaFailure("EGRESS_NOT_CONFIGURED")
    root = Path(config.temp_root)
    root.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="task-", dir=root) as directory:
        policy = media_policy(stored=request.get("policy"))
        request = {
            **request,
            "directory": directory,
            "proxy": config.media_proxy,
            "max_bytes": policy["max_bytes"],
            "max_duration": policy["max_duration"],
            "require_duration": policy["guest"],
            "fragment_concurrency": config.media_fragment_concurrency,
        }
        request_path = Path(directory) / "request.json"
        request_path.write_text(json.dumps(request))
        # The child receives no Supabase, Redis, cloud or runtime credentials.
        env = {
            "PATH": os.environ.get("PATH", ""),
            "HOME": directory,
            "TMPDIR": directory,
            "PYTHONUNBUFFERED": "1",
            "PYTHONPATH": str(Path(__file__).resolve().parent.parent),
            "HTTP_PROXY": config.media_proxy,
            "HTTPS_PROXY": config.media_proxy,
            "http_proxy": config.media_proxy,
            "https_proxy": config.media_proxy,
            "NO_PROXY": "",
        }
        process = subprocess.Popen(
            [sys.executable, "-m", "app.extract", str(request_path)],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
            env=env,
        )
        reader = selectors.DefaultSelector()
        reader.register(process.stdout, selectors.EVENT_READ)
        os.set_blocking(process.stdout.fileno(), False)
        result, failure, buffer = None, None, b""
        eof = False
        started = time.monotonic()
        try:
            while True:
                if cancelled():
                    raise MediaFailure("CANCELLED")
                if time.monotonic() - started > (timeout or config.job_timeout_seconds):
                    raise MediaFailure("TIME_LIMIT")
                if sum(p.stat().st_size for p in Path(directory).glob("*") if p.is_file()) > request["max_bytes"] * 3:
                    raise MediaFailure("FILE_TOO_LARGE")
                for key, _ in reader.select(timeout=0.25):
                    data = os.read(key.fileobj.fileno(), 65536)
                    if not data:
                        eof = True
                    else:
                        buffer += data
                        if len(buffer) > 2 * 1024 * 1024:
                            raise MediaFailure("INVALID_MEDIA_RESPONSE")
                        while b"\n" in buffer:
                            line, buffer = buffer.split(b"\n", 1)
                            try:
                                event = json.loads(line)
                            except json.JSONDecodeError:
                                continue
                            if event.get("type") == "result":
                                result = event
                            elif event.get("type") == "error":
                                failure = event.get("code")
                            elif on_event:
                                on_event(event)
                if process.poll() is not None and eof:
                    break
            if failure or process.returncode != 0 or not result:
                raise MediaFailure(failure or "EXTRACTION_FAILED")
            if "file" in result:
                file = Path(result["file"]).resolve()
                if file.parent != Path(directory).resolve() or not file.is_file():
                    raise MediaFailure("OUTPUT_INVALID")
                # Materialize the finished output outside this per-process directory.
                target = root / ("ready-" + Path(directory).name + file.suffix)
                shutil.move(str(file), target)
                return target
            return result["data"]
        finally:
            stop(process)
            reader.close()
            process.stdout.close()


@celery.task(name="app.tasks.analyze", ignore_result=True)
def analyze(user_id, analysis_id, url=None, provider_test=None, policy=None):
    """Task messages contain identities only; source requests expire in Redis."""
    redis = cache()
    key = f"analysis:{user_id}:{analysis_id}"
    request_key = f"analysis_request:{user_id}:{analysis_id}"
    lock = redis.lock(f"analysis-lock:{user_id}:{analysis_id}", timeout=180, blocking_timeout=0)
    if not lock.acquire(blocking=False):
        return
    try:
        if url is None:
            # GETDEL consumes the private request once without leaking it to broker logs.
            raw = redis.getdel(request_key)
            if not raw:
                existing = redis.get(key)
                if existing and json.loads(existing).get("status") in {"completed", "failed"}:
                    return  # A redelivered task must not replace an already settled result.
                raise MediaFailure("ANALYSIS_EXPIRED")
            request = json.loads(raw)
            url, policy, provider_test = request["url"], request.get("policy"), request.get("provider_test")
        validate_url(url)
        if provider_test and provider_test.get("enabled") is False:
            raise UnsupportedProvider("This source has been disabled.", "SOURCE_DISABLED")
        provider = provider_test or select_provider(url)
        policy = media_policy(stored=policy)
        data = run_media(
            {
                "mode": "analyze",
                "url": url,
                "adapter": provider["adapter_key"],
                "policy": policy,
                "source_rules": provider.get("_source_rules", ()),
            },
            timeout=120,
        )
        data.update(
            {
                "status": "completed",
                "url": url,
                "provider_id": provider["id"],
                "adapter": provider["adapter_key"],
                "analysis_id": analysis_id,
                "policy": policy,
                "extractor_version": YT_DLP_VERSION,
            }
        )
        redis.setex(key, 900, json.dumps(data))
        if provider_test:
            Database().patch(
                "video_providers",
                {"id": f"eq.{provider_test['id']}"},
                {"support_status": "available", "last_checked_at": timestamp().isoformat()},
            )
    except Exception as exc:
        code = (
            exc.code
            if isinstance(exc, UnsupportedProvider)
            else str(exc)
            if isinstance(exc, MediaFailure)
            else "SERVICE_UNAVAILABLE"
            if isinstance(exc, httpx.HTTPError)
            else "ANALYSIS_FAILED"
        )
        redis.setex(key, 900, json.dumps({"status": "failed", "error_code": code, "error_stage": "analysis"}))
        if provider_test:
            Database().patch(
                "video_providers",
                {"id": f"eq.{provider_test['id']}"},
                {"support_status": "temporarily_unavailable", "last_checked_at": timestamp().isoformat()},
            )
    finally:
        redis.delete(request_key)
        try:
            lock.release()
        except Exception:
            pass


def remove_temporary_file(database, store, job_id, path):
    """Keep the opaque cleanup ledger until Storage confirms deletion."""
    database.remove_file(path)
    store.untrack_file(job_id, path)


def cleanup_file(database, store, redis, job_id, path, due_at=None):
    """Serialize cleanup against URL issuance and recheck a potentially extended lease."""
    lock = redis.lock(f"job-lock:{job_id}", timeout=90, blocking_timeout=0)
    if not lock.acquire(blocking=False):
        return False
    try:
        if due_at is not None and not store.file_due(job_id, path, due_at):
            return False
        remove_temporary_file(database, store, job_id, path)
        job = store.job(job_id)
        if job:
            store.update_job(
                job_id, status="expired" if job["status"] == "completed" else job["status"], storage_path=None
            )
        return True
    finally:
        try:
            lock.release()
        except Exception:
            pass


@celery.task(name="app.tasks.download", bind=True, max_retries=2, ignore_result=True)
def download(self, job_id):
    config, database, redis, store = settings(), Database(), cache(), JobStore()
    # Covers extraction, final probing and bounded upload; the Celery hard limit is shorter.
    lock = redis.lock(f"job-lock:{job_id}", timeout=config.job_timeout_seconds + 1020, blocking_timeout=0)
    if not lock.acquire(blocking=False):
        return
    file = None
    stored_path = None
    stage = ["routing"]
    try:
        job = store.job(job_id)
        if not job or job["status"] in {"completed", "cancelled", "expired", "failed"}:
            return
        policy = media_policy(stored=job["format_spec"].get("_policy"))
        validate_url(job["source_url"])
        provider = select_provider(job["source_url"])
        if not store.update_job(job_id, status="downloading", progress=None, error_code=None):
            return
        last_update = [0.0]
        stage[0] = "downloading"

        def cancelled():
            return bool(redis.get(f"cancel:{job_id}")) or store.job(job_id) is None

        def progress(event):
            if event.get("type") == "stage":
                stage[0] = "processing"
            elif event.get("type") == "progress":
                stage[0] = "downloading"
            if time.monotonic() - last_update[0] > 2:
                store.update_job(
                    job_id,
                    status=stage[0],
                    progress=event.get("progress") if stage[0] == "downloading" else None,
                    speed=event.get("speed"),
                    eta=event.get("eta"),
                )
                last_update[0] = time.monotonic()

        file = run_media(
            {
                "mode": "download",
                "url": job["source_url"],
                "format": job["format_spec"],
                "policy": policy,
                "adapter": provider["adapter_key"],
                "source_rules": provider.get("_source_rules", ()),
            },
            progress,
            cancelled,
        )
        if cancelled():
            raise MediaFailure("CANCELLED")
        stage[0] = "validation"
        probe = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "json", str(file)],
            capture_output=True,
            timeout=20,
            check=True,
        )
        duration = float(json.loads(probe.stdout).get("format", {}).get("duration", 0))
        if (
            duration > policy["max_duration"]
            or file.stat().st_size > policy["max_bytes"]
            or (policy["guest"] and duration <= 0)
        ):
            raise MediaFailure("MEDIA_LIMIT")
        # No source title or URL enters Storage object keys. The API sets the final filename.
        expires = timestamp() + timedelta(seconds=policy["retention_seconds"])
        hard_expiry = int(
            time.time()
            + config.job_timeout_seconds
            + 900
            + policy["retention_seconds"]
            + config.signed_url_ttl_seconds
            + config.download_transfer_grace_seconds
        )
        stored_path = f"ephemeral/{job['user_id']}__{job_id}__{hard_expiry}{file.suffix.lower()}"
        store.track_file(job_id, stored_path, time.time() + config.job_timeout_seconds + 1020)
        if not store.update_job(
            job_id, status="uploading", storage_path=stored_path, progress=None, speed=None, eta=None
        ):
            raise MediaFailure("CANCELLED")
        stage[0] = "uploading"
        database.upload(stored_path, file)
        if cancelled():
            raise MediaFailure("CANCELLED")
        # Reset retention from actual completion, independently of job-metadata expiry.
        expires = timestamp() + timedelta(seconds=policy["retention_seconds"])
        store.track_file(job_id, stored_path, expires.timestamp())
        updated = store.update_job(
            job_id,
            status="completed",
            progress=100,
            storage_path=stored_path,
            file_size=file.stat().st_size,
            completed_at=timestamp().isoformat(),
            expires_at=expires.isoformat(),
            output_extension=file.suffix.lower(),
        )
        if not updated:
            remove_temporary_file(database, store, job_id, stored_path)
    except Exception as exc:
        if stored_path:
            store.track_file(job_id, stored_path, time.time())
            try:
                remove_temporary_file(database, store, job_id, stored_path)
            except Exception:
                pass  # Redis holds only an opaque cleanup pointer for the next sweep.
        code = (
            exc.code
            if isinstance(exc, UnsupportedProvider)
            else str(exc)
            if isinstance(exc, MediaFailure)
            else "SERVICE_UNAVAILABLE"
            if isinstance(exc, httpx.HTTPError)
            else "PROCESSING_FAILED"
        )
        if code == "CANCELLED":
            store.cancel(job_id)
        else:
            store.update_job(job_id, status="failed", error_code=code, error_stage=stage[0], progress=None)
    finally:
        if file:
            file.unlink(missing_ok=True)
        try:
            lock.release()
        except Exception:
            pass


@celery.task(name="app.tasks.cleanup", ignore_result=True)
def cleanup():
    database, config, redis, store = Database(), settings(), cache(), JobStore()
    current = timestamp()
    # Recover interrupted tasks before deleting staged files. Locks cover active uploads.
    cutoff = current - timedelta(seconds=config.job_timeout_seconds + 1080)
    for job in store.scan(statuses={"downloading", "processing", "uploading"}, before=cutoff.isoformat(), limit=100):
        if not redis.exists(f"job-lock:{job['id']}"):
            store.update_job(job["id"], status="failed", error_code="WORKER_INTERRUPTED")
    for job in store.scan(statuses={"queued"}, before=(current - timedelta(seconds=60)).isoformat(), limit=100):
        if datetime.fromisoformat(job["created_at"].replace("Z", "+00:00")) < cutoff:
            store.update_job(job["id"], status="failed", error_code="QUEUE_TIMEOUT")
        else:
            # Opaque outbox recovery covers queue-send failure after atomic Redis reservation.
            download.apply_async(args=[job["id"]], task_id=job["id"], expires=config.job_timeout_seconds + 900)
    # Failed/cancelled uploads use the same due-file ledger. Unlike scanning
    # terminal history, this queue cannot be monopolized by handled jobs.
    # The ledger outlives expiring job JSON, so orphaned files can still be removed.
    for job_id, path in store.due_files(current.timestamp(), limit=100):
        try:
            cleanup_file(database, store, redis, job_id, path, due_at=current.timestamp())
        except Exception:
            continue
    # Independent bounded Storage sweep survives a lost/non-persistent Redis instance.
    # Only dedicated new namespace objects past their hard cap are eligible.
    try:
        orphaned = database.temporary_files(current.timestamp(), limit=100)
    except Exception:
        orphaned = []
    for path in orphaned:
        try:
            prefix, name = path.split("/", 1)
            owner_id, job_id, expires = name.split("__")
            UUID(owner_id)
            UUID(job_id)
            if prefix != "ephemeral" or "/" in name or int(expires.split(".")[0]) > current.timestamp():
                continue
            cleanup_file(database, store, redis, job_id, path)
        except Exception:
            continue
    store.prune_indices(limit=100)
    root = Path(config.temp_root)
    if root.exists():
        for item in root.iterdir():
            try:
                if time.time() - item.stat().st_mtime > config.job_timeout_seconds + 1200:
                    shutil.rmtree(item, ignore_errors=True) if item.is_dir() else item.unlink(missing_ok=True)
            except FileNotFoundError:
                pass  # Another worker may already have removed its own output.
