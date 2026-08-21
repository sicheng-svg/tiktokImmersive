from __future__ import annotations

import logging
import re
import time
from concurrent.futures import Future, ThreadPoolExecutor, wait as wait_for_futures
from pathlib import Path
from threading import BoundedSemaphore, Lock
from typing import Protocol

from app.services.ffmpeg import AudioExtractionError
from app.services.language_processing.errors import (
    LanguageProcessingError,
    ProviderUnavailableError,
    stable_public_error,
)
from app.services.language_processing.models import (
    ASROutcome,
    TranscriptResult,
    TranslationOutcome,
)
from app.services.language_processing.validation import inspect_wav
from app.services.media_downloader import MediaDownloadError
from app.services.task_store import TaskStore


logger = logging.getLogger(__name__)
TASK_ID_PATTERN = re.compile(r"^[a-f0-9]{32}$")


class Downloader(Protocol):
    def download(self, url: str, destination: Path) -> None: ...


class AudioExtractor(Protocol):
    def extract(self, source: Path, destination: Path) -> None: ...


class LanguageProcessor(Protocol):
    asr_provider_name: str
    translation_provider_name: str

    def transcribe(self, audio_path: Path) -> ASROutcome: ...

    def translate(self, transcript: TranscriptResult) -> TranslationOutcome: ...

    def close(self) -> None: ...


class ProcessingCapacityError(RuntimeError):
    pass


class MediaTaskProcessor:
    def __init__(
        self,
        *,
        task_store: TaskStore,
        downloader: Downloader,
        audio_extractor: AudioExtractor,
        language_processor: LanguageProcessor,
        media_temp_dir: Path,
        audio_dir: Path,
        max_concurrent_jobs: int,
        max_pending_jobs: int,
        shutdown_grace_seconds: float = 10.0,
    ) -> None:
        if max_concurrent_jobs <= 0:
            raise ValueError("max_concurrent_jobs must be greater than zero")
        if max_pending_jobs < max_concurrent_jobs:
            raise ValueError("max_pending_jobs must be at least max_concurrent_jobs")
        if shutdown_grace_seconds <= 0:
            raise ValueError("shutdown_grace_seconds must be greater than zero")
        self._task_store = task_store
        self._downloader = downloader
        self._audio_extractor = audio_extractor
        self._language_processor = language_processor
        self._media_temp_dir = media_temp_dir.resolve()
        self._audio_dir = audio_dir.resolve()
        self._shutdown_grace_seconds = shutdown_grace_seconds
        self._executor = ThreadPoolExecutor(
            max_workers=max_concurrent_jobs,
            thread_name_prefix="media-task",
        )
        self._capacity = BoundedSemaphore(max_pending_jobs)
        self._futures: dict[str, Future[None]] = {}
        self._state_lock = Lock()
        self._closed = False
        self._resources_closed = False

    def submit(self, task_id: str) -> None:
        if not self._capacity.acquire(blocking=False):
            raise ProcessingCapacityError("Media processing queue is full")
        with self._state_lock:
            if self._closed:
                self._capacity.release()
                raise ProcessingCapacityError("Media processor is shutting down")
            try:
                future = self._executor.submit(self._process, task_id)
            except RuntimeError as exc:
                self._capacity.release()
                raise ProcessingCapacityError("Media processor is unavailable") from exc
            self._futures[task_id] = future
        future.add_done_callback(lambda completed: self._finish(task_id, completed))

    def wait(self, task_id: str, timeout: float | None = None) -> None:
        with self._state_lock:
            future = self._futures.get(task_id)
        if future is not None:
            future.result(timeout=timeout)

    def shutdown(self) -> None:
        with self._state_lock:
            if self._closed:
                return
            self._closed = True
            future_items = tuple(self._futures.items())

        futures = tuple(future for _task_id, future in future_items)
        if futures:
            _done, unfinished = wait_for_futures(
                futures,
                timeout=self._shutdown_grace_seconds,
            )
            for task_id, future in future_items:
                if future in unfinished and future.cancel():
                    self._task_store.mark_error(
                        task_id,
                        "Task was cancelled during service shutdown",
                    )
        self._executor.shutdown(wait=False, cancel_futures=True)
        self._close_resources_if_idle()

    def _finish(self, task_id: str, _future: Future[None]) -> None:
        with self._state_lock:
            self._futures.pop(task_id, None)
        self._capacity.release()
        self._close_resources_if_idle()

    def _process(self, task_id: str) -> None:
        record = self._task_store.get(task_id)
        if record is None:
            return
        if not TASK_ID_PATTERN.fullmatch(task_id):
            self._task_store.mark_error(task_id, "Task identifier is invalid")
            return

        task_temp_dir = self._media_temp_dir / task_id
        task_audio_dir = self._audio_dir / task_id
        source = task_temp_dir / "source.media"
        destination = task_audio_dir / "audio.wav"
        audio_ready = False

        try:
            task_temp_dir.mkdir(parents=True, exist_ok=True)
            task_audio_dir.mkdir(parents=True, exist_ok=True)
            self._task_store.update_progress(task_id, 5)
            self._downloader.download(record.video_url, source)
            self._task_store.mark_extracting(task_id, progress=40)
            self._audio_extractor.extract(source, destination)
            if not destination.is_file():
                raise AudioExtractionError("Audio extraction did not produce a file")
            try:
                inspect_wav(destination)
            except LanguageProcessingError as exc:
                raise AudioExtractionError("Audio extraction produced an invalid WAV file") from exc

            audio_url = f"/audio/{task_id}/audio.wav"
            self._task_store.mark_transcribing(task_id, audio_url, progress=65)
            audio_ready = True

            stage_started = time.monotonic()
            asr = self._transcribe(destination)
            logger.info(
                "Task %s ASR provider=%s segments=%d cache_hit=%s elapsed_ms=%d",
                task_id,
                self._language_processor.asr_provider_name,
                len(asr.result.segments),
                asr.cache_hit,
                round((time.monotonic() - stage_started) * 1000),
            )
            self._task_store.mark_transcript_ready(
                task_id,
                asr.result.segments,
                cache_hit=asr.cache_hit,
                progress=85,
            )

            stage_started = time.monotonic()
            translation = self._translate(asr.result)
            logger.info(
                "Task %s translation provider=%s segments=%d cache_hit=%s elapsed_ms=%d",
                task_id,
                self._language_processor.translation_provider_name,
                len(translation.subtitles),
                translation.cache_hit,
                round((time.monotonic() - stage_started) * 1000),
            )
            self._task_store.update_progress(task_id, 95)
            self._task_store.mark_ready(
                task_id,
                translation.subtitles,
                translation_cache_hit=translation.cache_hit,
            )
        except (MediaDownloadError, AudioExtractionError) as exc:
            self._task_store.mark_error(task_id, str(exc))
        except LanguageProcessingError as exc:
            logger.warning(
                "Task %s language stage failed: %s",
                task_id,
                type(exc).__name__,
            )
            self._task_store.mark_error(
                task_id,
                stable_public_error(exc),
                failed_cache_hit=exc.cache_hit,
            )
        except Exception:
            logger.exception("Unexpected processing failure for task %s", task_id)
            self._task_store.mark_error(task_id, "Media processing failed")
        finally:
            source.unlink(missing_ok=True)
            try:
                task_temp_dir.rmdir()
            except OSError:
                pass
            if not audio_ready:
                destination.unlink(missing_ok=True)
                (task_audio_dir / "audio.part.wav").unlink(missing_ok=True)
                try:
                    task_audio_dir.rmdir()
                except OSError:
                    pass

    @staticmethod
    def _close_safely(resource: object, label: str) -> None:
        close = getattr(resource, "close", None)
        if not callable(close):
            return
        try:
            close()
        except Exception:
            logger.warning("Failed to close %s", label)

    def _transcribe(self, audio_path: Path) -> ASROutcome:
        try:
            return self._language_processor.transcribe(audio_path)
        except LanguageProcessingError:
            raise
        except Exception:
            raise ProviderUnavailableError(
                "Speech recognition provider failed",
            ) from None

    def _translate(self, transcript: TranscriptResult) -> TranslationOutcome:
        try:
            return self._language_processor.translate(transcript)
        except LanguageProcessingError:
            raise
        except Exception:
            raise ProviderUnavailableError(
                "Translation provider failed",
            ) from None

    def _close_resources_if_idle(self) -> None:
        with self._state_lock:
            if (
                not self._closed
                or self._resources_closed
                or self._futures
            ):
                return
            self._resources_closed = True
        self._close_safely(self._language_processor, "language processor")
        self._close_safely(self._downloader, "media downloader")
