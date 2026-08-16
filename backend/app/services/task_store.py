from __future__ import annotations

from dataclasses import dataclass
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
    segments: tuple[DubSegment, ...] = ()

    def to_response(self) -> TaskResponse:
        return TaskResponse(
            task_id=self.task_id,
            status=self.status,
            progress=self.progress,
            segments=list(self.segments),
        )


class TaskStore:
    """Thread-safe in-memory task metadata for the Phase 4 API skeleton."""

    def __init__(self) -> None:
        self._records: dict[str, TaskRecord] = {}
        self._lock = RLock()

    def create(self, video_key: str, video_url: str) -> TaskRecord:
        record = TaskRecord(
            task_id=uuid4().hex,
            video_key=video_key,
            video_url=video_url,
        )
        with self._lock:
            self._records[record.task_id] = record
        return record

    def get(self, task_id: str) -> TaskRecord | None:
        with self._lock:
            return self._records.get(task_id)

    def clear(self) -> None:
        with self._lock:
            self._records.clear()
