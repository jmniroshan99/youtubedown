import subprocess
import sys
from unittest.mock import patch

import pytest

from app.config import Settings
from app.tasks import MediaFailure, run_media


def test_cancel_kills_process_and_cleans_directory(tmp_path):
    real_popen = subprocess.Popen
    children = []

    def child(_args, **kwargs):
        process = real_popen([sys.executable, "-c", "import time; time.sleep(60)"], **kwargs)
        children.append(process)
        return process

    config = Settings(temp_root=str(tmp_path), media_proxy="http://egress:8080")
    with patch("app.tasks.settings", return_value=config), patch("app.tasks.subprocess.Popen", side_effect=child):
        with pytest.raises(MediaFailure, match="CANCELLED"):
            run_media({"mode": "analyze", "url": "https://example.com/v"}, cancelled=lambda: True)
    assert children[0].poll() is not None
    assert list(tmp_path.iterdir()) == []


def test_media_child_never_inherits_server_secret_or_parent_ca_overrides(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPABASE_SECRET_KEY", "do-not-inherit")
    monkeypatch.setenv("SSL_CERT_FILE", "/run/server-only-ca.pem")
    monkeypatch.setenv("SSL_CERT_DIR", "/run/server-only-ca-directory")
    real_popen = subprocess.Popen
    captured = {}

    def child(_args, **kwargs):
        captured.update(kwargs["env"])
        return real_popen([sys.executable, "-c", 'print(\'{"type":"result","data":{"ok":true}}\')'], **kwargs)

    config = Settings(temp_root=str(tmp_path), media_proxy="http://egress:8080")
    with patch("app.tasks.settings", return_value=config), patch("app.tasks.subprocess.Popen", side_effect=child):
        assert run_media({"mode": "analyze", "url": "https://example.com/v"}) == {"ok": True}
    assert "SUPABASE_SECRET_KEY" not in captured
    assert "SSL_CERT_FILE" not in captured
    assert "SSL_CERT_DIR" not in captured
    assert captured["HTTPS_PROXY"] == "http://egress:8080"


def test_missing_egress_fails_closed(tmp_path):
    with patch("app.tasks.settings", return_value=Settings(temp_root=str(tmp_path), media_proxy="")):
        with pytest.raises(MediaFailure, match="EGRESS_NOT_CONFIGURED"):
            run_media({"mode": "analyze", "url": "https://example.com/v"})


def test_guest_limits_are_written_to_the_sanitized_child_request(tmp_path):
    import json
    from pathlib import Path

    from app.guest import media_policy

    real_popen = subprocess.Popen
    captured = {}

    def child(args, **kwargs):
        captured.update(json.loads(Path(args[-1]).read_text()))
        return real_popen([sys.executable, "-c", 'print(\'{"type":"result","data":{"ok":true}}\')'], **kwargs)

    config = Settings(temp_root=str(tmp_path), media_proxy="http://egress:8080")
    with patch("app.tasks.settings", return_value=config), patch("app.tasks.subprocess.Popen", side_effect=child):
        run_media({"mode": "analyze", "url": "https://example.com/v", "policy": media_policy(True)})
    assert captured["max_bytes"] == 100 * 1024 * 1024
    assert captured["max_duration"] == 7200
    assert captured["require_duration"] is True
