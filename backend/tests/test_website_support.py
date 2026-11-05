"""Offline provider fixtures: no source accounts, cookies, challenges or adult media."""

import io
import json
import ssl
from pathlib import Path
from unittest.mock import patch
from urllib.parse import urlsplit
from uuid import uuid4

import fakeredis
import httpx
import pytest
import yt_dlp
from fastapi.testclient import TestClient
from yt_dlp.extractor.common import InfoExtractor
from yt_dlp.extractor.xhamster import XHamsterEmbedIE, XHamsterIE
from yt_dlp.networking.common import Response
from yt_dlp.networking.exceptions import CertificateVerifyError, TransportError
from yt_dlp.utils import DownloadError, ExtractorError

from app import main, tasks
from app.extract import normalize, probe_direct
from app.media_errors import media_error_code
from app.media_runtime import YT_DLP_VERSION, PornHubIE, PublicYoutubeDL, extractor_url, verify_runtime

FIXTURES = [
    ("https://www.pornhub.com/view_video.php?viewkey=ph0123456789a", "PornHub"),
    ("https://de.pornhub.com/view_video.php?viewkey=ph0123456789a&t=1", "PornHub"),
    ("https://m.pornhub.org/embed/ph0123456789a", "PornHub"),
    ("https://www.pornhub.net/video/show?viewkey=ph0123456789a", "PornHub"),
    ("https://xhamster.com/videos/public-fixture-x012abc", "XHamster"),
    ("https://m.xhamster.com/videos/public-fixture-x012abc", "XHamster"),
    ("https://de.xhamster.one/movies/123456/fixture.html", "XHamster"),
    ("https://xhamster.desi/videos/public-fixture-x012abc", "XHamster"),
    ("https://xhvid.com/videos/public-fixture-x012abc", "XHamster"),
    ("https://xhamster.com/xembed.php?video=123456", "XHamsterEmbed"),
]


@pytest.mark.parametrize(
    "failure",
    [
        CertificateVerifyError("private provider URL and certificate details"),
        ssl.SSLCertVerificationError(1, "private certificate issuer"),
        TransportError("private transport diagnostics", cause=ssl.SSLCertVerificationError(1, "private issuer")),
    ],
)
def test_certificate_failures_are_specific_even_inside_wrapped_transport_errors(failure):
    extraction = ExtractorError("private source URL", cause=failure)
    wrapped = DownloadError("private source diagnostics", exc_info=(type(extraction), extraction, None))
    assert media_error_code(wrapped) == "SOURCE_TLS_ERROR"


@pytest.mark.parametrize(("url", "key"), FIXTURES)
@pytest.mark.parametrize("adapter", ["yt_dlp", "generic", "direct"])
def test_actual_pinned_extractor_routing(url, key, adapter, monkeypatch):
    # Inspect the exact engine options emitted by the application's entry point.
    from app import extract

    captured = {}

    class Engine(PublicYoutubeDL):
        def extract_info(self, url, download=False, **kwargs):
            assert not download
            assert not self.params.get("force_generic_extractor")
            captured["key"] = next(ie.ie_key() for ie in self._ies.values() if ie.suitable(url))
            return {"formats": [{"format_id": "720p", "ext": "mp4", "vcodec": "h264", "acodec": "aac"}]}

    monkeypatch.setattr(extract, "PublicYoutubeDL", Engine)
    monkeypatch.setattr(extract, "emit", lambda _: None)
    extract.main(
        {
            "mode": "analyze",
            "adapter": adapter,
            "url": url,
            "proxy": "http://egress:8080",
            "max_bytes": 100000,
            "max_duration": 60,
        }
    )
    assert captured["key"] == key


def test_deceptive_domains_do_not_match_dedicated_extractors():
    for url in [
        "https://pornhub.com.evil.example/view_video.php?viewkey=ph123",
        "https://xhamster.com.evil.example/videos/fixture-123",
    ]:
        assert not PornHubIE.suitable(url)
        assert not XHamsterIE.suitable(url)
        assert not XHamsterEmbedIE.suitable(url)


@pytest.mark.parametrize(
    ("url", "key"),
    [
        ("https://WWW.PORNHUB.COM:443/view_video.php?utm_source=share&viewkey=ph0123456789a#player", "PornHub"),
        ("https://xhamster.com/xembed.php?autoplay=0&video=123456", "XHamsterEmbed"),
        ("https://M.XHAMSTER.COM:443/videos/public-fixture-x012abc", "XHamster"),
    ],
)
def test_share_link_normalization_reaches_dedicated_extractor(url, key):
    with PublicYoutubeDL({"quiet": True, "cachedir": False}) as dl:
        canonical = extractor_url(url)
        assert next(ie.ie_key() for ie in dl._ies.values() if ie.suitable(canonical)) == key
        with patch.object(yt_dlp.YoutubeDL, "extract_info", return_value={}) as upstream:
            dl.extract_info(url, download=False)
        upstream.assert_called_once_with(canonical, download=False)
    assert urlsplit(canonical).hostname == urlsplit(url).hostname.lower()


def test_pin_is_identical_in_both_lockfiles_and_runtime():
    verify_runtime()
    root = Path(__file__).resolve().parents[1]
    assert f"yt-dlp[default]=={YT_DLP_VERSION}" in (root / "requirements.in").read_text()
    for name in ["requirements.txt", "requirements-dev.txt"]:
        assert f"yt-dlp=={YT_DLP_VERSION}\n" in (root / name).read_text()
    with patch("app.media_runtime.__version__", "unexpected"):
        with pytest.raises(ValueError, match="EXTRACTOR_VERSION_MISMATCH"):
            verify_runtime()


def test_pornhub_never_sets_age_verification_cookies():
    with PublicYoutubeDL({"quiet": True, "cachedir": False}) as dl:
        ie = dl.get_info_extractor("PornHub")
        assert isinstance(ie, PornHubIE)
        ie._set_age_cookies("pornhub.com")
        assert not list(dl.cookiejar)


@pytest.mark.parametrize(
    ("page", "code"),
    [
        ('<body onload="go()">', "SOURCE_BLOCKED"),
        ('<script>document.cookie="RNKEY=secret";</script>', "SOURCE_BLOCKED"),
        ("<h1>Verify your age</h1>", "AGE_RESTRICTED"),
    ],
)
def test_pornhub_challenges_stop_without_solver(page, code):
    with patch.object(InfoExtractor, "_download_webpage_handle", return_value=(page, object())):
        with pytest.raises(ExtractorError) as error:
            PornHubIE()._download_webpage_handle("https://www.pornhub.com/", "fixture")
    assert media_error_code(error.value) == code


@pytest.mark.parametrize("key", ["PornHub", "XHamster"])
def test_dedicated_extraction_path_uses_fixture_page_and_real_format_processing(key):
    # Mock only the extractor's page parser. Dispatch and yt-dlp processing are real.
    url = next(url for url, expected in FIXTURES if expected == key)
    with PublicYoutubeDL({"quiet": True, "cachedir": False, "skip_download": True}) as dl:
        ie = dl.get_info_extractor(key)
        with patch.object(
            ie,
            "_real_extract",
            return_value={
                "id": "fixture",
                "title": "Public fixture",
                "duration": 2,
                "formats": [
                    {
                        "format_id": "720p",
                        "url": "https://cdn.example.com/fixture.mp4",
                        "ext": "mp4",
                        "vcodec": "h264",
                        "acodec": "aac",
                        "height": 720,
                    }
                ],
            },
        ) as parser:
            result = normalize(dl.extract_info(url, download=False))
    parser.assert_called_once_with(url)
    assert result["platform"] == key
    assert result["formats"][0]["has_audio"] is True
    assert result["formats"][0]["_selector"] == "720p"


def test_single_generic_embed_is_processed_but_multiple_entries_are_rejected_before_download():
    entry = {"id": "fixture", "title": "Fixture", "url": "https://cdn.example.com/fixture.mp4", "ext": "mp4"}
    with PublicYoutubeDL({"quiet": True, "cachedir": False}) as dl:
        result = dl.process_ie_result(
            {"_type": "playlist", "extractor_key": "Generic", "entries": [entry]}, download=False
        )
        assert result["id"] == "fixture"
        with patch.object(dl, "process_video_result") as download:
            with pytest.raises(ValueError, match="PLAYLIST_UNSUPPORTED"):
                dl.process_ie_result({"_type": "multi_video", "entries": [entry, entry]}, download=True)
            download.assert_not_called()


def test_disabled_embedded_and_redirected_sources_fail_closed():
    rules = [{"domains": ["disabled.example.com"], "enabled": False}]
    with PublicYoutubeDL({"quiet": True}, rules) as dl:
        with pytest.raises(ValueError, match="SOURCE_DISABLED"):
            dl.extract_info("https://disabled.example.com/video")
        response = Response(io.BytesIO(b""), url="https://disabled.example.com/video", headers={})
        with patch.object(yt_dlp.YoutubeDL, "urlopen", return_value=response):
            with pytest.raises(ValueError, match="SOURCE_DISABLED"):
                dl.urlopen("https://public.example.com/redirect")
        assert response.closed


def test_probe_checks_each_unknown_progressive_format_and_preserves_playback_headers():
    info = {
        "http_headers": {"Referer": "https://page.example/", "Cookie": "secret"},
        "formats": [
            {"format_id": str(height), "ext": "mp4", "url": f"https://cdn.example/{height}.mp4", "height": height}
            for height in [360, 720]
        ],
    }
    with patch("app.extract.subprocess.run") as probe:
        probe.return_value.stdout = json.dumps(
            {
                "streams": [
                    {"codec_type": "video", "codec_name": "h264"},
                    {"codec_type": "audio", "codec_name": "aac"},
                ],
                "format": {"duration": "2"},
            }
        ).encode()
        probe_direct(info, "http://egress:8080")
    assert probe.call_count == 2
    assert all("Cookie" not in " ".join(call.args[0]) for call in probe.call_args_list)
    assert all("Referer: https://page.example/\r\n" in call.args[0] for call in probe.call_args_list)
    assert all(f["has_audio"] for f in normalize(info)["formats"] if f["kind"] == "video")


def test_audio_and_merge_selectors_cannot_fall_back_to_drm_or_another_quality():
    info = normalize(
        {
            "formats": [
                {"format_id": "v", "ext": "mp4", "vcodec": "h264", "acodec": "none", "height": 720},
                {"format_id": "clear", "ext": "m4a", "vcodec": "none", "acodec": "aac"},
                {"format_id": "protected", "ext": "m4a", "vcodec": "none", "acodec": "aac", "has_drm": True},
            ]
        }
    )
    assert info["formats"][0]["_selector"] == "v+clear"
    assert {f["_selector"] for f in info["formats"] if f["kind"] == "audio"} == {"clear"}
    assert next(f for f in info["formats"] if f["id"] == "audio-original")["ext"] == "m4a"


@pytest.mark.parametrize(
    ("message", "code"),
    [
        ("Age verification required", "AGE_RESTRICTED"),
        ("Video is locked", "LOGIN_REQUIRED"),
        ("Subscription required", "PAYWALL_RESTRICTED"),
        ("Too many requests", "SOURCE_RATE_LIMITED"),
    ],
)
def test_safe_restriction_errors(message, code):
    error = ExtractorError(message + " https://source.example/?token=private")
    assert media_error_code(DownloadError("private diagnostics", exc_info=(type(error), error, None))) == code


def test_backend_outage_is_not_reported_as_extractor_failure():
    uid, aid = str(uuid4()), str(uuid4())
    redis = fakeredis.FakeRedis(decode_responses=True)
    with (
        patch("app.tasks.cache", return_value=redis),
        patch("app.tasks.select_provider", side_effect=httpx.ConnectError("secret")),
    ):
        tasks.analyze.run(uid, aid, "https://public.example.com/v")
    assert json.loads(redis.get(f"analysis:{uid}:{aid}")) == {
        "status": "failed",
        "error_code": "SERVICE_UNAVAILABLE",
        "error_stage": "analysis",
    }


def test_administrator_source_test_also_respects_disabled_source():
    uid, aid = str(uuid4()), str(uuid4())
    redis = fakeredis.FakeRedis(decode_responses=True)
    with (
        patch("app.tasks.cache", return_value=redis),
        patch("app.tasks.Database"),
        patch("app.tasks.run_media") as media,
    ):
        tasks.analyze.run(
            uid,
            aid,
            "https://public.example.com/v",
            provider_test={
                "id": "fixture",
                "enabled": False,
                "adapter_key": "yt_dlp",
            },
        )
    media.assert_not_called()
    assert json.loads(redis.get(f"analysis:{uid}:{aid}"))["error_code"] == "SOURCE_DISABLED"


def test_public_analysis_hides_provider_signed_urls_and_private_selectors():
    uid, aid = str(uuid4()), str(uuid4())
    redis = fakeredis.FakeRedis(decode_responses=True)
    redis.setex(
        f"analysis:{uid}:{aid}",
        900,
        json.dumps(
            {
                "status": "completed",
                "thumbnail": "https://cdn.example/?token=private",
                "url": "https://source.example/?secret=private",
                "adapter": "yt_dlp",
                "policy": {},
                "formats": [{"id": "video-0", "_selector": "private"}],
            }
        ),
    )
    main.api_app.dependency_overrides[main.current_user] = lambda: {"id": uid}
    try:
        with patch("app.main.cache", return_value=redis), TestClient(main.app) as client:
            response = client.get(f"/api/analyze/{aid}")
        assert response.status_code == 200
        assert "private" not in response.text
        assert response.json()["formats"] == [{"id": "video-0"}]
    finally:
        main.api_app.dependency_overrides.clear()
