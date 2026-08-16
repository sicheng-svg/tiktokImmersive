from __future__ import annotations

import subprocess
import wave
from collections.abc import Callable
from pathlib import Path


class AudioExtractionError(RuntimeError):
    """An FFmpeg failure whose message is safe to expose through the task API."""


DEFAULT_MAX_DURATION_SECONDS = 15 * 60
DEFAULT_MAX_OUTPUT_BYTES = 32 * 1024 * 1024


class FfmpegAudioExtractor:
    def __init__(
        self,
        *,
        executable: str,
        timeout_seconds: float,
        max_duration_seconds: float = DEFAULT_MAX_DURATION_SECONDS,
        max_output_bytes: int = DEFAULT_MAX_OUTPUT_BYTES,
        run_command: Callable[..., subprocess.CompletedProcess[bytes]] = subprocess.run,
    ) -> None:
        if max_duration_seconds <= 0 or max_output_bytes <= 0:
            raise ValueError("FFmpeg output limits must be greater than zero")
        self._executable = executable
        self._timeout_seconds = timeout_seconds
        self._max_duration_seconds = max_duration_seconds
        self._max_output_bytes = max_output_bytes
        self._run_command = run_command

    def extract(self, source: Path, destination: Path) -> None:
        destination.parent.mkdir(parents=True, exist_ok=True)
        temporary_output = destination.with_name(f"{destination.stem}.part.wav")
        temporary_output.unlink(missing_ok=True)
        destination.unlink(missing_ok=True)
        command = [
            self._executable,
            "-nostdin",
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-protocol_whitelist",
            "file,pipe",
            "-protocol_blacklist",
            "http,https,tcp,tls,udp,rtp,ftp,sftp,crypto,data,concat,subfile",
            "-i",
            str(source),
            "-vn",
            "-t",
            str(self._max_duration_seconds),
            "-ac",
            "1",
            "-ar",
            "16000",
            "-c:a",
            "pcm_s16le",
            "-f",
            "wav",
            "-fs",
            str(self._max_output_bytes),
            str(temporary_output),
        ]

        try:
            result = self._run_command(
                command,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                check=False,
                timeout=self._timeout_seconds,
                shell=False,
            )
        except subprocess.TimeoutExpired as exc:
            temporary_output.unlink(missing_ok=True)
            raise AudioExtractionError("Audio extraction timed out") from exc
        except FileNotFoundError as exc:
            temporary_output.unlink(missing_ok=True)
            raise AudioExtractionError("FFmpeg is not installed or configured") from exc
        except OSError as exc:
            temporary_output.unlink(missing_ok=True)
            raise AudioExtractionError("Audio extraction could not start") from exc

        try:
            if result.returncode != 0 or not temporary_output.is_file():
                raise AudioExtractionError("Audio extraction failed")
            if temporary_output.stat().st_size > self._max_output_bytes:
                raise AudioExtractionError("Extracted audio exceeds the output size limit")
            self._validate_wav(temporary_output)
            temporary_output.replace(destination)
        finally:
            temporary_output.unlink(missing_ok=True)

    @staticmethod
    def _validate_wav(path: Path) -> None:
        try:
            with wave.open(str(path), "rb") as audio:
                valid = (
                    audio.getnchannels() == 1
                    and audio.getframerate() == 16000
                    and audio.getsampwidth() == 2
                    and audio.getcomptype() == "NONE"
                    and audio.getnframes() > 0
                )
        except (OSError, EOFError, wave.Error) as exc:
            raise AudioExtractionError("FFmpeg produced invalid audio") from exc
        if not valid:
            raise AudioExtractionError("FFmpeg produced an unexpected audio format")
