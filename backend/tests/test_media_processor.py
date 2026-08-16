from __future__ import annotations

from pathlib import Path
from threading import Event

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app
from app.schemas.video import TaskStatus
from app.services.media_downloader import MediaDownloadError
from app.services.media_processor import MediaTaskProcessor, ProcessingCapacityError
from app.services.task_store import TaskStore


class FakeDownloader:
    def __init__(self, error: str | None = None) -> None:
        self.error = error

    def download(self, _url: str, destination: Path) -> None:
        if self.error:
            raise MediaDownloadError(self.error)
        destination.write_bytes(b"source")


class FakeExtractor:
    def extract(self, _source: Path, destination: Path) -> None:
        destination.write_bytes(b"wav")


def build_processor(
    tmp_path: Path,
    store: TaskStore,
    downloader=None,
    *,
    max_concurrent: int = 1,
    max_pending: int = 2,
) -> MediaTaskProcessor:
    return MediaTaskProcessor(
        task_store=store,
        downloader=downloader or FakeDownloader(),
        audio_extractor=FakeExtractor(),
        media_temp_dir=tmp_path / "temp",
        audio_dir=tmp_path / "audio",
        max_concurrent_jobs=max_concurrent,
        max_pending_jobs=max_pending,
    )


def test_processor_advances_task_to_ready_and_cleans_source(tmp_path: Path) -> None:
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
    assert completed.progress == 100
    assert completed.audio_url == f"/audio/{record.task_id}/audio.wav"
    assert completed.error is None
    assert (tmp_path / "audio" / record.task_id / "audio.wav").read_bytes() == b"wav"
    assert not (tmp_path / "temp" / record.task_id).exists()


def test_processor_exposes_safe_error_and_removes_outputs(tmp_path: Path) -> None:
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
    assert failed.audio_url is None
    assert failed.error == "Media host is not allowed"
    assert not (tmp_path / "audio" / record.task_id).exists()
    assert not (tmp_path / "temp" / record.task_id).exists()


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


def test_api_task_reaches_ready_and_audio_is_statically_accessible(tmp_path: Path) -> None:
    store = TaskStore()
    processor = build_processor(tmp_path, store)
    settings = Settings(
        audio_dir=tmp_path / "audio",
        media_temp_dir=tmp_path / "temp",
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
            assert created["status"] == "PROCESSING"

            processor.wait(created["task_id"], timeout=2)
            task = client.get(f"/api/tasks/{created['task_id']}").json()
            assert task["status"] == "READY"
            assert task["progress"] == 100
            assert task["error"] is None
            assert task["audio_url"] == f"/audio/{created['task_id']}/audio.wav"

            audio = client.get(task["audio_url"])
            assert audio.status_code == 200
            assert audio.content == b"wav"
            assert audio.headers["content-type"] == "audio/wav"
    finally:
        processor.shutdown()
