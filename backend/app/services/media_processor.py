from __future__ import annotations

import logging
import re
from concurrent.futures import Future, ThreadPoolExecutor
from pathlib import Path
from threading import BoundedSemaphore, Lock
from typing import Protocol

from app.services.ffmpeg import AudioExtractionError
from app.services.media_downloader import MediaDownloadError
from app.services.task_store import TaskStore


logger = logging.getLogger(__name__)
TASK_ID_PATTERN = re.compile(r"^[a-f0-9]{32}$")


class Downloader(Protocol):
    def download(self, url: str, destination: Path) -> None: ...


class AudioExtractor(Protocol):
    def extract(self, source: Path, destination: Path) -> None: ...


class ProcessingCapacityError(RuntimeError):
    pass


class MediaTaskProcessor:
    def __init__(
        self,
        *,
        task_store: TaskStore,
        downloader: Downloader,
        audio_extractor: AudioExtractor,
        media_temp_dir: Path,
        audio_dir: Path,
        max_concurrent_jobs: int,
        max_pending_jobs: int,
    ) -> None:
        if max_concurrent_jobs <= 0:
            raise ValueError("max_concurrent_jobs must be greater than zero")
        if max_pending_jobs < max_concurrent_jobs:
            raise ValueError("max_pending_jobs must be at least max_concurrent_jobs")
        self._task_store = task_store
        self._downloader = downloader
        self._audio_extractor = audio_extractor
        self._media_temp_dir = media_temp_dir.resolve()
        self._audio_dir = audio_dir.resolve()
        self._executor = ThreadPoolExecutor(
            max_workers=max_concurrent_jobs,
            thread_name_prefix="media-task",
        )
        self._capacity = BoundedSemaphore(max_pending_jobs)
        self._futures: dict[str, Future[None]] = {}
        self._state_lock = Lock()
        self._closed = False

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
        self._executor.shutdown(wait=True, cancel_futures=False)
        close = getattr(self._downloader, "close", None)
        if callable(close):
            close()

    def _finish(self, task_id: str, _future: Future[None]) -> None:
        with self._state_lock:
            self._futures.pop(task_id, None)
        self._capacity.release()

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
        succeeded = False

        try:
            task_temp_dir.mkdir(parents=True, exist_ok=True)
            task_audio_dir.mkdir(parents=True, exist_ok=True)
            self._task_store.update_progress(task_id, 5)
            self._downloader.download(record.video_url, source)
            self._task_store.update_progress(task_id, 60)
            self._audio_extractor.extract(source, destination)
            if not destination.is_file():
                raise AudioExtractionError("Audio extraction did not produce a file")
            self._task_store.mark_ready(task_id, f"/audio/{task_id}/audio.wav")
            succeeded = True
        except (MediaDownloadError, AudioExtractionError) as exc:
            self._task_store.mark_error(task_id, str(exc))
        except Exception:
            logger.exception("Unexpected media processing failure for task %s", task_id)
            self._task_store.mark_error(task_id, "Media processing failed")
        finally:
            source.unlink(missing_ok=True)
            try:
                task_temp_dir.rmdir()
            except OSError:
                pass
            if not succeeded:
                destination.unlink(missing_ok=True)
                (task_audio_dir / "audio.part.wav").unlink(missing_ok=True)
                try:
                    task_audio_dir.rmdir()
                except OSError:
                    pass
