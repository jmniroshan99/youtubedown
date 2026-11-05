import pytest

from app.extract import normalize


def test_available_formats_only_and_audio_merge():
    result = normalize(
        {
            "title": "Test",
            "formats": [
                {"format_id": "v", "vcodec": "avc1", "acodec": "none", "ext": "mp4", "height": 720},
                {"format_id": "a", "vcodec": "none", "acodec": "aac", "ext": "m4a"},
            ],
        }
    )
    video = result["formats"][0]
    assert video["height"] == 720
    assert video["merging"] is True
    assert video["_selector"] == "v+a"
    assert not any(f.get("height") == 1080 for f in result["formats"])
    assert any(f["id"] == "audio-mp3" for f in result["formats"])


def test_direct_unknown_streams_remain_honest():
    result = normalize({"direct": True, "formats": [{"format_id": "mp4", "ext": "mp4", "vcodec": None}]})
    assert len(result["formats"]) == 1
    assert result["formats"][0]["has_audio"] is None
    assert result["formats"][0]["label"] == "Original · MP4"


@pytest.mark.parametrize(
    "data,code",
    [
        ({"has_drm": True}, "DRM_UNSUPPORTED"),
        ({"is_live": True}, "LIVE_UNSUPPORTED"),
        ({"entries": []}, "PLAYLIST_UNSUPPORTED"),
    ],
)
def test_unsupported_content(data, code):
    with pytest.raises(ValueError, match=code):
        normalize(data)


def test_no_audio_never_claims_audio():
    result = normalize({"formats": [{"format_id": "v", "ext": "mp4", "vcodec": "h264", "acodec": "none"}]})
    assert result["formats"][0]["has_audio"] is False
    assert "video only" in result["formats"][0]["label"]
    assert len(result["formats"]) == 1
