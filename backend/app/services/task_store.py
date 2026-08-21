from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, replace
from threading import RLock
from uuid import uuid4

from app.schemas.video import (
    ProcessVideoResponse,
    SubtitleSegment as ApiSubtitleSegment,
    TaskResponse,
    TaskStage,
    TaskStepResponse,
    TaskStepsResponse,
    TaskStepStatus,
    TaskStatus,
    TranscriptSegment as ApiTranscriptSegment,
)
from app.services.language_processing.models import SubtitleSegment, TranscriptSegment


@dataclass(frozen=True, slots=True)
class TaskStepRecord:
    status: TaskStepStatus = TaskStepStatus.PENDING
    cache_hit: bool | None = None

    def to_response(self) -> TaskStepResponse:
        return TaskStepResponse(status=self.status, cache_hit=self.cache_hit)


@dataclass(frozen=True, slots=True)
class TaskRecord:
    task_id: str
    video_key: str
    video_url: str
    status: TaskStatus = TaskStatus.PROCESSING
    stage: TaskStage = TaskStage.FETCHING
    progress: int = 0
    asr_step: TaskStepRecord = TaskStepRecord()
    translation_step: TaskStepRecord = TaskStepRecord()
    transcript: tuple[TranscriptSegment, ...] = ()
    subtitles: tuple[SubtitleSegment, ...] = ()
    audio_url: str | None = None
    error: str | None = None

    def to_response(self) -> TaskResponse:
        return TaskResponse(
            task_id=self.task_id,
            status=self.status,
            stage=self.stage,
            progress=self.progress,
            steps=TaskStepsResponse(
                asr=self.asr_step.to_response(),
                translation=self.translation_step.to_response(),
            ),
            transcript=[
                ApiTranscriptSegment(
                    segment_id=segment.segment_id,
                    start=segment.start,
                    end=segment.end,
                    text=segment.text,
                )
                for segment in self.transcript
            ],
            subtitles=[
                ApiSubtitleSegment(
                    segment_id=segment.segment_id,
                    start=segment.start,
                    end=segment.end,
                    zh=segment.zh,
                    en=segment.en,
                )
                for segment in self.subtitles
            ],
            segments=[],
            audio_url=self.audio_url,
            error=self.error,
        )

    def to_process_response(self, *, task_reused: bool) -> ProcessVideoResponse:
        response = self.to_response()
        return ProcessVideoResponse(
            **response.model_dump(),
            task_reused=task_reused,
        )


class TaskStore:
    """Thread-safe in-memory task metadata with atomic Phase 6 publications."""

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
                # Queue reservation and task publication are one critical section.
                # A worker may start immediately, but its get() waits for this lock.
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
            current = self._processing_record(task_id)
            if current is None:
                return self._records.get(task_id)
            return self._publish(replace(current, progress=max(current.progress, progress)))

    def mark_extracting(self, task_id: str, *, progress: int = 40) -> TaskRecord | None:
        with self._lock:
            current = self._processing_record(task_id)
            if current is None:
                return self._records.get(task_id)
            if current.stage is not TaskStage.FETCHING:
                raise ValueError("task is not fetching media")
            return self._publish(
                replace(
                    current,
                    stage=TaskStage.EXTRACTING,
                    progress=max(current.progress, progress),
                )
            )

    def mark_transcribing(
        self,
        task_id: str,
        audio_url: str,
        *,
        progress: int = 65,
    ) -> TaskRecord | None:
        if not audio_url.startswith("/audio/") or not audio_url.endswith("/audio.wav"):
            raise ValueError("audio_url must reference a task WAV")
        with self._lock:
            current = self._processing_record(task_id)
            if current is None:
                return self._records.get(task_id)
            if current.stage is not TaskStage.EXTRACTING:
                raise ValueError("task is not extracting audio")
            return self._publish(
                replace(
                    current,
                    stage=TaskStage.TRANSCRIBING,
                    progress=max(current.progress, progress),
                    audio_url=audio_url,
                    asr_step=TaskStepRecord(TaskStepStatus.PROCESSING),
                )
            )

    def mark_transcript_ready(
        self,
        task_id: str,
        transcript: tuple[TranscriptSegment, ...],
        *,
        cache_hit: bool,
        progress: int = 85,
    ) -> TaskRecord | None:
        if not transcript:
            raise ValueError("transcript must not be empty")
        with self._lock:
            current = self._processing_record(task_id)
            if current is None:
                return self._records.get(task_id)
            if current.stage is not TaskStage.TRANSCRIBING:
                raise ValueError("task is not transcribing")
            return self._publish(
                replace(
                    current,
                    stage=TaskStage.TRANSLATING,
                    progress=max(current.progress, progress),
                    asr_step=TaskStepRecord(TaskStepStatus.READY, cache_hit),
                    translation_step=TaskStepRecord(TaskStepStatus.PROCESSING),
                    transcript=tuple(transcript),
                    subtitles=(),
                )
            )

    def mark_ready(
        self,
        task_id: str,
        subtitles: tuple[SubtitleSegment, ...],
        *,
        translation_cache_hit: bool,
    ) -> TaskRecord | None:
        if not subtitles:
            raise ValueError("subtitles must not be empty")
        with self._lock:
            current = self._processing_record(task_id)
            if current is None:
                return self._records.get(task_id)
            if current.stage is not TaskStage.TRANSLATING:
                raise ValueError("task is not translating")
            return self._publish(
                replace(
                    current,
                    status=TaskStatus.READY,
                    stage=TaskStage.READY,
                    progress=100,
                    translation_step=TaskStepRecord(
                        TaskStepStatus.READY,
                        translation_cache_hit,
                    ),
                    subtitles=tuple(subtitles),
                    error=None,
                )
            )

    def mark_error(
        self,
        task_id: str,
        error: str,
        *,
        failed_cache_hit: bool | None = None,
    ) -> TaskRecord | None:
        if failed_cache_hit is True:
            raise ValueError("failed step cannot report a cache hit")
        public_error = error.strip()[:256] or "Task processing failed"
        with self._lock:
            current = self._processing_record(task_id)
            if current is None:
                return self._records.get(task_id)

            if current.stage in {TaskStage.FETCHING, TaskStage.EXTRACTING}:
                updated = replace(
                    current,
                    status=TaskStatus.ERROR,
                    asr_step=TaskStepRecord(TaskStepStatus.SKIPPED),
                    translation_step=TaskStepRecord(TaskStepStatus.SKIPPED),
                    transcript=(),
                    subtitles=(),
                    error=public_error,
                )
            elif current.stage is TaskStage.TRANSCRIBING:
                updated = replace(
                    current,
                    status=TaskStatus.ERROR,
                    asr_step=TaskStepRecord(TaskStepStatus.ERROR, failed_cache_hit),
                    translation_step=TaskStepRecord(TaskStepStatus.SKIPPED),
                    transcript=(),
                    subtitles=(),
                    error=public_error,
                )
            elif current.stage is TaskStage.TRANSLATING:
                updated = replace(
                    current,
                    status=TaskStatus.ERROR,
                    translation_step=TaskStepRecord(
                        TaskStepStatus.ERROR,
                        failed_cache_hit,
                    ),
                    subtitles=(),
                    error=public_error,
                )
            else:
                return current
            return self._publish(updated)

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

    def _processing_record(self, task_id: str) -> TaskRecord | None:
        current = self._records.get(task_id)
        if current is None or current.status is not TaskStatus.PROCESSING:
            return None
        return current

    def _publish(self, updated: TaskRecord) -> TaskRecord:
        # Validate the complete snapshot before exposing it to concurrent readers.
        updated.to_response()
        self._records[updated.task_id] = updated
        return updated

    @staticmethod
    def _new_record(video_key: str, video_url: str) -> TaskRecord:
        return TaskRecord(
            task_id=uuid4().hex,
            video_key=video_key,
            video_url=video_url,
        )
