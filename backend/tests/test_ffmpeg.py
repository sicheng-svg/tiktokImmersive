from __future__ import annotations

import os
import subprocess
import wave
from pathlib import Path

import pytest

from app.services.ffmpeg import AudioExtractionError, FfmpegAudioExtractor


def write_wav(
    path: Path,
    *,
    channels: int = 1,
    sample_rate: int = 16000,
    sample_width: int = 2,
) -> None:
    with wave.open(str(path), "wb") as output:
        output.setnchannels(channels)
        output.setsampwidth(sample_width)
        output.setframerate(sample_rate)
        output.writeframes(b"\x00" * channels * sample_width * 16)


def test_ffmpeg_command_is_bounded_local_and_produces_valid_wav(tmp_path: Path) -> None:
    captured: dict[str, object] = {}

    def runner(command, **kwargs):
        captured["command"] = command
        captured["kwargs"] = kwargs
        write_wav(Path(command[-1]))
        return subprocess.CompletedProcess(command, 0, b"", b"")

    source = tmp_path / "source.media"
    source.write_bytes(b"input")
    destination = tmp_path / "audio" / "source.wav"
    extractor = FfmpegAudioExtractor(
        executable="ffmpeg-test",
        timeout_seconds=12,
        run_command=runner,
    )

    extractor.extract(source, destination)

    command = captured["command"]
    kwargs = captured["kwargs"]
    assert command[0] == "ffmpeg-test"
    assert command[command.index("-protocol_whitelist") + 1] == "file,pipe"
    blacklist = command[command.index("-protocol_blacklist") + 1]
    assert {"http", "https", "tcp", "tls", "udp"}.issubset(set(blacklist.split(",")))
    assert command[command.index("-i") + 1] == str(source)
    assert command[command.index("-t") + 1] == str(15 * 60)
    assert command[command.index("-ac") + 1] == "1"
    assert command[command.index("-ar") + 1] == "16000"
    assert command[command.index("-c:a") + 1] == "pcm_s16le"
    assert command[command.index("-fs") + 1] == str(32 * 1024 * 1024)
    assert kwargs["timeout"] == 12
    assert kwargs["shell"] is False
    assert destination.is_file()


def test_ffmpeg_timeout_and_nonzero_exit_clean_partial_output(tmp_path: Path) -> None:
    source = tmp_path / "source.media"
    source.write_bytes(b"input")
    destination = tmp_path / "source.wav"

    def timeout_runner(command, **_kwargs):
        Path(command[-1]).write_bytes(b"partial")
        raise subprocess.TimeoutExpired(command, timeout=1)

    timeout_extractor = FfmpegAudioExtractor(
        executable="ffmpeg",
        timeout_seconds=1,
        run_command=timeout_runner,
    )
    with pytest.raises(AudioExtractionError, match="timed out"):
        timeout_extractor.extract(source, destination)
    assert not destination.exists()
    assert not (tmp_path / "source.part.wav").exists()

    def failing_runner(command, **_kwargs):
        Path(command[-1]).write_bytes(b"partial")
        return subprocess.CompletedProcess(command, 1, b"", b"sensitive detail")

    failing_extractor = FfmpegAudioExtractor(
        executable="ffmpeg",
        timeout_seconds=1,
        run_command=failing_runner,
    )
    with pytest.raises(AudioExtractionError, match="Audio extraction failed") as error:
        failing_extractor.extract(source, destination)
    assert "sensitive" not in str(error.value)
    assert not destination.exists()


def test_ffmpeg_rejects_output_above_the_byte_limit(tmp_path: Path) -> None:
    def runner(command, **_kwargs):
        write_wav(Path(command[-1]))
        return subprocess.CompletedProcess(command, 0, b"", b"")

    source = tmp_path / "source.media"
    source.write_bytes(b"input")
    destination = tmp_path / "source.wav"
    extractor = FfmpegAudioExtractor(
        executable="ffmpeg",
        timeout_seconds=1,
        max_output_bytes=64,
        run_command=runner,
    )

    with pytest.raises(AudioExtractionError, match="output size limit"):
        extractor.extract(source, destination)
    assert not destination.exists()
    assert not (tmp_path / "source.part.wav").exists()


@pytest.mark.parametrize(
    ("channels", "sample_rate", "sample_width"),
    [(2, 16000, 2), (1, 44100, 2), (1, 16000, 1)],
)
def test_ffmpeg_output_format_is_verified(
    tmp_path: Path,
    channels: int,
    sample_rate: int,
    sample_width: int,
) -> None:
    def runner(command, **_kwargs):
        write_wav(
            Path(command[-1]),
            channels=channels,
            sample_rate=sample_rate,
            sample_width=sample_width,
        )
        return subprocess.CompletedProcess(command, 0, b"", b"")

    source = tmp_path / "source.media"
    source.write_bytes(b"input")
    destination = tmp_path / "source.wav"
    extractor = FfmpegAudioExtractor(
        executable="ffmpeg",
        timeout_seconds=1,
        run_command=runner,
    )

    with pytest.raises(AudioExtractionError, match="unexpected audio format"):
        extractor.extract(source, destination)
    assert not destination.exists()


def test_real_ffmpeg_binary_smoke(tmp_path: Path) -> None:
    executable = os.getenv("DOUYIN_ENGLISH_REAL_FFMPEG_BINARY")
    if not executable:
        pytest.skip("set DOUYIN_ENGLISH_REAL_FFMPEG_BINARY to run the real FFmpeg smoke test")

    source = Path(__file__).resolve().parents[2] / "extension" / "public" / "audio" / "test.mp3"
    destination = tmp_path / "audio.wav"
    extractor = FfmpegAudioExtractor(executable=executable, timeout_seconds=30)

    extractor.extract(source, destination)

    with wave.open(str(destination), "rb") as audio:
        assert audio.getnchannels() == 1
        assert audio.getframerate() == 16000
        assert audio.getsampwidth() == 2
        assert audio.getnframes() > 0
