from celery import Celery
from redis import Redis

from .config import settings

celery = Celery("videoflow", broker=settings().redis_url, backend=settings().redis_url, include=["app.tasks"])
celery.conf.update(
    task_serializer="json",
    result_serializer="json",
    accept_content=["json"],
    timezone="UTC",
    task_track_started=False,
    task_ignore_result=True,
    task_store_errors_even_if_ignored=False,
    worker_send_task_events=False,
    task_send_sent_event=False,
    worker_prefetch_multiplier=1,
    task_acks_late=True,
    task_reject_on_worker_lost=True,
    broker_connection_timeout=3,
    broker_transport_options={
        "visibility_timeout": settings().job_timeout_seconds + 1200,
        "socket_connect_timeout": 3,
        "socket_timeout": 3,
    },
    task_time_limit=settings().job_timeout_seconds + 900,
    result_expires=300,
    beat_schedule={"cleanup": {"task": "app.tasks.cleanup", "schedule": 60.0}},
)


def cache():
    return Redis.from_url(settings().redis_url, decode_responses=True, socket_connect_timeout=3, socket_timeout=3)
