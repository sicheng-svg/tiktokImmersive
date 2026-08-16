from app.config import BACKEND_ROOT, Settings


def test_relative_audio_dir_is_anchored_to_backend_root(
    monkeypatch,
    tmp_path,
) -> None:
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("DOUYIN_ENGLISH_AUDIO_DIR", "custom/audio")

    settings = Settings.from_environment()

    assert settings.audio_dir == (BACKEND_ROOT / "custom" / "audio").resolve()
