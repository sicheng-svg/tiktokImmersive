import pytest

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


def test_phase_six_settings_are_parsed_and_paths_are_backend_anchored(
    monkeypatch,
    tmp_path,
) -> None:
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("DOUYIN_ENGLISH_LANGUAGE_CACHE_DIR", "custom/cache")
    monkeypatch.setenv("DOUYIN_ENGLISH_SHUTDOWN_GRACE_SECONDS", "3.5")
    monkeypatch.setenv("DOUYIN_ENGLISH_ASR_MAX_RETRIES", "4")
    monkeypatch.setenv("DOUYIN_ENGLISH_TRANSLATION_PROMPT_VERSION", "subtitle-v2")
    monkeypatch.setenv("DOUYIN_ENGLISH_TRANSLATION_MAX_TOTAL_CHARACTERS", "12345")

    settings = Settings.from_environment()

    assert settings.app_version == "0.3.0"
    assert settings.language_cache_dir == (BACKEND_ROOT / "custom" / "cache").resolve()
    assert settings.shutdown_grace_seconds == 3.5
    assert settings.asr_max_retries == 4
    assert settings.translation_prompt_version == "subtitle-v2"
    assert settings.translation_max_total_characters == 12345


def test_provider_credentials_and_proxy_are_redacted_from_settings_repr(tmp_path) -> None:
    settings = Settings(
        language_cache_dir=tmp_path / "cache",
        asr_api_key="asr-secret",
        asr_proxy_url="http://user:password@proxy.example",
        translation_api_key="translation-secret",
        translation_proxy_url="http://other:password@proxy.example",
    )

    rendered = repr(settings)
    assert "asr-secret" not in rendered
    assert "translation-secret" not in rendered
    assert "password" not in rendered


def test_real_provider_requires_key_and_phase_six_languages_are_fixed() -> None:
    with pytest.raises(ValueError, match="ASR API key"):
        Settings(asr_provider="vendor")
    with pytest.raises(ValueError, match="explicit Chinese"):
        Settings(asr_language="auto")
    with pytest.raises(ValueError, match="explicit English"):
        Settings(translation_target_language="fr")


def test_nonfinite_phase_six_limits_are_rejected() -> None:
    with pytest.raises(ValueError, match="greater than zero"):
        Settings(asr_total_timeout_seconds=float("nan"))
    with pytest.raises(ValueError, match="tolerances"):
        Settings(transcript_overlap_tolerance_seconds=float("inf"))
