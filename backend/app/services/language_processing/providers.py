from __future__ import annotations

from pathlib import Path
from typing import Protocol

from app.services.language_processing.models import (
    ProviderMetadata,
    TranscriptResult,
    TranscriptSegment,
    TranslationInputSegment,
    TranslationResult,
    TranslationUnit,
)
from app.services.language_processing.validation import inspect_wav


class ASRProvider(Protocol):
    provider_name: str
    model_name: str

    def transcribe(self, audio_path: Path) -> TranscriptResult: ...


class TranslationProvider(Protocol):
    provider_name: str
    model_name: str

    def translate(
        self,
        segments: tuple[TranslationInputSegment, ...],
    ) -> TranslationResult: ...


class FakeASRProvider:
    """Deterministic development provider; its output is visibly not real ASR."""

    provider_name = "fake"

    def __init__(
        self,
        *,
        model_name: str = "fake-asr-v1",
        language: str = "zh",
        text: str = "【假转写，仅供开发测试】这不是来自真实语音识别的结果。",
    ) -> None:
        self.model_name = model_name
        self._language = language
        self._text = text

    def transcribe(self, audio_path: Path) -> TranscriptResult:
        wav = inspect_wav(audio_path)
        return TranscriptResult(
            language=self._language,
            audio_duration=wav.duration_seconds,
            segments=(
                TranscriptSegment(
                    segment_id="provider-value-is-ignored",
                    start=0.0,
                    end=wav.duration_seconds,
                    text=self._text,
                ),
            ),
            provider_metadata=ProviderMetadata(
                provider=self.provider_name,
                model=self.model_name,
            ),
        )


class FakeTranslationProvider:
    """Deterministic development provider whose marker prevents real-result confusion."""

    provider_name = "fake"

    def __init__(
        self,
        *,
        model_name: str = "fake-translation-v1",
        source_language: str = "zh",
        target_language: str = "en",
        strategy_version: str = "context-v1",
    ) -> None:
        self.model_name = model_name
        self._source_language = source_language
        self._target_language = target_language
        self._strategy_version = strategy_version

    def translate(
        self,
        segments: tuple[TranslationInputSegment, ...],
    ) -> TranslationResult:
        return TranslationResult(
            source_language=self._source_language,
            target_language=self._target_language,
            units=tuple(
                TranslationUnit(
                    segment_id=segment.segment_id,
                    text=f"[FAKE TRANSLATION] {segment.text}",
                )
                for segment in segments
            ),
            provider_metadata=ProviderMetadata(
                provider=self.provider_name,
                model=self.model_name,
            ),
            strategy_version=self._strategy_version,
        )
