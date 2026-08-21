from __future__ import annotations

import logging
import time
import wave
from pathlib import Path
from threading import Event

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app
from app.schemas.video import TaskStage, TaskStatus, TaskStepStatus
from app.services.language_processing.cache import FileASRCache, FileTranslationCache
from app.services.language_processing.errors import ProviderTimeoutError
from app.services.language_processing.factory import build_language_processing_service
from app.services.language_processing.models import ASROutcome, TranslationOutcome
from app.services.language_processing.providers import (
    FakeASRProvider,
    FakeTranslationProvider,
)
from app.services.language_processing.service import LanguageProcessingService
from app.services.language_processing.validation import (
    TranscriptValidator,
    TranslationValidator,
)
from app.services.media_downloader import MediaDownloadError
from app.services.media_processor import MediaTaskProcessor, ProcessingCapacityError
from app.services.task_store import TaskStore


def write_wav(destination: Path, *, duration_seconds: float = 0.1) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(destination), "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(16000)
        audio.writeframes(b"\x00\x00" * int(16000 * duration_seconds))


class FakeDownloader:
    def __init__(self, error: str | None = None) -> None:
        self.error = error
        self.closed = False

    def download(self, _url: str, destination: Path) -> None:
        if self.error:
            raise MediaDownloadError(self.error)
        destination.write_bytes(b"source")

    def close(self) -> None:
        self.closed = True


class FakeExtractor:
    def __init__(self, *, invalid: bool = False) -> None:
        self.invalid = invalid

    def extract(self, _source: Path, destination: Path) -> None:
        if self.invalid:
            destination.write_bytes(b"not-a-wav")
        else:
            write_wav(destination)


class FailingTranslationLanguageProcessor:
    def __init__(self, delegate) -> None:
        self._delegate = delegate

    @property
    def asr_provider_name(self) -> str:
        return self._delegate.asr_provider_name

    @property
    def translation_provider_name(self) -> str:
        return self._delegate.translation_provider_name

    def transcribe(self, audio_path: Path) -> ASROutcome:
        return self._delegate.transcribe(audio_path)

    def translate(self, _transcript) -> TranslationOutcome:
        raise ProviderTimeoutError("Translation service timed out", cache_hit=False)

    def close(self) -> None:
        self._delegate.close()


class FailingAsrLanguageProcessor:
    asr_provider_name = "fake"
    translation_provider_name = "fake"

    def transcribe(self, _audio_path: Path) -> ASROutcome:
        raise ProviderTimeoutError("Speech recognition service timed out", cache_hit=False)

    def translate(self, _transcript) -> TranslationOutcome:
        raise AssertionError("translation must not run after ASR failure")

    def close(self) -> None:
        return None


def build_language_processor(tmp_path: Path):
    return build_language_processing_service(
        Settings(
            audio_dir=tmp_path / "audio",
            media_temp_dir=tmp_path / "temp",
            language_cache_dir=tmp_path / "cache",
        )
    )


def build_custom_language_processor(tmp_path: Path, *, asr_provider):
    return LanguageProcessingService(
        asr_provider=asr_provider,
        translation_provider=FakeTranslationProvider(),
        asr_cache=FileASRCache(tmp_path / "cache" / "asr"),
        translation_cache=FileTranslationCache(tmp_path / "cache" / "translation"),
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


def build_processor(
    tmp_path: Path,
    store: TaskStore,
    downloader=None,
    *,
    extractor=None,
    language_processor=None,
    max_concurrent: int = 1,
    max_pending: int = 2,
    shutdown_grace_seconds: float = 1.0,
) -> MediaTaskProcessor:
    return MediaTaskProcessor(
        task_store=store,
        downloader=downloader or FakeDownloader(),
        audio_extractor=extractor or FakeExtractor(),
        language_processor=language_processor or build_language_processor(tmp_path),
        media_temp_dir=tmp_path / "temp",
        audio_dir=tmp_path / "audio",
        max_concurrent_jobs=max_concurrent,
        max_pending_jobs=max_pending,
        shutdown_grace_seconds=shutdown_grace_seconds,
    )


def test_processor_runs_fake_asr_and_translation_to_ready(tmp_path: Path) -> None:
    store = TaskStore()
    record = store.create("video:1", "https://cdn.douyinvod.com/video")
    processor = build_processor(tmp_path, store)
    try:
        processor.submit(record.task_id)
        processor.wait(record.task_id, timeout=2)
    finally:
        processor.shutdown()

    completed = store.get(record.task_id)
    assert completed is not None
    assert completed.status is TaskStatus.READY
    assert completed.stage is TaskStage.READY
    assert completed.progress == 100
    assert completed.audio_url == f"/audio/{record.task_id}/audio.wav"
    assert completed.error is None
    assert completed.asr_step.status is TaskStepStatus.READY
    assert completed.asr_step.cache_hit is False
    assert completed.translation_step.status is TaskStepStatus.READY
    assert completed.translation_step.cache_hit is False
    assert completed.transcript[0].segment_id == "s000001"
    assert "假转写" in completed.transcript[0].text
    assert completed.subtitles[0].en.startswith("[FAKE TRANSLATION]")
    assert (tmp_path / "audio" / record.task_id / "audio.wav").is_file()
    assert not (tmp_path / "temp" / record.task_id).exists()


def test_download_failure_skips_language_steps_and_removes_outputs(tmp_path: Path) -> None:
    store = TaskStore()
    record = store.create("video:2", "https://cdn.douyinvod.com/video")
    processor = build_processor(
        tmp_path,
        store,
        downloader=FakeDownloader("Media host is not allowed"),
    )
    try:
        processor.submit(record.task_id)
        processor.wait(record.task_id, timeout=2)
    finally:
        processor.shutdown()

    failed = store.get(record.task_id)
    assert failed is not None
    assert failed.status is TaskStatus.ERROR
    assert failed.stage is TaskStage.FETCHING
    assert failed.asr_step.status is TaskStepStatus.SKIPPED
    assert failed.translation_step.status is TaskStepStatus.SKIPPED
    assert failed.audio_url is None
    assert failed.error == "Media host is not allowed"
    assert not (tmp_path / "audio" / record.task_id).exists()
    assert not (tmp_path / "temp" / record.task_id).exists()


def test_invalid_extracted_wav_fails_in_extracting_stage(tmp_path: Path) -> None:
    store = TaskStore()
    record = store.create("video:invalid", "https://cdn.douyinvod.com/video")
    processor = build_processor(tmp_path, store, extractor=FakeExtractor(invalid=True))
    try:
        processor.submit(record.task_id)
        processor.wait(record.task_id, timeout=2)
    finally:
        processor.shutdown()

    failed = store.get(record.task_id)
    assert failed is not None
    assert failed.status is TaskStatus.ERROR
    assert failed.stage is TaskStage.EXTRACTING
    assert failed.audio_url is None
    assert failed.transcript == ()
    assert failed.subtitles == ()


def test_asr_failure_preserves_wav_but_publishes_no_transcript(tmp_path: Path) -> None:
    store = TaskStore()
    record = store.create("video:asr-error", "https://cdn.douyinvod.com/video")
    processor = build_processor(
        tmp_path,
        store,
        language_processor=FailingAsrLanguageProcessor(),
    )
    try:
        processor.submit(record.task_id)
        processor.wait(record.task_id, timeout=2)
    finally:
        processor.shutdown()

    failed = store.get(record.task_id)
    assert failed is not None
    assert failed.status is TaskStatus.ERROR
    assert failed.stage is TaskStage.TRANSCRIBING
    assert failed.audio_url == f"/audio/{record.task_id}/audio.wav"
    assert failed.asr_step.status is TaskStepStatus.ERROR
    assert failed.asr_step.cache_hit is False
    assert failed.translation_step.status is TaskStepStatus.SKIPPED
    assert failed.transcript == ()
    assert (tmp_path / "audio" / record.task_id / "audio.wav").is_file()


def test_translation_failure_preserves_wav_and_transcript_without_subtitles(
    tmp_path: Path,
) -> None:
    store = TaskStore()
    record = store.create("video:translation-error", "https://cdn.douyinvod.com/video")
    language = FailingTranslationLanguageProcessor(build_language_processor(tmp_path))
    processor = build_processor(tmp_path, store, language_processor=language)
    try:
        processor.submit(record.task_id)
        processor.wait(record.task_id, timeout=2)
    finally:
        processor.shutdown()

    failed = store.get(record.task_id)
    assert failed is not None
    assert failed.status is TaskStatus.ERROR
    assert failed.stage is TaskStage.TRANSLATING
    assert failed.audio_url == f"/audio/{record.task_id}/audio.wav"
    assert failed.asr_step.status is TaskStepStatus.READY
    assert failed.translation_step.status is TaskStepStatus.ERROR
    assert failed.translation_step.cache_hit is False
    assert failed.transcript[0].segment_id == "s000001"
    assert failed.subtitles == ()
    assert (tmp_path / "audio" / record.task_id / "audio.wav").is_file()
    failed.to_response()


def test_unknown_provider_exception_cannot_leak_raw_response_or_secret(
    tmp_path: Path,
    caplog,
) -> None:
    secret = "api-key-super-secret"
    raw_response = "raw-provider-response-with-private-text"

    class LeakingASRProvider(FakeASRProvider):
        def transcribe(self, _audio_path: Path):
            raise RuntimeError(f"{secret}: {raw_response}")

    store = TaskStore()
    record = store.create("video:provider-error", "https://cdn.douyinvod.com/video")
    language = build_custom_language_processor(
        tmp_path,
        asr_provider=LeakingASRProvider(),
    )
    processor = build_processor(tmp_path, store, language_processor=language)
    caplog.set_level(logging.DEBUG)
    try:
        processor.submit(record.task_id)
        processor.wait(record.task_id, timeout=2)
    finally:
        processor.shutdown()

    failed = store.get(record.task_id)
    assert failed is not None
    response_json = failed.to_response().model_dump_json()
    assert failed.status is TaskStatus.ERROR
    assert failed.stage is TaskStage.TRANSCRIBING
    assert failed.error == "Language provider is unavailable"
    assert failed.asr_step.cache_hit is False
    assert "ProviderUnavailableError" in caplog.text
    assert "Unexpected processing failure" not in caplog.text
    for forbidden in (secret, raw_response):
        assert forbidden not in caplog.text
        assert forbidden not in response_json


def test_processor_rejects_work_when_bounded_queue_is_full(tmp_path: Path) -> None:
    started = Event()
    release = Event()

    class BlockingDownloader:
        def download(self, _url: str, destination: Path) -> None:
            started.set()
            assert release.wait(timeout=2)
            destination.write_bytes(b"source")

    store = TaskStore()
    first = store.create("video:1", "https://cdn.douyinvod.com/one")
    second = store.create("video:2", "https://cdn.douyinvod.com/two")
    processor = build_processor(
        tmp_path,
        store,
        downloader=BlockingDownloader(),
        max_concurrent=1,
        max_pending=1,
    )
    try:
        processor.submit(first.task_id)
        assert started.wait(timeout=2)
        with pytest.raises(ProcessingCapacityError, match="queue is full"):
            processor.submit(second.task_id)
        release.set()
        processor.wait(first.task_id, timeout=2)
    finally:
        release.set()
        processor.shutdown()


def test_shutdown_defers_resource_close_until_running_task_finishes(tmp_path: Path) -> None:
    entered = Event()
    release = Event()
    downloader_closed = Event()
    language_closed = Event()

    class TrackingDownloader(FakeDownloader):
        def close(self) -> None:
            super().close()
            downloader_closed.set()

    downloader = TrackingDownloader()
    delegate = build_language_processor(tmp_path)

    class BlockingLanguageProcessor:
        asr_provider_name = "fake"
        translation_provider_name = "fake"

        def transcribe(self, audio_path: Path) -> ASROutcome:
            entered.set()
            assert release.wait(timeout=2)
            return delegate.transcribe(audio_path)

        def translate(self, transcript) -> TranslationOutcome:
            return delegate.translate(transcript)

        def close(self) -> None:
            delegate.close()
            language_closed.set()

    store = TaskStore()
    record = store.create("video:shutdown", "https://cdn.douyinvod.com/video")
    processor = build_processor(
        tmp_path,
        store,
        downloader=downloader,
        language_processor=BlockingLanguageProcessor(),
        shutdown_grace_seconds=0.02,
    )
    processor.submit(record.task_id)
    assert entered.wait(timeout=2)

    started = time.monotonic()
    processor.shutdown()
    elapsed = time.monotonic() - started

    assert elapsed < 0.5
    assert downloader.closed is False
    assert language_closed.is_set() is False

    release.set()
    processor.wait(record.task_id, timeout=2)
    assert language_closed.wait(timeout=2)
    assert downloader_closed.wait(timeout=2)
    assert downloader.closed is True


def test_shutdown_cancels_queued_task_and_marks_it_error(tmp_path: Path) -> None:
    entered = Event()
    release = Event()

    class BlockingDownloader(FakeDownloader):
        def download(self, url: str, destination: Path) -> None:
            entered.set()
            assert release.wait(timeout=2)
            super().download(url, destination)

    store = TaskStore()
    running = store.create("video:running", "https://cdn.douyinvod.com/one")
    queued = store.create("video:queued", "https://cdn.douyinvod.com/two")
    processor = build_processor(
        tmp_path,
        store,
        downloader=BlockingDownloader(),
        max_concurrent=1,
        max_pending=2,
        shutdown_grace_seconds=0.02,
    )
    processor.submit(running.task_id)
    processor.submit(queued.task_id)
    assert entered.wait(timeout=2)

    processor.shutdown()
    cancelled = store.get(queued.task_id)
    release.set()
    processor.wait(running.task_id, timeout=2)

    assert cancelled is not None
    assert cancelled.status is TaskStatus.ERROR
    assert cancelled.stage is TaskStage.FETCHING
    assert cancelled.asr_step.status is TaskStepStatus.SKIPPED
    assert cancelled.translation_step.status is TaskStepStatus.SKIPPED


def test_api_ready_result_and_extracted_wav_are_accessible(tmp_path: Path) -> None:
    store = TaskStore()
    processor = build_processor(tmp_path, store)
    settings = Settings(
        audio_dir=tmp_path / "audio",
        media_temp_dir=tmp_path / "temp",
        language_cache_dir=tmp_path / "cache",
    )
    app = create_app(settings, task_store=store, media_processor=processor)

    try:
        with TestClient(app, base_url="http://localhost") as client:
            created_response = client.post(
                "/api/videos/process",
                json={
                    "video_key": "integration:1",
                    "video_url": "https://cdn.douyinvod.com/video.mp4",
                },
            )
            assert created_response.status_code == 202
            created = created_response.json()
            assert created["task_reused"] is False

            processor.wait(created["task_id"], timeout=2)
            task = client.get(f"/api/tasks/{created['task_id']}").json()
            assert task["status"] == "READY"
            assert task["stage"] == "READY"
            assert task["progress"] == 100
            assert task["error"] is None
            assert task["audio_url"] == f"/audio/{created['task_id']}/audio.wav"
            assert len(task["transcript"]) == len(task["subtitles"]) == 1
            assert task["segments"] == []

            audio = client.get(task["audio_url"])
            assert audio.status_code == 200
            assert audio.content.startswith(b"RIFF")
            assert audio.headers["content-type"] == "audio/wav"
    finally:
        processor.shutdown()
