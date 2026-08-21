from __future__ import annotations

import math
import re
import unicodedata
import wave
from dataclasses import dataclass
from pathlib import Path

from app.services.language_processing.errors import (
    NoSpeechError,
    ProviderContentLimitError,
    ProviderResponseError,
)
from app.services.language_processing.models import (
    ProviderMetadata,
    SubtitleSegment,
    TranscriptResult,
    TranscriptSegment,
    TranslationInputSegment,
    TranslationResult,
    TranslationUnit,
)


TRANSCRIPT_VALIDATOR_VERSION = "transcript-v1"
TRANSLATION_VALIDATOR_VERSION = "translation-v1"
_HTML_MARKUP_PATTERN = re.compile(r"(?:<!--|<\s*/?\s*[A-Za-z][^>]*>)")


@dataclass(frozen=True, slots=True)
class WavMetadata:
    duration_seconds: float
    size_bytes: int
    channels: int
    sample_rate: int
    sample_width: int


def inspect_wav(path: Path) -> WavMetadata:
    try:
        size = path.stat().st_size
        with wave.open(str(path), "rb") as audio:
            channels = audio.getnchannels()
            sample_rate = audio.getframerate()
            sample_width = audio.getsampwidth()
            frames = audio.getnframes()
            compression = audio.getcomptype()
    except (OSError, EOFError, wave.Error) as exc:
        raise ProviderResponseError("Extracted audio is not a valid WAV file") from exc
    if (
        channels != 1
        or sample_rate != 16000
        or sample_width != 2
        or compression != "NONE"
        or frames <= 0
    ):
        raise ProviderResponseError("Extracted audio has an unsupported WAV format")
    return WavMetadata(
        duration_seconds=frames / sample_rate,
        size_bytes=size,
        channels=channels,
        sample_rate=sample_rate,
        sample_width=sample_width,
    )


def _normalize_text(
    value: str,
    *,
    label: str,
    max_characters: int,
    reject_html: bool = False,
) -> str:
    if not isinstance(value, str):
        raise ProviderResponseError(f"{label} contains invalid text")
    normalized_characters: list[str] = []
    for character in value:
        if character in "\r\n\t":
            normalized_characters.append(" ")
        elif unicodedata.category(character) in {"Cc", "Cf"}:
            raise ProviderResponseError(f"{label} contains control characters")
        else:
            normalized_characters.append(character)
    normalized = " ".join("".join(normalized_characters).split())
    if not normalized:
        raise ProviderResponseError(f"{label} contains empty text")
    if len(normalized) > max_characters:
        raise ProviderContentLimitError(f"{label} exceeds the text limit")
    if reject_html and _HTML_MARKUP_PATTERN.search(normalized):
        raise ProviderResponseError(f"{label} contains HTML markup")
    return normalized


def _finite_number(value: object, *, label: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ProviderResponseError(f"{label} is invalid")
    try:
        number = float(value)
    except (OverflowError, ValueError) as exc:
        raise ProviderResponseError(f"{label} is invalid") from exc
    if not math.isfinite(number):
        raise ProviderResponseError(f"{label} is non-finite")
    return number


class TranscriptValidator:
    def __init__(
        self,
        *,
        max_segments: int = 5000,
        max_segment_characters: int = 4096,
        max_total_characters: int = 500_000,
        overlap_tolerance_seconds: float = 0.25,
        duration_tolerance_seconds: float = 0.5,
    ) -> None:
        if min(max_segments, max_segment_characters, max_total_characters) <= 0:
            raise ValueError("Transcript limits must be greater than zero")
        if overlap_tolerance_seconds < 0 or duration_tolerance_seconds < 0:
            raise ValueError("Transcript tolerances must not be negative")
        self._max_segments = max_segments
        self._max_segment_characters = max_segment_characters
        self._max_total_characters = max_total_characters
        self._overlap_tolerance_seconds = overlap_tolerance_seconds
        self._duration_tolerance_seconds = duration_tolerance_seconds

    def validate(
        self,
        result: TranscriptResult,
        *,
        audio_duration: float,
        expected_language: str,
        expected_provider: str,
        expected_model: str,
    ) -> TranscriptResult:
        audio_duration = _finite_number(audio_duration, label="Extracted audio duration")
        if audio_duration <= 0:
            raise ProviderResponseError("Extracted audio duration is invalid")
        if not isinstance(result, TranscriptResult):
            raise ProviderResponseError("Speech recognition returned an invalid response")
        if not isinstance(result.language, str):
            raise ProviderResponseError("Speech recognition returned an invalid language")
        if result.language.strip().lower() != expected_language.strip().lower():
            raise ProviderResponseError("Speech recognition returned an unexpected language")
        if not isinstance(result.provider_metadata, ProviderMetadata):
            raise ProviderResponseError("Speech recognition metadata is invalid")
        if (
            result.provider_metadata.provider != expected_provider
            or result.provider_metadata.model != expected_model
        ):
            raise ProviderResponseError("Speech recognition metadata is invalid")
        provider_duration = _finite_number(
            result.audio_duration,
            label="Speech recognition duration",
        )
        if provider_duration <= 0:
            raise ProviderResponseError("Speech recognition duration is invalid")
        if abs(provider_duration - audio_duration) > self._duration_tolerance_seconds:
            raise ProviderResponseError(
                "Speech recognition duration does not match the extracted audio"
            )
        if not isinstance(result.segments, tuple):
            raise ProviderResponseError("Speech recognition returned invalid segments")
        if not result.segments:
            raise NoSpeechError("No recognizable speech was found")
        if len(result.segments) > self._max_segments:
            raise ProviderContentLimitError("Speech recognition returned too many segments")

        normalized: list[TranscriptSegment] = []
        total_characters = 0
        previous_start = -1.0
        previous_end = 0.0
        for index, segment in enumerate(result.segments, start=1):
            if not isinstance(segment, TranscriptSegment):
                raise ProviderResponseError("Speech recognition returned an invalid segment")
            start = _finite_number(segment.start, label="Speech recognition start timestamp")
            end = _finite_number(segment.end, label="Speech recognition end timestamp")
            if start < 0 or end <= start:
                raise ProviderResponseError("Speech recognition returned an invalid timestamp")
            if start < previous_start or start < previous_end - self._overlap_tolerance_seconds:
                raise ProviderResponseError("Speech recognition timestamps are not monotonic")
            if end < previous_end:
                raise ProviderResponseError("Speech recognition timestamps are not monotonic")
            if end > audio_duration + self._duration_tolerance_seconds:
                raise ProviderResponseError("Speech recognition timestamp exceeds the audio duration")
            end = min(end, audio_duration)
            if end <= start:
                raise ProviderResponseError("Speech recognition timestamp exceeds the audio duration")
            text = _normalize_text(
                segment.text,
                label="Speech recognition segment",
                max_characters=self._max_segment_characters,
            )
            total_characters += len(text)
            if total_characters > self._max_total_characters:
                raise ProviderContentLimitError("Speech recognition text exceeds the total limit")
            normalized.append(
                TranscriptSegment(
                    segment_id=f"s{index:06d}",
                    start=start,
                    end=end,
                    text=text,
                )
            )
            previous_start = start
            previous_end = end
        return TranscriptResult(
            language=expected_language,
            audio_duration=audio_duration,
            segments=tuple(normalized),
            provider_metadata=ProviderMetadata(
                provider=expected_provider,
                model=expected_model,
            ),
        )


class TranslationValidator:
    def __init__(
        self,
        *,
        max_segment_characters: int = 8192,
        max_total_characters: int = 1_000_000,
    ) -> None:
        if max_segment_characters <= 0 or max_total_characters <= 0:
            raise ValueError("Translation limits must be greater than zero")
        self._max_segment_characters = max_segment_characters
        self._max_total_characters = max_total_characters

    def validate(
        self,
        result: TranslationResult,
        *,
        transcript: TranscriptResult,
        source_language: str,
        target_language: str,
        expected_provider: str,
        expected_model: str,
        expected_strategy_version: str,
    ) -> TranslationResult:
        if not isinstance(result, TranslationResult):
            raise ProviderResponseError("Translation returned an invalid response")
        if not isinstance(result.source_language, str) or not isinstance(
            result.target_language,
            str,
        ):
            raise ProviderResponseError("Translation returned invalid languages")
        if result.source_language != source_language or result.target_language != target_language:
            raise ProviderResponseError("Translation returned unexpected languages")
        if not isinstance(result.provider_metadata, ProviderMetadata):
            raise ProviderResponseError("Translation metadata is invalid")
        if (
            result.provider_metadata.provider != expected_provider
            or result.provider_metadata.model != expected_model
            or result.strategy_version != expected_strategy_version
        ):
            raise ProviderResponseError("Translation metadata is invalid")
        if not isinstance(result.units, tuple) or any(
            not isinstance(unit, TranslationUnit) for unit in result.units
        ):
            raise ProviderResponseError("Translation returned an invalid segment")
        if any(not isinstance(unit.segment_id, str) for unit in result.units):
            raise ProviderResponseError("Translation returned an invalid segment ID")
        expected_ids = tuple(segment.segment_id for segment in transcript.segments)
        returned_ids = tuple(unit.segment_id for unit in result.units)
        if returned_ids != expected_ids or len(set(returned_ids)) != len(returned_ids):
            raise ProviderResponseError("Translation segments do not match the transcript")

        total_characters = 0
        normalized_units: list[TranslationUnit] = []
        for unit in result.units:
            text = _normalize_text(
                unit.text,
                label="Translation segment",
                max_characters=self._max_segment_characters,
                reject_html=True,
            )
            total_characters += len(text)
            if total_characters > self._max_total_characters:
                raise ProviderContentLimitError("Translation text exceeds the total limit")
            normalized_units.append(TranslationUnit(segment_id=unit.segment_id, text=text))
        return TranslationResult(
            source_language=source_language,
            target_language=target_language,
            units=tuple(normalized_units),
            provider_metadata=ProviderMetadata(
                provider=expected_provider,
                model=expected_model,
            ),
            strategy_version=expected_strategy_version,
        )

    @staticmethod
    def build_subtitles(
        transcript: TranscriptResult,
        translation: TranslationResult,
    ) -> tuple[SubtitleSegment, ...]:
        translations = {unit.segment_id: unit.text for unit in translation.units}
        return tuple(
            SubtitleSegment(
                segment_id=segment.segment_id,
                start=segment.start,
                end=segment.end,
                zh=segment.text,
                en=translations[segment.segment_id],
            )
            for segment in transcript.segments
        )


def translation_input(
    transcript: TranscriptResult,
) -> tuple[TranslationInputSegment, ...]:
    return tuple(
        TranslationInputSegment(segment_id=segment.segment_id, text=segment.text)
        for segment in transcript.segments
    )
