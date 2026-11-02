"""Expiring, owner-scoped job state. No download metadata is written to Postgres.

Lua reservations and transitions are atomic across API/worker replicas. The opaque
file-removal ledger deliberately survives a job's TTL until deletion succeeds;
Storage also carries a hard expiry marker for recovery after complete Redis loss.
"""

import hashlib
import json
import time
from datetime import datetime, timezone
from uuid import uuid4

from .config import settings
from .queue import cache

ACTIVE = {"queued", "downloading", "processing", "uploading"}
STATUSES = ACTIVE | {"completed", "cancelled", "failed", "expired"}

RESERVE = """
local previous=redis.call('GET',KEYS[2])
if previous then
 local ref=cjson.decode(previous)
 if ref.fingerprint ~= ARGV[5] then return {'conflict',''} end
 local existing=redis.call('GET','yd:job:'..ref.id)
 if existing then return {'existing',existing} end
 return {'expired',''}
end
redis.call('ZREMRANGEBYSCORE',KEYS[3],'-inf',ARGV[1])
if redis.call('ZCARD',KEYS[3]) >= tonumber(ARGV[6]) or tonumber(redis.call('GET',KEYS[4]) or '0') >= tonumber(ARGV[7]) then
 return {'quota',''}
end
redis.call('SET',KEYS[1],ARGV[4],'EX',ARGV[3])
redis.call('SET',KEYS[2],cjson.encode({id=ARGV[2],fingerprint=ARGV[5]}),'EX',ARGV[3])
redis.call('ZADD',KEYS[3],ARGV[8],ARGV[2])
redis.call('EXPIRE',KEYS[3],ARGV[3])
local n=redis.call('INCR',KEYS[4]); if n == 1 then redis.call('EXPIRE',KEYS[4],ARGV[9]) end
redis.call('ZADD',KEYS[5],ARGV[1],ARGV[2]); redis.call('EXPIRE',KEYS[5],ARGV[3])
redis.call('ZADD','yd:status:queued',ARGV[1],ARGV[2]); redis.call('EXPIRE','yd:status:queued',math.max(tonumber(ARGV[3]),redis.call('TTL','yd:status:queued')))
return {'created',ARGV[4]}
"""

UPDATE = """
local raw=redis.call('GET',KEYS[1]); if not raw then return '' end
local job=cjson.decode(raw); local delta=cjson.decode(ARGV[1]); local old=job.status
if (old=='cancelled' or old=='expired' or old=='failed') and delta.status ~= old then return '' end
if old=='completed' and delta.status and delta.status~='completed' and delta.status~='expired' then return '' end
for k,v in pairs(delta) do job[k]=v end
redis.call('SET',KEYS[1],cjson.encode(job),'KEEPTTL')
redis.call('ZREM','yd:status:'..old,job.id)
redis.call('ZADD','yd:status:'..job.status,ARGV[2],job.id)
redis.call('EXPIRE','yd:status:'..job.status,math.max(1,redis.call('TTL',KEYS[1]),redis.call('TTL','yd:status:'..job.status)))
if job.status~='queued' and job.status~='downloading' and job.status~='processing' and job.status~='uploading' then
 redis.call('ZREM','yd:active:'..job.user_id,job.id)
end
return cjson.encode(job)
"""

CANCEL = """
local raw=redis.call('GET',KEYS[1]); if not raw then return '' end
local job=cjson.decode(raw)
if job.status=='queued' or job.status=='downloading' or job.status=='processing' or job.status=='uploading' then
 redis.call('ZREM','yd:status:'..job.status,job.id)
 job.status='cancelled'; job.updated_at=ARGV[1]
 redis.call('SET',KEYS[1],cjson.encode(job),'KEEPTTL')
 redis.call('ZADD','yd:status:cancelled',ARGV[2],job.id)
 redis.call('EXPIRE','yd:status:cancelled',math.max(1,redis.call('TTL',KEYS[1]),redis.call('TTL','yd:status:cancelled')))
 redis.call('ZREM','yd:active:'..job.user_id,job.id)
 redis.call('SET','cancel:'..job.id,'1','EX',ARGV[3])
end
return cjson.encode(job)
"""


class ReservationError(Exception):
    pass


def utcnow():
    return datetime.now(timezone.utc).isoformat()


class JobStore:
    def __init__(self, redis=None):
        self.redis = redis if redis is not None else cache()

    def job(self, job_id, user_id=None):
        raw = self.redis.get(f"yd:job:{job_id}")
        job = json.loads(raw) if raw else None
        return job if job and (user_id is None or job["user_id"] == user_id) else None

    def reserve(self, *, user_id, source_url, title, platform, spec, key, max_active, daily_limit):
        config, now = settings(), time.time()
        policy = spec.get("_policy", {})
        ttl = max(
            config.ephemeral_job_ttl_seconds,
            config.job_timeout_seconds + 1080 + policy.get("retention_seconds", 3600) + 600,
        )
        job_id, created = str(uuid4()), utcnow()
        job = {
            "id": job_id,
            "user_id": user_id,
            "source_url": source_url,
            "title": title,
            "platform": platform,
            "format_spec": spec,
            "selected_format": spec.get("label", "Video"),
            "output_type": spec.get("kind", "video"),
            "status": "queued",
            "progress": None,
            "storage_path": None,
            "expires_at": None,
            "file_size": None,
            "error_code": None,
            "created_at": created,
            "updated_at": created,
        }
        fingerprint = hashlib.sha256(json.dumps({"url": source_url, "spec": spec}, sort_keys=True).encode()).hexdigest()
        day = int(now) // 86400
        result, value = self.redis.eval(
            RESERVE,
            5,
            f"yd:job:{job_id}",
            f"yd:request:{user_id}:{key}",
            f"yd:active:{user_id}",
            f"yd:daily:{user_id}:{day}",
            f"yd:user:{user_id}:jobs",
            now,
            job_id,
            ttl,
            json.dumps(job),
            fingerprint,
            max_active,
            daily_limit,
            now + config.job_timeout_seconds + 1080,
            86400 - int(now) % 86400,
        )
        if result not in {"created", "existing"}:
            raise ReservationError(result)
        return json.loads(value), result == "created"

    def by_key(self, user_id, key):
        raw = self.redis.get(f"yd:request:{user_id}:{key}")
        return self.job(json.loads(raw)["id"], user_id) if raw else None

    def update_job(self, job_id, **fields):
        immutable = {"id", "user_id", "created_at"}
        if immutable.intersection(fields) or fields.get("status", "queued") not in STATUSES:
            raise ValueError("Invalid job transition")
        fields["updated_at"] = utcnow()
        value = self.redis.eval(UPDATE, 1, f"yd:job:{job_id}", json.dumps(fields), time.time())
        return [json.loads(value)] if value else []

    def cancel(self, job_id):
        config = settings()
        raw = self.redis.eval(CANCEL, 1, f"yd:job:{job_id}", utcnow(), time.time(), config.job_timeout_seconds + 1080)
        return json.loads(raw) if raw else None

    def list(self, user_id, offset=0):
        index = f"yd:user:{user_id}:jobs"
        # Index contains only opaque IDs; prune expired entries without unbounded rendering.
        ids = self.redis.zrevrange(index, offset, offset + 29)
        result = []
        for jid in ids:
            job = self.job(jid, user_id)
            if job:
                result.append(job)
            else:
                self.redis.zrem(index, jid)
        return result

    def scan(self, statuses=None, before=None, limit=100):
        cutoff = datetime.fromisoformat(before.replace("Z", "+00:00")).timestamp() if before else "+inf"
        result = []
        for status in sorted(statuses or STATUSES):
            index = f"yd:status:{status}"
            for jid in self.redis.zrangebyscore(index, "-inf", cutoff, start=0, num=limit):
                job = self.job(jid)
                if job and job["status"] == status:
                    result.append(job)
                else:
                    self.redis.zrem(index, jid)
        return sorted(result, key=lambda job: job["updated_at"])[:limit]

    def forget(self, job_id):
        job = self.job(job_id)
        if not job:
            return False
        with self.redis.pipeline() as pipe:
            pipe.delete(f"yd:job:{job_id}", f"cancel:{job_id}")
            pipe.zrem(f"yd:user:{job['user_id']}:jobs", job_id)
            pipe.zrem(f"yd:active:{job['user_id']}", job_id)
            for status in STATUSES:
                pipe.zrem(f"yd:status:{status}", job_id)
            pipe.execute()
        return True

    def track_file(self, job_id, path, delete_after_epoch):
        # This index stores no source/title. Retain failed cleanup pointers until deletion succeeds.
        self.redis.zadd("yd:files", {json.dumps([str(job_id), path]): float(delete_after_epoch)})

    def due_files(self, now, limit=100):
        return [
            tuple(json.loads(item)) for item in self.redis.zrangebyscore("yd:files", "-inf", now, start=0, num=limit)
        ]

    def untrack_file(self, job_id, path):
        self.redis.zrem("yd:files", json.dumps([str(job_id), path]))

    def extend_file(self, job_id, delete_after_epoch):
        # Only one opaque storage path is owned by a job. XX prevents resurrection after cleanup.
        job = self.job(job_id)
        if job and job.get("storage_path"):
            self.redis.zadd(
                "yd:files",
                {json.dumps([str(job_id), job["storage_path"]]): float(delete_after_epoch)},
                xx=True,
                gt=True,
            )

    def file_due(self, job_id, path, now):
        score = self.redis.zscore("yd:files", json.dumps([str(job_id), path]))
        return score is not None and score <= now

    def prune_indices(self, limit=100):
        # Every status (including expired) is swept. Missing records cannot leave
        # permanent opaque index members in a continuously busy Redis instance.
        for status in STATUSES:
            index = f"yd:status:{status}"
            for jid in self.redis.zrange(index, 0, limit - 1):
                job = self.job(jid)
                if not job or job["status"] != status:
                    self.redis.zrem(index, jid)
