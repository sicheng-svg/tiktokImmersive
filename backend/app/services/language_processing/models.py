from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class ProviderMetadata:
    provider: str
    model: str


@dataclass(frozen=True, slots=True)
class TranscriptSegment:
    segment_id: str
    start: float
    end: float
    text: str


@dataclass(frozen=True, slots=True)
class TranscriptResult:
    language: str
    audio_duration: float
    segments: tuple[TranscriptSegment, ...]
    provider_metadata: ProviderMetadata


@dataclass(frozen=True, slots=True)
class TranslationInputSegment:
    segment_id: str
    text: str


@dataclass(frozen=True, slots=True)
class TranslationUnit:
    segment_id: str
    text: str


@dataclass(frozen=True, slots=True)
class TranslationResult:
    source_language: str
    target_language: str
    units: tuple[TranslationUnit, ...]
    provider_metadata: ProviderMetadata
    strategy_version: str


@dataclass(frozen=True, slots=True)
class SubtitleSegment:
    segment_id: str
    start: float
    end: float
    zh: str
    en: str


@dataclass(frozen=True, slots=True)
class ASROutcome:
    result: TranscriptResult
    cache_hit: bool


@dataclass(frozen=True, slots=True)
class TranslationOutcome:
    result: TranslationResult
    subtitles: tuple[SubtitleSegment, ...]
    cache_hit: bool
