from datetime import datetime, timedelta, timezone
from unittest.mock import patch
from uuid import uuid4

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from app.main import admin, api_app, app, current_user

USER_A = {"id": str(uuid4()), "app_metadata": {}, "user_metadata": {"role": "admin"}}
USER_B = str(uuid4())
JOB = str(uuid4())


@pytest.fixture
def client():
    api_app.dependency_overrides[current_user] = lambda: USER_A
    with TestClient(app, raise_server_exceptions=False) as test:
        yield test
    api_app.dependency_overrides.clear()


def test_users_cannot_self_assign_admin():
    with pytest.raises(HTTPException) as raised:
        admin(USER_A)
    assert raised.value.status_code == 403


def test_admin_role_must_be_server_owned():
    assert admin({"app_metadata": {"role": "admin"}})["app_metadata"]["role"] == "admin"


@pytest.mark.parametrize(
    "method,suffix", [("get", ""), ("get", "/file"), ("post", "/cancel"), ("post", "/retry"), ("delete", "")]
)
def test_cross_user_access_is_hidden(client, method, suffix):
    def find(job_id, user_id=None):
        return {"id": JOB, "user_id": USER_B} if user_id == USER_B else None

    with patch("app.main.JobStore.job", side_effect=find) as lookup:
        kwargs = {"json": {"idempotency_key": str(uuid4())}} if suffix == "/retry" else {}
        response = getattr(client, method)(f"/api/downloads/{JOB}" + suffix, **kwargs)
        assert response.status_code == 404
        lookup.assert_called_once_with(JOB, USER_A["id"])


def test_expired_files_do_not_receive_signed_urls(client):
    job = {
        "id": JOB,
        "user_id": USER_A["id"],
        "status": "completed",
        "storage_path": f"{USER_A['id']}/{JOB}/video.mp4",
        "expires_at": (datetime.now(timezone.utc) - timedelta(seconds=10)).isoformat(),
    }
    with (
        patch("app.main.JobStore.job", return_value=job),
        patch("app.main.Database.signed_url") as sign,
        patch("app.main.cache"),
    ):
        assert client.get(f"/api/downloads/{JOB}/file").status_code == 410
        sign.assert_not_called()


def test_storage_path_ownership_is_checked(client):
    job = {
        "id": JOB,
        "status": "completed",
        "storage_path": f"{USER_B}/{JOB}/video.mp4",
        "expires_at": (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat(),
    }
    with (
        patch("app.main.JobStore.job", return_value=job),
        patch("app.main.Database.signed_url") as sign,
        patch("app.main.cache"),
    ):
        assert client.get(f"/api/downloads/{JOB}/file").status_code == 403
        sign.assert_not_called()


def test_missing_server_key_is_explicit():
    with patch("app.main.settings") as config:
        config.return_value.configured = False
        with TestClient(app) as test:
            assert test.get("/health").json()["status"] == "not_configured"


def test_invalid_format_cannot_be_queued(client):
    with patch("app.main.rate"), patch("app.main.cache") as redis:
        redis.return_value.get.return_value = '{"status":"completed","formats":[]}'
        response = client.post(
            "/api/downloads",
            json={"analysis_id": str(uuid4()), "format_id": "injected", "idempotency_key": str(uuid4())},
        )
        assert response.status_code == 400
        assert response.json()["error"]["code"] == "INVALID_FORMAT"
