from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, replace
from threading import RLock
from uuid import uuid4

from app.schemas.video import DubSegment, TaskResponse, TaskStatus


@dataclass(frozen=True, slots=True)
class TaskRecord:
    task_id: str
    video_key: str
    video_url: str
    status: TaskStatus = TaskStatus.PROCESSING
    progress: int = 0
    audio_url: str | None = None
    error: str | None = None
    segments: tuple[DubSegment, ...] = ()

    def to_response(self) -> TaskResponse:
        return TaskResponse(
            task_id=self.task_id,
            status=self.status,
            progress=self.progress,
            audio_url=self.audio_url,
            error=self.error,
            segments=list(self.segments),
        )


class TaskStore:
    """Thread-safe in-memory task metadata and state transitions."""

    def __init__(self) -> None:
        self._records: dict[str, TaskRecord] = {}
        self._source_index: dict[tuple[str, str], str] = {}
        self._lock = RLock()

    def create(self, video_key: str, video_url: str) -> TaskRecord:
        with self._lock:
            record = self._new_record(video_key, video_url)
            self._records[record.task_id] = record
            self._source_index[(video_key, video_url)] = record.task_id
        return record

    def create_or_get(
        self,
        video_key: str,
        video_url: str,
    ) -> tuple[TaskRecord, bool]:
        source = (video_key, video_url)
        with self._lock:
            existing_id = self._source_index.get(source)
            existing = self._records.get(existing_id) if existing_id else None
            if existing is not None and existing.status is not TaskStatus.ERROR:
                return existing, False
            record = self._new_record(video_key, video_url)
            self._records[record.task_id] = record
            self._source_index[source] = record.task_id
            return record, True

    def create_or_get_and_submit(
        self,
        video_key: str,
        video_url: str,
        submit: Callable[[str], None],
    ) -> tuple[TaskRecord, bool]:
        source = (video_key, video_url)
        with self._lock:
            existing_id = self._source_index.get(source)
            existing = self._records.get(existing_id) if existing_id else None
            if existing is not None and existing.status is not TaskStatus.ERROR:
                return existing, False

            record = self._new_record(video_key, video_url)
            self._records[record.task_id] = record
            self._source_index[source] = record.task_id
            try:
                # Keep the record private behind this lock until queue capacity
                # has been reserved. A worker may start immediately, but its get()
                # waits for this atomic publication to finish.
                submit(record.task_id)
            except Exception:
                self._records.pop(record.task_id, None)
                if self._source_index.get(source) == record.task_id:
                    self._source_index.pop(source, None)
                raise
            return record, True

    def get(self, task_id: str) -> TaskRecord | None:
        with self._lock:
            return self._records.get(task_id)

    def update_progress(self, task_id: str, progress: int) -> TaskRecord | None:
        if not 0 <= progress <= 99:
            raise ValueError("processing progress must be between 0 and 99")
        with self._lock:
            current = self._records.get(task_id)
            if current is None or current.status is not TaskStatus.PROCESSING:
                return current
            updated = replace(current, progress=max(current.progress, progress))
            self._records[task_id] = updated
            return updated

    def mark_ready(self, task_id: str, audio_url: str) -> TaskRecord | None:
        with self._lock:
            current = self._records.get(task_id)
            if current is None or current.status is not TaskStatus.PROCESSING:
                return current
            updated = replace(
                current,
                status=TaskStatus.READY,
                progress=100,
                audio_url=audio_url,
                error=None,
            )
            self._records[task_id] = updated
            return updated

    def mark_error(self, task_id: str, error: str) -> TaskRecord | None:
        public_error = error.strip()[:256] or "Media processing failed"
        with self._lock:
            current = self._records.get(task_id)
            if current is None or current.status is not TaskStatus.PROCESSING:
                return current
            updated = replace(
                current,
                status=TaskStatus.ERROR,
                audio_url=None,
                error=public_error,
            )
            self._records[task_id] = updated
            return updated

    def delete(self, task_id: str) -> bool:
        with self._lock:
            removed = self._records.pop(task_id, None)
            if removed is None:
                return False
            source = (removed.video_key, removed.video_url)
            if self._source_index.get(source) == task_id:
                self._source_index.pop(source, None)
            return True

    def clear(self) -> None:
        with self._lock:
            self._records.clear()
            self._source_index.clear()

    @staticmethod
    def _new_record(video_key: str, video_url: str) -> TaskRecord:
        return TaskRecord(
            task_id=uuid4().hex,
            video_key=video_key,
            video_url=video_url,
        )
