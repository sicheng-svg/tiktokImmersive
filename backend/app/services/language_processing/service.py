from __future__ import annotations

from pathlib import Path

from app.services.language_processing.cache import (
    ASRCache,
    SingleFlight,
    TranslationCache,
    hash_file,
)
from app.services.language_processing.errors import (
    LanguageProcessingError,
    ProviderContentLimitError,
    ProviderUnavailableError,
)
from app.services.language_processing.models import (
    ASROutcome,
    TranscriptResult,
    TranslationOutcome,
)
from app.services.language_processing.providers import ASRProvider, TranslationProvider
from app.services.language_processing.validation import (
    TranscriptValidator,
    TranslationValidator,
    inspect_wav,
    translation_input,
)


class LanguageProcessingService:
    def __init__(
        self,
        *,
        asr_provider: ASRProvider,
        translation_provider: TranslationProvider,
        asr_cache: ASRCache,
        translation_cache: TranslationCache,
        transcript_validator: TranscriptValidator,
        translation_validator: TranslationValidator,
        asr_language: str,
        asr_timestamp_granularity: str,
        translation_source_language: str,
        translation_target_language: str,
        translation_api_version: str,
        translation_prompt_version: str,
        translation_strategy_version: str,
        max_audio_bytes: int,
        max_audio_duration_seconds: float,
    ) -> None:
        if max_audio_bytes <= 0 or max_audio_duration_seconds <= 0:
            raise ValueError("ASR input limits must be greater than zero")
        self._asr_provider = asr_provider
        self._translation_provider = translation_provider
        self._asr_cache = asr_cache
        self._translation_cache = translation_cache
        self._transcript_validator = transcript_validator
        self._translation_validator = translation_validator
        self._asr_language = asr_language
        self._asr_timestamp_granularity = asr_timestamp_granularity
        self._translation_source_language = translation_source_language
        self._translation_target_language = translation_target_language
        self._translation_api_version = translation_api_version
        self._translation_prompt_version = translation_prompt_version
        self._translation_strategy_version = translation_strategy_version
        self._max_audio_bytes = max_audio_bytes
        self._max_audio_duration_seconds = max_audio_duration_seconds
        self._asr_singleflight: SingleFlight[ASROutcome] = SingleFlight()
        self._translation_singleflight: SingleFlight[TranslationOutcome] = SingleFlight()

    @property
    def asr_provider_name(self) -> str:
        return self._asr_provider.provider_name

    @property
    def translation_provider_name(self) -> str:
        return self._translation_provider.provider_name

    def transcribe(self, audio_path: Path) -> ASROutcome:
        wav = inspect_wav(audio_path)
        if wav.size_bytes > self._max_audio_bytes:
            raise ProviderContentLimitError("Extracted audio exceeds the ASR size limit")
        if wav.duration_seconds > self._max_audio_duration_seconds:
            raise ProviderContentLimitError("Extracted audio exceeds the ASR duration limit")
        cache_key = self._asr_cache.build_key(
            audio_sha256=hash_file(audio_path),
            provider=self._asr_provider.provider_name,
            model=self._asr_provider.model_name,
            language=self._asr_language,
            timestamp_granularity=self._asr_timestamp_granularity,
        )
        cached = self._load_valid_transcript(cache_key, wav.duration_seconds)
        if cached is not None:
            return ASROutcome(result=cached, cache_hit=True)

        def compute() -> ASROutcome:
            cached_after_wait = self._load_valid_transcript(cache_key, wav.duration_seconds)
            if cached_after_wait is not None:
                return ASROutcome(result=cached_after_wait, cache_hit=True)
            try:
                result = self._transcript_validator.validate(
                    self._asr_provider.transcribe(audio_path),
                    audio_duration=wav.duration_seconds,
                    expected_language=self._asr_language,
                    expected_provider=self._asr_provider.provider_name,
                    expected_model=self._asr_provider.model_name,
                )
                self._asr_cache.save(cache_key, result)
            except LanguageProcessingError as exc:
                # This branch runs only after a cache miss and Provider invocation.
                exc.cache_hit = False
                raise
            except Exception:
                raise ProviderUnavailableError(
                    "Speech recognition provider failed",
                    cache_hit=False,
                ) from None
            return ASROutcome(result=result, cache_hit=False)

        return self._asr_singleflight.run(cache_key, compute)

    def translate(self, transcript: TranscriptResult) -> TranslationOutcome:
        inputs = translation_input(transcript)
        cache_key = self._translation_cache.build_key(
            segments=tuple((segment.segment_id, segment.text) for segment in inputs),
            provider=self._translation_provider.provider_name,
            model=self._translation_provider.model_name,
            api_version=self._translation_api_version,
            source_language=self._translation_source_language,
            target_language=self._translation_target_language,
            prompt_version=self._translation_prompt_version,
            strategy_version=self._translation_strategy_version,
        )
        cached = self._load_valid_translation(cache_key, transcript)
        if cached is not None:
            return TranslationOutcome(
                result=cached,
                subtitles=self._translation_validator.build_subtitles(transcript, cached),
                cache_hit=True,
            )

        def compute() -> TranslationOutcome:
            cached_after_wait = self._load_valid_translation(cache_key, transcript)
            if cached_after_wait is not None:
                return TranslationOutcome(
                    result=cached_after_wait,
                    subtitles=self._translation_validator.build_subtitles(
                        transcript,
                        cached_after_wait,
                    ),
                    cache_hit=True,
                )
            try:
                result = self._translation_validator.validate(
                    self._translation_provider.translate(inputs),
                    transcript=transcript,
                    source_language=self._translation_source_language,
                    target_language=self._translation_target_language,
                    expected_provider=self._translation_provider.provider_name,
                    expected_model=self._translation_provider.model_name,
                    expected_strategy_version=self._translation_strategy_version,
                )
                self._translation_cache.save(cache_key, result)
            except LanguageProcessingError as exc:
                # This branch runs only after a cache miss and Provider invocation.
                exc.cache_hit = False
                raise
            except Exception:
                raise ProviderUnavailableError(
                    "Translation provider failed",
                    cache_hit=False,
                ) from None
            return TranslationOutcome(
                result=result,
                subtitles=self._translation_validator.build_subtitles(transcript, result),
                cache_hit=False,
            )

        return self._translation_singleflight.run(cache_key, compute)

    def close(self) -> None:
        for provider in (self._asr_provider, self._translation_provider):
            close = getattr(provider, "close", None)
            if callable(close):
                close()

    def _load_valid_transcript(
        self,
        cache_key: str,
        audio_duration: float,
    ) -> TranscriptResult | None:
        cached = self._asr_cache.load(cache_key)
        if cached is None:
            return None
        try:
            return self._transcript_validator.validate(
                cached,
                audio_duration=audio_duration,
                expected_language=self._asr_language,
                expected_provider=self._asr_provider.provider_name,
                expected_model=self._asr_provider.model_name,
            )
        except LanguageProcessingError:
            return None

    def _load_valid_translation(
        self,
        cache_key: str,
        transcript: TranscriptResult,
    ) -> TranslationResult | None:
        cached = self._translation_cache.load(cache_key)
        if cached is None:
            return None
        try:
            return self._translation_validator.validate(
                cached,
                transcript=transcript,
                source_language=self._translation_source_language,
                target_language=self._translation_target_language,
                expected_provider=self._translation_provider.provider_name,
                expected_model=self._translation_provider.model_name,
                expected_strategy_version=self._translation_strategy_version,
            )
        except LanguageProcessingError:
            return None
