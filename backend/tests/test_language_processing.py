from __future__ import annotations

import json
import math
import time
import wave
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Lock

import pytest

from app.config import Settings
from app.services.language_processing.cache import FileASRCache, FileTranslationCache
from app.services.language_processing.errors import (
    LanguageProcessingError,
    NoSpeechError,
    ProviderContentLimitError,
    ProviderResponseError,
    ProviderTimeoutError,
    ProviderUnavailableError,
)
from app.services.language_processing.factory import build_language_processing_service
from app.services.language_processing.models import (
    ProviderMetadata,
    TranscriptResult,
    TranscriptSegment,
    TranslationResult,
    TranslationUnit,
)
from app.services.language_processing.providers import (
    FakeASRProvider,
    FakeTranslationProvider,
)
from app.services.language_processing.service import LanguageProcessingService
from app.services.language_processing.validation import (
    TRANSCRIPT_VALIDATOR_VERSION,
    TRANSLATION_VALIDATOR_VERSION,
    TranscriptValidator,
    TranslationValidator,
)


def write_wav(path: Path, *, duration_seconds: float = 1.0) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(16000)
        audio.writeframes(b"\x00\x00" * int(16000 * duration_seconds))


class CountingASRProvider(FakeASRProvider):
    def __init__(self, *, delay: float = 0.0) -> None:
        super().__init__()
        self.calls = 0
        self._delay = delay
        self._lock = Lock()

    def transcribe(self, audio_path: Path) -> TranscriptResult:
        with self._lock:
            self.calls += 1
        if self._delay:
            time.sleep(self._delay)
        return super().transcribe(audio_path)


class CountingTranslationProvider(FakeTranslationProvider):
    def __init__(self, *, delay: float = 0.0) -> None:
        super().__init__()
        self.calls = 0
        self._delay = delay
        self._lock = Lock()

    def translate(self, segments):
        with self._lock:
            self.calls += 1
        if self._delay:
            time.sleep(self._delay)
        return super().translate(segments)


def build_service(
    root: Path,
    *,
    asr_provider=None,
    translation_provider=None,
) -> LanguageProcessingService:
    return LanguageProcessingService(
        asr_provider=asr_provider or CountingASRProvider(),
        translation_provider=translation_provider or CountingTranslationProvider(),
        asr_cache=FileASRCache(root / "asr", max_json_bytes=1024 * 1024),
        translation_cache=FileTranslationCache(
            root / "translation",
            max_json_bytes=1024 * 1024,
        ),
        transcript_validator=TranscriptValidator(),
        translation_validator=TranslationValidator(),
        asr_language="zh",
        asr_timestamp_granularity="segment",
        translation_source_language="zh",
        translation_target_language="en",
        translation_api_version="fake-v1",
        translation_prompt_version="subtitle-v1",
        translation_strategy_version="context-v1",
        max_audio_bytes=10_000_000,
        max_audio_duration_seconds=60,
    )


def valid_transcript() -> TranscriptResult:
    return TranscriptResult(
        language="zh",
        audio_duration=2.0,
        segments=(
            TranscriptSegment("provider-a", 0.0, 1.0, " 第一段\n中文 "),
            TranscriptSegment("provider-b", 0.9, 2.0, "第二段中文"),
        ),
        provider_metadata=ProviderMetadata("fake", "fake-asr-v1"),
    )


def valid_translation(transcript: TranscriptResult) -> TranslationResult:
    return TranslationResult(
        source_language="zh",
        target_language="en",
        units=tuple(
            TranslationUnit(segment.segment_id, f"English {index}")
            for index, segment in enumerate(transcript.segments, start=1)
        ),
        provider_metadata=ProviderMetadata("fake", "fake-translation-v1"),
        strategy_version="context-v1",
    )


def validate_transcript(result: TranscriptResult) -> TranscriptResult:
    return TranscriptValidator().validate(
        result,
        audio_duration=2.0,
        expected_language="zh",
        expected_provider="fake",
        expected_model="fake-asr-v1",
    )


def validate_translation(
    result: TranslationResult,
    transcript: TranscriptResult,
) -> TranslationResult:
    return TranslationValidator().validate(
        result,
        transcript=transcript,
        source_language="zh",
        target_language="en",
        expected_provider="fake",
        expected_model="fake-translation-v1",
        expected_strategy_version="context-v1",
    )


def test_fake_pipeline_is_deterministic_and_visibly_marked(tmp_path: Path) -> None:
    audio = tmp_path / "audio.wav"
    write_wav(audio)
    service = build_service(tmp_path / "cache")

    asr = service.transcribe(audio)
    translation = service.translate(asr.result)

    assert asr.cache_hit is False
    assert asr.result.segments[0].segment_id == "s000001"
    assert "假转写" in asr.result.segments[0].text
    assert translation.cache_hit is False
    assert translation.subtitles[0].segment_id == "s000001"
    assert translation.subtitles[0].zh == asr.result.segments[0].text
    assert translation.subtitles[0].en.startswith("[FAKE TRANSLATION]")


def test_translation_facade_sends_complete_ordered_context_in_one_call(tmp_path: Path) -> None:
    class RecordingTranslationProvider(FakeTranslationProvider):
        def __init__(self) -> None:
            super().__init__()
            self.received = ()
            self.calls = 0

        def translate(self, segments):
            self.calls += 1
            self.received = segments
            return super().translate(segments)

    transcript = validate_transcript(valid_transcript())
    provider = RecordingTranslationProvider()
    service = build_service(tmp_path / "cache", translation_provider=provider)

    service.translate(transcript)

    assert provider.calls == 1
    assert [(item.segment_id, item.text) for item in provider.received] == [
        ("s000001", "第一段 中文"),
        ("s000002", "第二段中文"),
    ]


def test_new_service_uses_both_valid_disk_caches(tmp_path: Path) -> None:
    audio = tmp_path / "audio.wav"
    cache = tmp_path / "cache"
    write_wav(audio)
    first_asr = CountingASRProvider()
    first_translation = CountingTranslationProvider()
    first = build_service(
        cache,
        asr_provider=first_asr,
        translation_provider=first_translation,
    )
    transcript = first.transcribe(audio).result
    first.translate(transcript)

    second_asr = CountingASRProvider()
    second_translation = CountingTranslationProvider()
    second = build_service(
        cache,
        asr_provider=second_asr,
        translation_provider=second_translation,
    )
    cached_asr = second.transcribe(audio)
    cached_translation = second.translate(cached_asr.result)

    assert first_asr.calls == first_translation.calls == 1
    assert second_asr.calls == second_translation.calls == 0
    assert cached_asr.cache_hit is True
    assert cached_translation.cache_hit is True


def test_corrupt_translation_cache_only_repeats_translation(tmp_path: Path) -> None:
    audio = tmp_path / "audio.wav"
    cache = tmp_path / "cache"
    write_wav(audio)
    first = build_service(cache)
    transcript = first.transcribe(audio).result
    first.translate(transcript)
    translation_files = list((cache / "translation").glob("*/translation.json"))
    assert len(translation_files) == 1
    translation_files[0].write_text("{broken", encoding="utf-8")

    asr_provider = CountingASRProvider()
    translation_provider = CountingTranslationProvider()
    second = build_service(
        cache,
        asr_provider=asr_provider,
        translation_provider=translation_provider,
    )
    cached_asr = second.transcribe(audio)
    translated = second.translate(cached_asr.result)

    assert cached_asr.cache_hit is True
    assert asr_provider.calls == 0
    assert translated.cache_hit is False
    assert translation_provider.calls == 1


def test_malformed_cache_member_invalidates_whole_layer_instead_of_being_dropped(
    tmp_path: Path,
) -> None:
    audio = tmp_path / "audio.wav"
    cache = tmp_path / "cache"
    write_wav(audio)
    first = build_service(cache)
    first.transcribe(audio)
    transcript_file = next((cache / "asr").glob("*/transcript.json"))
    payload = json.loads(transcript_file.read_text(encoding="utf-8"))
    payload["transcript"]["segments"].append({"malformed": True})
    transcript_file.write_text(json.dumps(payload), encoding="utf-8")

    provider = CountingASRProvider()
    recovered = build_service(cache, asr_provider=provider).transcribe(audio)

    assert recovered.cache_hit is False
    assert provider.calls == 1
    repaired = json.loads(transcript_file.read_text(encoding="utf-8"))
    assert len(repaired["transcript"]["segments"]) == 1


def test_cache_keys_include_schema_validator_and_translation_strategy_versions() -> None:
    asr_base = FileASRCache.build_key(
        audio_sha256="a" * 64,
        provider="fake",
        model="m1",
        language="zh",
        timestamp_granularity="segment",
    )
    asr_changed = FileASRCache.build_key(
        audio_sha256="a" * 64,
        provider="fake",
        model="m1",
        language="zh",
        timestamp_granularity="segment",
        validator_version=TRANSCRIPT_VALIDATOR_VERSION + "-next",
    )
    translation_base = FileTranslationCache.build_key(
        segments=(("s000001", "你好"),),
        provider="fake",
        model="m1",
        api_version="v1",
        source_language="zh",
        target_language="en",
        prompt_version="p1",
        strategy_version="c1",
    )
    translation_changed = FileTranslationCache.build_key(
        segments=(("s000001", "你好"),),
        provider="fake",
        model="m1",
        api_version="v1",
        source_language="zh",
        target_language="en",
        prompt_version="p1",
        strategy_version="c2",
        validator_version=TRANSLATION_VALIDATOR_VERSION + "-next",
    )

    assert asr_base != asr_changed
    assert translation_base != translation_changed


def test_asr_and_translation_singleflight_call_each_provider_once(tmp_path: Path) -> None:
    audio = tmp_path / "audio.wav"
    write_wav(audio)
    asr_provider = CountingASRProvider(delay=0.05)
    translation_provider = CountingTranslationProvider(delay=0.05)
    service = build_service(
        tmp_path / "cache",
        asr_provider=asr_provider,
        translation_provider=translation_provider,
    )

    with ThreadPoolExecutor(max_workers=12) as executor:
        asr_results = list(executor.map(lambda _index: service.transcribe(audio), range(24)))
    transcript = asr_results[0].result
    with ThreadPoolExecutor(max_workers=12) as executor:
        translations = list(executor.map(lambda _index: service.translate(transcript), range(24)))

    assert asr_provider.calls == 1
    assert translation_provider.calls == 1
    assert all(isinstance(result.cache_hit, bool) for result in asr_results)
    assert all(isinstance(result.cache_hit, bool) for result in translations)
    assert any(result.cache_hit is False for result in asr_results)
    assert any(result.cache_hit is False for result in translations)


def test_provider_failure_after_cache_miss_reports_false_cache_state(tmp_path: Path) -> None:
    class TimeoutASR(FakeASRProvider):
        def transcribe(self, _audio_path: Path) -> TranscriptResult:
            raise ProviderTimeoutError("Speech recognition service timed out")

    audio = tmp_path / "audio.wav"
    write_wav(audio)
    service = build_service(tmp_path / "cache", asr_provider=TimeoutASR())

    with pytest.raises(ProviderTimeoutError) as captured:
        service.transcribe(audio)

    assert captured.value.cache_hit is False


def test_unknown_translation_provider_exception_is_wrapped_without_raw_message(
    tmp_path: Path,
) -> None:
    secret = "translation-secret-raw-response"

    class UnknownFailureTranslation(FakeTranslationProvider):
        def translate(self, _segments):
            raise RuntimeError(secret)

    service = build_service(
        tmp_path / "cache",
        translation_provider=UnknownFailureTranslation(),
    )
    transcript = validate_transcript(valid_transcript())

    with pytest.raises(ProviderUnavailableError) as captured:
        service.translate(transcript)

    assert captured.value.cache_hit is False
    assert secret not in str(captured.value)


@pytest.mark.parametrize(
    ("start", "end"),
    [
        (math.nan, 1.0),
        (0.0, math.inf),
        (-0.1, 1.0),
        (1.0, 1.0),
        (0.0, 2.6),
    ],
)
def test_transcript_validator_rejects_invalid_timestamps(start: float, end: float) -> None:
    result = TranscriptResult(
        language="zh",
        audio_duration=2.0,
        segments=(TranscriptSegment("provider", start, end, "中文"),),
        provider_metadata=ProviderMetadata("fake", "fake-asr-v1"),
    )

    with pytest.raises(ProviderResponseError):
        validate_transcript(result)


def test_transcript_validator_normalizes_text_ids_and_small_overlap() -> None:
    normalized = validate_transcript(valid_transcript())

    assert [segment.segment_id for segment in normalized.segments] == ["s000001", "s000002"]
    assert normalized.segments[0].text == "第一段 中文"
    assert normalized.segments[1].start == 0.9


@pytest.mark.parametrize("text", ["", "   ", "bad\x00text", "hidden\u200btext"])
def test_transcript_validator_rejects_empty_or_control_text(text: str) -> None:
    result = TranscriptResult(
        language="zh",
        audio_duration=2.0,
        segments=(TranscriptSegment("provider", 0.0, 1.0, text),),
        provider_metadata=ProviderMetadata("fake", "fake-asr-v1"),
    )

    with pytest.raises(ProviderResponseError):
        validate_transcript(result)


def test_transcript_validator_rejects_no_speech_too_many_and_severe_overlap() -> None:
    metadata = ProviderMetadata("fake", "fake-asr-v1")
    with pytest.raises(NoSpeechError):
        validate_transcript(TranscriptResult("zh", 2.0, (), metadata))
    with pytest.raises(ProviderContentLimitError):
        TranscriptValidator(max_segments=1).validate(
            valid_transcript(),
            audio_duration=2.0,
            expected_language="zh",
            expected_provider="fake",
            expected_model="fake-asr-v1",
        )
    severe_overlap = TranscriptResult(
        "zh",
        2.0,
        (
            TranscriptSegment("a", 0.0, 1.0, "一"),
            TranscriptSegment("b", 0.7, 1.5, "二"),
        ),
        metadata,
    )
    with pytest.raises(ProviderResponseError):
        validate_transcript(severe_overlap)

    wrong_duration = TranscriptResult(
        "zh",
        9.0,
        (TranscriptSegment("a", 0.0, 1.0, "一"),),
        metadata,
    )
    with pytest.raises(ProviderResponseError, match="does not match"):
        validate_transcript(wrong_duration)


@pytest.mark.parametrize(
    "units",
    [
        (TranslationUnit("s000002", "two"), TranslationUnit("s000001", "one")),
        (TranslationUnit("s000001", "one"),),
        (TranslationUnit("s000001", "one"), TranslationUnit("s000001", "again")),
        (
            TranslationUnit("s000001", "one"),
            TranslationUnit("s000002", "two"),
            TranslationUnit("s000003", "extra"),
        ),
    ],
)
def test_translation_validator_rejects_id_mismatch(units) -> None:
    transcript = validate_transcript(valid_transcript())
    result = TranslationResult(
        "zh",
        "en",
        units,
        ProviderMetadata("fake", "fake-translation-v1"),
        "context-v1",
    )

    with pytest.raises(ProviderResponseError):
        validate_translation(result, transcript)


@pytest.mark.parametrize("text", ["", "bad\x00text", "<script>alert(1)</script>"])
def test_translation_validator_rejects_empty_control_or_html(text: str) -> None:
    transcript = validate_transcript(valid_transcript())
    units = (
        TranslationUnit("s000001", text),
        TranslationUnit("s000002", "valid"),
    )
    result = TranslationResult(
        "zh",
        "en",
        units,
        ProviderMetadata("fake", "fake-translation-v1"),
        "context-v1",
    )

    with pytest.raises(ProviderResponseError):
        validate_translation(result, transcript)


def test_translation_validator_handles_malformed_unit_with_stable_error() -> None:
    transcript = validate_transcript(valid_transcript())
    malformed = TranslationResult(
        "zh",
        "en",
        (object(),),  # type: ignore[arg-type]
        ProviderMetadata("fake", "fake-translation-v1"),
        "context-v1",
    )

    with pytest.raises(ProviderResponseError, match="invalid segment"):
        validate_translation(malformed, transcript)


def test_subtitle_merge_only_trusts_provider_english() -> None:
    transcript = validate_transcript(valid_transcript())
    translation = validate_translation(valid_translation(transcript), transcript)

    subtitles = TranslationValidator.build_subtitles(transcript, translation)

    assert [subtitle.segment_id for subtitle in subtitles] == ["s000001", "s000002"]
    assert subtitles[0].start == transcript.segments[0].start
    assert subtitles[0].end == transcript.segments[0].end
    assert subtitles[0].zh == transcript.segments[0].text
    assert subtitles[0].en == "English 1"


def test_factory_refuses_to_pretend_unimplemented_real_adapter_exists(tmp_path: Path) -> None:
    settings = Settings(
        audio_dir=tmp_path / "audio",
        media_temp_dir=tmp_path / "temp",
        language_cache_dir=tmp_path / "cache",
        asr_provider="vendor",
        asr_api_key="secret",
    )

    with pytest.raises(ValueError, match="real adapter is not implemented"):
        build_language_processing_service(settings)
    assert "secret" not in repr(settings)


def test_all_public_language_errors_share_a_stable_safe_base() -> None:
    assert issubclass(ProviderTimeoutError, LanguageProcessingError)
    assert issubclass(NoSpeechError, LanguageProcessingError)
    assert issubclass(ProviderResponseError, LanguageProcessingError)
