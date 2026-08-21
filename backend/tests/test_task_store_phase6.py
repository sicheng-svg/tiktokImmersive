from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from threading import Event

import pytest

from app.schemas.video import TaskResponse, TaskStage, TaskStatus, TaskStepStatus
from app.services.language_processing.models import SubtitleSegment, TranscriptSegment
from app.services.task_store import TaskStore


TRANSCRIPT = (
    TranscriptSegment("s000001", 0.0, 1.0, "第一段"),
    TranscriptSegment("s000002", 1.0, 2.0, "第二段"),
)
SUBTITLES = (
    SubtitleSegment("s000001", 0.0, 1.0, "第一段", "First"),
    SubtitleSegment("s000002", 1.0, 2.0, "第二段", "Second"),
)


def advance_to_transcribing(store: TaskStore, task_id: str) -> None:
    store.update_progress(task_id, 5)
    store.mark_extracting(task_id)
    store.mark_transcribing(task_id, f"/audio/{task_id}/audio.wav")


def test_task_store_publishes_only_complete_phase_six_snapshots() -> None:
    store = TaskStore()
    record = store.create("video:key", "https://example.com/video")

    initial = record.to_response()
    assert initial.stage is TaskStage.FETCHING
    assert initial.steps.asr.status is TaskStepStatus.PENDING
    advance_to_transcribing(store, record.task_id)
    transcribing = store.get(record.task_id)
    assert transcribing is not None
    assert transcribing.stage is TaskStage.TRANSCRIBING
    assert transcribing.audio_url is not None
    assert transcribing.transcript == ()

    store.mark_transcript_ready(record.task_id, TRANSCRIPT, cache_hit=True)
    translating = store.get(record.task_id)
    assert translating is not None
    assert translating.stage is TaskStage.TRANSLATING
    assert translating.asr_step.cache_hit is True
    assert translating.translation_step.status is TaskStepStatus.PROCESSING
    assert translating.transcript == TRANSCRIPT
    assert translating.subtitles == ()

    store.update_progress(record.task_id, 95)
    store.mark_ready(record.task_id, SUBTITLES, translation_cache_hit=False)
    ready = store.get(record.task_id)
    assert ready is not None
    assert ready.status is TaskStatus.READY
    assert ready.stage is TaskStage.READY
    assert ready.progress == 100
    assert ready.translation_step.cache_hit is False
    ready.to_response()


@pytest.mark.parametrize(
    ("stage", "asr_status", "translation_status"),
    [
        (TaskStage.FETCHING, TaskStepStatus.SKIPPED, TaskStepStatus.SKIPPED),
        (TaskStage.EXTRACTING, TaskStepStatus.SKIPPED, TaskStepStatus.SKIPPED),
        (TaskStage.TRANSCRIBING, TaskStepStatus.ERROR, TaskStepStatus.SKIPPED),
    ],
)
def test_failure_matrix_before_translation(stage, asr_status, translation_status) -> None:
    store = TaskStore()
    record = store.create("video:key", "https://example.com/video")
    if stage in {TaskStage.EXTRACTING, TaskStage.TRANSCRIBING}:
        store.mark_extracting(record.task_id)
    if stage is TaskStage.TRANSCRIBING:
        store.mark_transcribing(record.task_id, f"/audio/{record.task_id}/audio.wav")

    store.mark_error(record.task_id, "safe failure", failed_cache_hit=False)
    failed = store.get(record.task_id)

    assert failed is not None
    assert failed.status is TaskStatus.ERROR
    assert failed.stage is stage
    assert failed.asr_step.status is asr_status
    assert failed.translation_step.status is translation_status
    assert failed.transcript == failed.subtitles == ()
    if stage is TaskStage.TRANSCRIBING:
        assert failed.audio_url == f"/audio/{record.task_id}/audio.wav"
    else:
        assert failed.audio_url is None
    failed.to_response()


def test_translation_failure_atomically_preserves_transcript_and_wav() -> None:
    store = TaskStore()
    record = store.create("video:key", "https://example.com/video")
    advance_to_transcribing(store, record.task_id)
    store.mark_transcript_ready(record.task_id, TRANSCRIPT, cache_hit=False)

    store.mark_error(record.task_id, "Translation failed", failed_cache_hit=False)
    failed = store.get(record.task_id)

    assert failed is not None
    assert failed.status is TaskStatus.ERROR
    assert failed.stage is TaskStage.TRANSLATING
    assert failed.audio_url == f"/audio/{record.task_id}/audio.wav"
    assert failed.transcript == TRANSCRIPT
    assert failed.subtitles == ()
    assert failed.asr_step == failed.asr_step.__class__(TaskStepStatus.READY, False)
    assert failed.translation_step.status is TaskStepStatus.ERROR
    failed.to_response()


def test_failed_step_rejects_true_cache_hit_in_store_and_response_schema() -> None:
    store = TaskStore()
    record = store.create("video:key", "https://example.com/video")
    advance_to_transcribing(store, record.task_id)

    with pytest.raises(ValueError, match="cannot report a cache hit"):
        store.mark_error(record.task_id, "ASR failed", failed_cache_hit=True)
    unchanged = store.get(record.task_id)
    assert unchanged is not None
    assert unchanged.status is TaskStatus.PROCESSING

    store.mark_error(record.task_id, "ASR failed", failed_cache_hit=False)
    failed = store.get(record.task_id)
    assert failed is not None
    payload = failed.to_response().model_dump()
    payload["steps"]["asr"]["cache_hit"] = True
    with pytest.raises(ValueError, match="cannot report a cache hit"):
        TaskResponse.model_validate(payload)


def test_invalid_subtitle_publication_is_rejected_without_corrupting_record() -> None:
    store = TaskStore()
    record = store.create("video:key", "https://example.com/video")
    advance_to_transcribing(store, record.task_id)
    store.mark_transcript_ready(record.task_id, TRANSCRIPT, cache_hit=False)
    invalid = (
        SubtitleSegment("s000001", 0.0, 1.0, "modified", "First"),
        SUBTITLES[1],
    )

    with pytest.raises(ValueError, match="do not match"):
        store.mark_ready(record.task_id, invalid, translation_cache_hit=False)

    unchanged = store.get(record.task_id)
    assert unchanged is not None
    assert unchanged.status is TaskStatus.PROCESSING
    assert unchanged.stage is TaskStage.TRANSLATING
    assert unchanged.subtitles == ()


def test_concurrent_readers_never_observe_partial_transition() -> None:
    store = TaskStore()
    record = store.create("video:key", "https://example.com/video")
    start = Event()

    def reader(_index: int) -> None:
        start.wait(timeout=1)
        for _ in range(100):
            snapshot = store.get(record.task_id)
            assert snapshot is not None
            snapshot.to_response()

    with ThreadPoolExecutor(max_workers=8) as executor:
        futures = [executor.submit(reader, index) for index in range(8)]
        start.set()
        advance_to_transcribing(store, record.task_id)
        store.mark_transcript_ready(record.task_id, TRANSCRIPT, cache_hit=False)
        store.mark_ready(record.task_id, SUBTITLES, translation_cache_hit=False)
        for future in futures:
            future.result(timeout=2)
