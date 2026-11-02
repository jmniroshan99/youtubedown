from unittest.mock import patch

import httpx
import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.db import Database
from app.main import api_app, app, current_user


@pytest.mark.parametrize("origin", ["http://localhost:5173", "http://127.0.0.1:5173", "https://not-allowed.example"])
def test_unhandled_failure_retains_cors_and_private_cache_policy(origin):
    api_app.dependency_overrides[current_user] = lambda: {"id": "test-owner"}
    try:
        with patch("app.main.Database") as db, TestClient(app, raise_server_exceptions=False) as client:
            db.return_value.rows.side_effect = RuntimeError("private failure details")
            response = client.get("/api/downloads", headers={"Origin": origin})
        assert response.status_code == 503
        assert response.headers["cache-control"] == "private, no-store"
        assert response.headers.get("access-control-allow-origin") == (origin if origin.startswith("http:") else None)
        assert "private failure details" not in response.text
        assert response.json()["error"]["code"] == "SERVICE_UNAVAILABLE"
    finally:
        api_app.dependency_overrides.clear()


@pytest.mark.parametrize(
    "status,code,expected",
    [
        (401, None, "database_auth_failed"),
        (403, None, "database_auth_failed"),
        (404, "PGRST205", "database_schema_missing"),
        (404, "OTHER", "database_unavailable"),
    ],
)
def test_health_distinguishes_configuration_failures(status, code, expected):
    response = httpx.Response(
        status,
        json={"code": code, "message": "private detail"},
        request=httpx.Request("GET", "https://test.supabase.co/rest/v1/video_providers"),
    )
    with (
        patch("app.main.settings", return_value=Settings(supabase_secret_key="sb_secret_test_only_not_a_real_key")),
        patch("app.main.cache"),
        patch("app.main.Database") as db,
        TestClient(app) as client,
    ):
        db.return_value.rows.side_effect = httpx.HTTPStatusError("failure", request=response.request, response=response)
        result = client.get("/health")
        assert result.status_code == 503
        assert result.json() == {"status": expected}
        assert db.return_value.rows.call_args.kwargs["timeout"] == 3


def test_database_health_timeout_is_not_sent_as_a_database_filter():
    with patch("app.db.httpx.Client") as client:
        client.return_value.__enter__.return_value.request.return_value.content = b"[]"
        Database().rows("video_providers", timeout=3, select="id", limit="1")
        client.assert_called_once_with(timeout=3)
        assert client.return_value.__enter__.return_value.request.call_args.kwargs["params"] == {
            "select": "id",
            "limit": "1",
        }
