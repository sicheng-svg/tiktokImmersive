from __future__ import annotations

from app.config import Settings
from app.services.language_processing.cache import FileASRCache, FileTranslationCache
from app.services.language_processing.providers import (
    FakeASRProvider,
    FakeTranslationProvider,
)
from app.services.language_processing.service import LanguageProcessingService
from app.services.language_processing.validation import (
    TranscriptValidator,
    TranslationValidator,
)


def build_language_processing_service(settings: Settings) -> LanguageProcessingService:
    """Build the provider-neutral language service from validated settings.

    Phase 6 ships deterministic fake providers for local development and tests.
    A non-fake selection fails startup explicitly until its real adapter exists.
    """

    if settings.asr_provider != "fake":
        raise ValueError(
            f"ASR provider {settings.asr_provider!r} is configured, but its real adapter "
            "is not implemented"
        )
    if settings.translation_provider != "fake":
        raise ValueError(
            f"Translation provider {settings.translation_provider!r} is configured, but "
            "its real adapter is not implemented"
        )

    asr_provider = FakeASRProvider(
        model_name=settings.asr_model,
        language=settings.asr_language,
    )
    translation_provider = FakeTranslationProvider(
        model_name=settings.translation_model,
        source_language=settings.translation_source_language,
        target_language=settings.translation_target_language,
        strategy_version=settings.translation_strategy_version,
    )
    return LanguageProcessingService(
        asr_provider=asr_provider,
        translation_provider=translation_provider,
        asr_cache=FileASRCache(
            settings.language_cache_dir / "asr",
            max_json_bytes=settings.language_cache_max_json_bytes,
        ),
        translation_cache=FileTranslationCache(
            settings.language_cache_dir / "translation",
            max_json_bytes=settings.language_cache_max_json_bytes,
        ),
        transcript_validator=TranscriptValidator(
            max_segments=settings.transcript_max_segments,
            max_segment_characters=settings.transcript_max_segment_characters,
            max_total_characters=settings.transcript_max_total_characters,
            overlap_tolerance_seconds=settings.transcript_overlap_tolerance_seconds,
            duration_tolerance_seconds=settings.transcript_duration_tolerance_seconds,
        ),
        translation_validator=TranslationValidator(
            max_segment_characters=settings.translation_max_segment_characters,
            max_total_characters=settings.translation_max_total_characters,
        ),
        asr_language=settings.asr_language,
        asr_timestamp_granularity=settings.asr_timestamp_granularity,
        translation_source_language=settings.translation_source_language,
        translation_target_language=settings.translation_target_language,
        translation_api_version=settings.translation_api_version,
        translation_prompt_version=settings.translation_prompt_version,
        translation_strategy_version=settings.translation_strategy_version,
        max_audio_bytes=settings.asr_max_audio_bytes,
        max_audio_duration_seconds=settings.asr_max_audio_duration_seconds,
    )
