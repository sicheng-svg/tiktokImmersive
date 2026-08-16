from app.config import BACKEND_ROOT, Settings


def test_relative_audio_dir_is_anchored_to_backend_root(
    monkeypatch,
    tmp_path,
) -> None:
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("DOUYIN_ENGLISH_AUDIO_DIR", "custom/audio")
    monkeypatch.setenv("DOUYIN_ENGLISH_MEDIA_TEMP_DIR", "custom/temp")

    settings = Settings.from_environment()

    assert settings.audio_dir == (BACKEND_ROOT / "custom" / "audio").resolve()
    assert settings.media_temp_dir == (BACKEND_ROOT / "custom" / "temp").resolve()


def test_media_security_settings_are_parsed(monkeypatch) -> None:
    monkeypatch.setenv("DOUYIN_ENGLISH_MEDIA_HOST_SUFFIXES", ".douyin.com, CDN.EXAMPLE")
    monkeypatch.setenv("DOUYIN_ENGLISH_MEDIA_MAX_DOWNLOAD_BYTES", "4096")
    monkeypatch.setenv("DOUYIN_ENGLISH_MEDIA_TOTAL_TIMEOUT_SECONDS", "12.5")
    monkeypatch.setenv("DOUYIN_ENGLISH_ALLOW_MISSING_ORIGIN", "false")

    settings = Settings.from_environment()

    assert settings.media_host_suffixes == ("douyin.com", "cdn.example")
    assert settings.media_max_download_bytes == 4096
    assert settings.media_total_timeout_seconds == 12.5
    assert settings.allow_missing_origin is False
