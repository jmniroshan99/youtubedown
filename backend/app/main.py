import json
import logging
import time
from datetime import datetime, timezone
from typing import Annotated
from uuid import UUID, uuid4

import httpx
from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, Field, field_validator

from .config import settings
from .db import Database
from .filenames import download_filename, temporary_path_expiry
from .guest import guest_rate, media_policy
from .jobs import JobStore, ReservationError
from .queue import cache, celery
from .security import UnsafeURL
from .security import validate_media_url as validate_url
from .tasks import analyze, download

app = FastAPI(title="youtubedown API", version="2.0.0")


@app.middleware("http")
async def private_response_cache(request, call_next):
    response = await call_next(request)
    response.headers["Cache-Control"] = "private, no-store"
    return response


bearer = HTTPBearer(auto_error=False)
logging.getLogger("httpx").setLevel(logging.WARNING)


def error(status, code, message):
    raise HTTPException(status, detail={"code": code, "message": message})


@app.exception_handler(HTTPException)
async def http_error(_request, exc):
    detail = exc.detail if isinstance(exc.detail, dict) else {"code": "REQUEST_FAILED", "message": exc.detail}
    return JSONResponse(status_code=exc.status_code, content={"error": detail}, headers=exc.headers)


@app.exception_handler(Exception)
async def unavailable(_request, _exc):
    return JSONResponse(
        status_code=503,
        headers={"Cache-Control": "private, no-store"},
        content={
            "error": {"code": "SERVICE_UNAVAILABLE", "message": "The service is unavailable. Please try again shortly."}
        },
    )


def current_user(credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer)]):
    if not settings().configured:
        error(503, "NOT_CONFIGURED", "The download service has not been configured yet.")
    if credentials is None:
        error(401, "SIGN_IN_REQUIRED", "Start a guest session or sign in to continue.")
    with httpx.Client(timeout=15) as client:
        response = client.get(
            settings().supabase_url + "/auth/v1/user",
            headers={"apikey": settings().supabase_secret_key, "Authorization": "Bearer " + credentials.credentials},
        )
    if response.status_code >= 500 or response.status_code == 429:
        error(503, "AUTH_UNAVAILABLE", "Session verification is temporarily unavailable.")
    if response.status_code != 200:
        error(
            401, "SESSION_EXPIRED", "Your session has expired. Refresh the page, then continue as a guest or sign in."
        )
    user = response.json()
    # The Auth server verifies the signature, issuer, expiry and session; never trust decoded client claims.
    if not user.get("id"):
        error(401, "SESSION_EXPIRED", "Your session has expired. Please start again.")
    if user.get("is_anonymous") and not settings().guest_access_enabled:
        error(403, "GUEST_DISABLED", "Guest access is currently unavailable. You can sign in with an account.")
    return user


User = Annotated[dict, Depends(current_user)]


def admin(user=Depends(current_user)):
    if user.get("is_anonymous") or user.get("app_metadata", {}).get("role") != "admin":
        error(403, "ADMIN_REQUIRED", "Administrator access is required.")
    return user


def rate(user_id, action, limit):
    redis = cache()
    key = f"rate:{action}:{user_id}:{int(time.time()) // 60}"
    count = redis.eval(
        "local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],70) end; return n", 1, key
    )
    if count > limit:
        error(429, "RATE_LIMIT", "Too many requests. Please wait a minute.")


def owned(job_id, user):
    job = JobStore().job(str(job_id), user["id"])
    if not job:
        error(404, "NOT_FOUND", "Download not found.")
    return job


def public_job(job):
    return {k: v for k, v in job.items() if k not in {"format_spec", "storage_path", "idempotency_key"}}


class AnalyzeRequest(BaseModel):
    url: str = Field(max_length=4096)


class DownloadRequest(BaseModel):
    analysis_id: UUID
    format_id: str = Field(max_length=120)
    idempotency_key: UUID


class RetryRequest(BaseModel):
    idempotency_key: UUID


class ProviderRequest(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    domains: list[str] = Field(min_length=1, max_length=30)
    adapter_key: str = "yt_dlp"
    enabled: bool = True

    @field_validator("adapter_key")
    @classmethod
    def adapter(cls, value):
        if value not in {"yt_dlp", "generic", "direct"}:
            raise ValueError("Unknown adapter")
        return value

    @field_validator("domains")
    @classmethod
    def domains_valid(cls, values):
        import re

        output = []
        for value in values:
            domain = value.lower().strip().rstrip(".")
            if not re.fullmatch(r"(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}", domain):
                raise ValueError("Use hostnames only, without paths or wildcards.")
            output.append(domain)
        return sorted(set(output))


@app.get("/health")
def health():
    config = settings()
    if not config.configured:
        return JSONResponse(status_code=503, content={"status": "not_configured"})
    try:
        cache().ping()
    except Exception:
        return JSONResponse(status_code=503, content={"status": "redis_unavailable"})
    try:
        Database().rows("video_providers", select="id", limit="1", timeout=3)
    except httpx.HTTPStatusError as exc:
        status = "database_unavailable"
        if exc.response.status_code in {401, 403}:
            status = "database_auth_failed"
        elif exc.response.status_code == 404:
            try:
                code = exc.response.json().get("code")
            except (ValueError, AttributeError):
                code = None
            if code in {"PGRST205", "42P01"}:
                status = "database_schema_missing"
        return JSONResponse(status_code=503, content={"status": status})
    except Exception:
        return JSONResponse(status_code=503, content={"status": "database_unavailable"})
    try:
        workers = celery.control.inspect(timeout=1).ping()
        if not workers:
            raise RuntimeError("No workers")
    except Exception:
        return JSONResponse(status_code=503, content={"status": "worker_unavailable"})
    return {"status": "ready", "guest_access_enabled": config.guest_access_enabled}


@app.post("/api/analyze", status_code=202)
def start_analysis(body: AnalyzeRequest, request: Request, user: User):
    guest_rate(user, request, "analyze")
    rate(user["id"], "analyze", 8)
    try:
        url = validate_url(body.url)
    except UnsafeURL as exc:
        error(400, "INVALID_URL", str(exc))
    analysis_id = str(uuid4())
    key = f"analysis:{user['id']}:{analysis_id}"
    cache().setex(key, 900, json.dumps({"status": "queued"}))
    cache().setex(
        f"analysis_request:{user['id']}:{analysis_id}",
        900,
        json.dumps({"url": url, "policy": media_policy(bool(user.get("is_anonymous")))}),
    )
    analyze.apply_async(args=[user["id"], analysis_id], expires=180, argsrepr="(<redacted>)", kwargsrepr="<redacted>")
    return {"analysis_id": analysis_id, "status": "queued"}


@app.get("/api/analyze/{analysis_id}")
def analysis_result(analysis_id: UUID, user: User):
    data = cache().get(f"analysis:{user['id']}:{analysis_id}")
    if not data:
        error(404, "ANALYSIS_EXPIRED", "Please analyze the URL again.")
    result = json.loads(data)
    if result.get("formats"):
        result["formats"] = [{k: v for k, v in f.items() if not k.startswith("_")} for f in result["formats"]]
    public = {k: v for k, v in result.items() if k not in {"adapter", "policy"}}
    policy = media_policy(bool(user.get("is_anonymous")), result.get("policy"))
    public["download_limits"] = {"max_bytes": policy["max_bytes"], "max_duration": policy["max_duration"]}
    return public


@app.get("/api/analyze/{analysis_id}/thumbnail")
def analysis_thumbnail(analysis_id: UUID, user: User):
    raw = cache().get(f"analysis:{user['id']}:{analysis_id}")
    data = json.loads(raw) if raw else {}
    url = data.get("thumbnail")
    if not url:
        error(404, "NO_THUMBNAIL", "Thumbnail is unavailable.")
    validate_url(url)
    # Force the protected proxy even when running outside Docker. Limit image bytes and types.
    proxy = settings().media_proxy
    if not proxy:
        error(503, "EGRESS_NOT_CONFIGURED", "The download service's protected Internet connection is not configured.")
    with httpx.Client(proxy=proxy, trust_env=False, follow_redirects=True, max_redirects=5, timeout=12) as client:
        with client.stream("GET", url) as response:
            mime = response.headers.get("content-type", "").split(";")[0]
            if response.status_code != 200 or mime not in {"image/jpeg", "image/png", "image/webp"}:
                error(404, "NO_THUMBNAIL", "Thumbnail is unavailable.")
            content = bytearray()
            for chunk in response.iter_bytes():
                content.extend(chunk)
                if len(content) > 2 * 1024 * 1024:
                    error(413, "THUMBNAIL_TOO_LARGE", "Thumbnail is too large.")
    return Response(bytes(content), media_type=mime, headers={"Cache-Control": "private, max-age=300"})


def reserve(user, url, title, platform, spec, key):
    config = settings()
    guest = bool(user.get("is_anonymous"))
    spec = {**spec, "_policy": media_policy(guest, spec.get("_policy"))}
    try:
        job, created = JobStore().reserve(
            user_id=user["id"],
            source_url=url,
            title=title,
            platform=platform,
            spec=spec,
            key=str(key),
            max_active=min(config.max_active_jobs_per_user, config.guest_max_active_jobs)
            if guest
            else config.max_active_jobs_per_user,
            daily_limit=min(config.daily_job_quota, config.guest_daily_job_quota) if guest else config.daily_job_quota,
        )
    except ReservationError as exc:
        if str(exc) == "quota":
            error(429, "QUOTA_LIMIT", "Your active or daily download limit has been reached.")
        if str(exc) == "expired":
            error(410, "REQUEST_EXPIRED", "This request expired. Paste the link again to start a new download.")
        error(409, "IDEMPOTENCY_CONFLICT", "This request key already belongs to a different download.")
    if created:
        try:
            download.apply_async(args=[job["id"]], task_id=job["id"], expires=config.ephemeral_job_ttl_seconds)
        except Exception:
            pass  # Expiring Redis queued state is recovered by the beat outbox sweep.
    return public_job(job)


@app.post("/api/downloads", status_code=202)
def create_download(body: DownloadRequest, request: Request, user: User):
    guest_rate(user, request, "create")
    rate(user["id"], "create", 10)
    raw = cache().get(f"analysis:{user['id']}:{body.analysis_id}")
    data = json.loads(raw) if raw else {}
    if data.get("status") != "completed":
        error(400, "ANALYSIS_EXPIRED", "Please analyze the URL again.")
    spec = next((f for f in data["formats"] if f["id"] == body.format_id), None)
    if not spec:
        error(400, "INVALID_FORMAT", "Choose an available format.")
    policy = media_policy(bool(user.get("is_anonymous")), data.get("policy"))
    if policy["guest"] and (not data.get("duration") or data["duration"] > policy["max_duration"]):
        error(400, "DURATION_LIMIT", "Guest downloads require a known duration within the guest limit.")
    if (spec.get("size") or 0) > policy["max_bytes"]:
        error(413, "FILE_TOO_LARGE", "This format exceeds your download size limit.")
    return reserve(
        user, data["url"], data["title"], data["platform"], {**spec, "_policy": policy}, body.idempotency_key
    )


@app.get("/api/downloads")
def list_downloads(user: User, offset: int = 0):
    if offset < 0:
        error(400, "INVALID_PAGE", "Invalid page.")
    rows = JobStore().list(user["id"], offset=offset)
    return [public_job(row) for row in rows]


@app.get("/api/downloads/{job_id}")
def get_download(job_id: UUID, user: User):
    return public_job(owned(job_id, user))


@app.post("/api/downloads/{job_id}/cancel")
def cancel_download(job_id: UUID, user: User):
    owned(job_id, user)
    job = JobStore().cancel(str(job_id))
    if not job:
        error(404, "NOT_FOUND", "Download not found.")
    return {"status": job["status"]}


@app.post("/api/downloads/{job_id}/retry", status_code=202)
def retry_download(job_id: UUID, body: RetryRequest, request: Request, user: User):
    job = owned(job_id, user)
    if job["status"] not in {"failed", "cancelled", "expired"}:
        error(409, "NOT_RETRYABLE", "This download cannot be retried yet.")
    guest_rate(user, request, "create")
    rate(user["id"], "create", 10)
    return reserve(user, job["source_url"], job["title"], job["platform"], job["format_spec"], body.idempotency_key)


@app.get("/api/downloads/{job_id}/file")
def download_file(job_id: UUID, user: User):
    # Serialize signing/lease extension with cleanup; a new signed link cannot race deletion.
    owned(job_id, user)
    lock = cache().lock(f"job-lock:{job_id}", timeout=90, blocking_timeout=0)
    if not lock.acquire(blocking=False):
        error(409, "FILE_BUSY", "This file is being updated. Please try again shortly.")
    try:
        job = owned(job_id, user)
        if job["status"] != "completed" or not job.get("storage_path"):
            error(409, "FILE_NOT_READY", "This file is not ready.")
        if datetime.fromisoformat(job["expires_at"].replace("Z", "+00:00")) <= datetime.now(timezone.utc):
            error(410, "FILE_EXPIRED", "This file has expired. Paste the link again to create another download.")
        hard_expiry = temporary_path_expiry(job["storage_path"], user["id"], str(job_id))
        if not hard_expiry:
            error(403, "FILE_FORBIDDEN", "File access denied.")
        config, now = settings(), time.time()
        lease_end = now + config.signed_url_ttl_seconds + config.download_transfer_grace_seconds
        if lease_end > hard_expiry:
            error(410, "FILE_EXPIRED", "This temporary file is expiring. Please create another download.")
        filename = download_filename(
            job.get("title"), job.get("output_extension") or job["storage_path"].rsplit(".", 1)[-1]
        )
        JobStore().extend_file(str(job_id), lease_end)
        return {
            "url": Database().signed_url(job["storage_path"], filename),
            "filename": filename,
            "expires_in": config.signed_url_ttl_seconds,
        }
    finally:
        try:
            lock.release()
        except Exception:
            pass


@app.delete("/api/downloads/{job_id}")
def delete_download(job_id: UUID, user: User):
    owned(job_id, user)
    lock = cache().lock(f"job-lock:{job_id}", timeout=90, blocking_timeout=0)
    if not lock.acquire(blocking=False):
        error(409, "WORKER_STOPPING", "The file is being updated. Try removing it again shortly.")
    try:
        job = owned(job_id, user)
        if job["status"] in {"queued", "downloading", "processing", "uploading"}:
            error(409, "CANCEL_FIRST", "Cancel the active download first.")
        # Forget source metadata immediately, retaining the opaque deletion lease.
        # Existing signed browser transfers remain valid until scheduled cleanup.
        JobStore().forget(str(job_id))
        return {"deleted": True}
    finally:
        try:
            lock.release()
        except Exception:
            pass


@app.get("/api/providers")
def providers(user: User):
    return Database().rows("video_providers", order="name.asc")


@app.post("/api/providers")
def create_provider(body: ProviderRequest, _user=Depends(admin)):
    return Database().insert("video_providers", {**body.model_dump(), "support_status": "untested"})[0]


@app.put("/api/providers/{provider_id}")
def update_provider(provider_id: UUID, body: ProviderRequest, _user=Depends(admin)):
    rows = Database().patch(
        "video_providers",
        {"id": f"eq.{provider_id}"},
        {
            **body.model_dump(),
            "support_status": "untested",
            "last_checked_at": None,
            "updated_at": datetime.now(timezone.utc).isoformat(),
        },
    )
    if not rows:
        error(404, "NOT_FOUND", "Provider not found.")
    return rows[0]


@app.post("/api/providers/{provider_id}/test", status_code=202)
def test_provider(provider_id: UUID, body: AnalyzeRequest, user=Depends(admin)):
    from urllib.parse import urlsplit

    rate(user["id"], "analyze", 8)
    rows = Database().rows("video_providers", id=f"eq.{provider_id}", limit="1")
    if not rows:
        error(404, "NOT_FOUND", "Provider not found.")
    url = validate_url(body.url)
    host = urlsplit(url).hostname.lower().rstrip(".")
    if not any(host == domain or host.endswith("." + domain) for domain in rows[0]["domains"]):
        error(400, "WRONG_PROVIDER", "Use a URL belonging to this provider.")
    analysis_id = str(uuid4())
    cache().setex(f"analysis:{user['id']}:{analysis_id}", 900, json.dumps({"status": "queued"}))
    cache().setex(
        f"analysis_request:{user['id']}:{analysis_id}", 900, json.dumps({"url": url, "provider_test": rows[0]})
    )
    analyze.apply_async(args=[user["id"], analysis_id], expires=180, argsrepr="(<redacted>)", kwargsrepr="<redacted>")
    return {"analysis_id": analysis_id, "status": "queued"}


# Wrap the complete ASGI app so unhandled failures retain exact-origin CORS headers.
api_app = app
app = CORSMiddleware(
    api_app,
    allow_origins=[s.strip() for s in settings().allowed_origins.split(",")],
    allow_methods=["GET", "POST", "DELETE", "PUT"],
    allow_headers=["Authorization", "Content-Type", "Idempotency-Key"],
    expose_headers=["Retry-After"],
)
