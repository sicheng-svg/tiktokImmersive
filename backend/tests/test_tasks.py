from concurrent.futures import ThreadPoolExecutor
from threading import Event, Lock

from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app
from app.services.media_processor import ProcessingCapacityError
from app.services.task_store import TaskStore


class NoopMediaProcessor:
    def submit(self, _task_id: str) -> None:
        return None


class FullMediaProcessor:
    def submit(self, _task_id: str) -> None:
        raise ProcessingCapacityError("Media processing queue is full")


class CountingMediaProcessor:
    def __init__(self) -> None:
        self.task_ids: list[str] = []
        self._lock = Lock()

    def submit(self, task_id: str) -> None:
        with self._lock:
            self.task_ids.append(task_id)


class BlockingFullMediaProcessor:
    def __init__(self) -> None:
        self.entered = Event()
        self.release = Event()
        self._calls = 0
        self._lock = Lock()

    def submit(self, _task_id: str) -> None:
        with self._lock:
            self._calls += 1
            first = self._calls == 1
        if first:
            self.entered.set()
            self.release.wait(timeout=2)
        raise ProcessingCapacityError("Media processing queue is full")


def test_create_and_query_task(client: TestClient) -> None:
    create_response = client.post(
        "/api/videos/process",
        json={
            "video_key": "url:abc123",
            "video_url": "https://www.douyin.com/video/7382738211234567890",
        },
    )

    assert create_response.status_code == 202
    created = create_response.json()
    assert created["status"] == "PROCESSING"
    assert len(created["task_id"]) == 32

    task_response = client.get(f"/api/tasks/{created['task_id']}")
    assert task_response.status_code == 200
    assert task_response.json() == {
        "task_id": created["task_id"],
        "status": "PROCESSING",
        "progress": 0,
        "audio_url": None,
        "error": None,
        "segments": [],
    }


def test_unknown_task_returns_404(client: TestClient) -> None:
    response = client.get("/api/tasks/missing")

    assert response.status_code == 404
    assert response.json() == {"detail": "Task not found"}


def test_request_validation_rejects_invalid_inputs(client: TestClient) -> None:
    invalid_payloads = [
        {"video_key": "", "video_url": "https://www.douyin.com/video/1"},
        {"video_key": "valid", "video_url": "ftp://example.com/video.mp4"},
        {"video_key": "contains spaces", "video_url": "https://example.com/video.mp4"},
        {"video_key": "valid", "video_url": "not-a-url"},
        {"video_key": "valid", "video_url": "http://example.com/video.mp4"},
        {"video_key": "valid", "video_url": "https://example.com:444/video.mp4"},
        {"video_key": "valid", "video_url": "https://user:pass@example.com/video.mp4"},
        {"video_key": "valid", "video_url": "https://example.com/live.m3u8?token=x"},
        {"video_key": "valid", "video_url": "https://example.com/live.MPD"},
    ]

    for payload in invalid_payloads:
        response = client.post("/api/videos/process", json=payload)
        assert response.status_code == 422


def test_video_url_uses_explicit_8192_character_limit(client: TestClient) -> None:
    accepted_url = "https://cdn.douyinvod.com/" + ("a" * 3000)
    accepted = client.post(
        "/api/videos/process",
        json={"video_key": "long:accepted", "video_url": accepted_url},
    )
    assert accepted.status_code == 202

    rejected_url = "https://cdn.douyinvod.com/" + ("a" * 8192)
    rejected = client.post(
        "/api/videos/process",
        json={"video_key": "long:rejected", "video_url": rejected_url},
    )
    assert rejected.status_code == 422


def test_each_app_has_an_independent_task_store(tmp_path) -> None:
    first_app = create_app(
        Settings(audio_dir=tmp_path / "first", media_temp_dir=tmp_path / "first-temp"),
        media_processor=NoopMediaProcessor(),
    )
    second_app = create_app(
        Settings(audio_dir=tmp_path / "second", media_temp_dir=tmp_path / "second-temp"),
        media_processor=NoopMediaProcessor(),
    )

    with TestClient(first_app, base_url="http://localhost") as first, TestClient(
        second_app,
        base_url="http://localhost",
    ) as second:
        created = first.post(
            "/api/videos/process",
            json={"video_key": "12345678", "video_url": "https://example.com/video.mp4"},
        ).json()
        assert first.get(f"/api/tasks/{created['task_id']}").status_code == 200
        assert second.get(f"/api/tasks/{created['task_id']}").status_code == 404


def test_task_store_supports_concurrent_create_and_get() -> None:
    store = TaskStore()

    def create(index: int):
        return store.create(
            video_key=f"concurrent:{index}",
            video_url=f"https://example.com/video/{index}",
        )

    with ThreadPoolExecutor(max_workers=8) as executor:
        records = list(executor.map(create, range(32)))

    assert len({record.task_id for record in records}) == 32
    assert all(store.get(record.task_id) == record for record in records)


def test_task_store_atomically_deduplicates_concurrent_source_requests() -> None:
    store = TaskStore()

    def create_or_get(_index: int):
        return store.create_or_get(
            video_key="same:key",
            video_url="https://cdn.douyinvod.com/same",
        )

    with ThreadPoolExecutor(max_workers=16) as executor:
        results = list(executor.map(create_or_get, range(64)))

    assert len({record.task_id for record, _created in results}) == 1
    assert sum(created for _record, created in results) == 1


def test_error_or_changed_url_creates_a_new_task() -> None:
    store = TaskStore()
    first, first_created = store.create_or_get("same:key", "https://example.com/one")
    duplicate, duplicate_created = store.create_or_get(
        "same:key",
        "https://example.com/one",
    )
    assert first_created is True
    assert duplicate_created is False
    assert duplicate.task_id == first.task_id

    store.mark_error(first.task_id, "failed")
    retry, retry_created = store.create_or_get("same:key", "https://example.com/one")
    store.mark_ready(retry.task_id, f"/audio/{retry.task_id}/audio.wav")
    ready_duplicate, ready_duplicate_created = store.create_or_get(
        "same:key",
        "https://example.com/one",
    )
    changed, changed_created = store.create_or_get("same:key", "https://example.com/two")

    assert retry_created is True
    assert retry.task_id != first.task_id
    assert ready_duplicate_created is False
    assert ready_duplicate.task_id == retry.task_id
    assert changed_created is True
    assert changed.task_id not in {first.task_id, retry.task_id}


def test_api_deduplicates_submissions_but_retries_error_and_changed_url(tmp_path) -> None:
    store = TaskStore()
    processor = CountingMediaProcessor()
    app = create_app(
        Settings(audio_dir=tmp_path / "audio", media_temp_dir=tmp_path / "temp"),
        task_store=store,
        media_processor=processor,
    )
    first_payload = {
        "video_key": "dedupe:key",
        "video_url": "https://cdn.douyinvod.com/one",
    }

    with TestClient(app, base_url="http://localhost") as client:
        first = client.post("/api/videos/process", json=first_payload).json()
        duplicate = client.post("/api/videos/process", json=first_payload).json()
        assert duplicate["task_id"] == first["task_id"]
        assert processor.task_ids == [first["task_id"]]

        store.mark_error(first["task_id"], "failed")
        retry = client.post("/api/videos/process", json=first_payload).json()
        assert retry["task_id"] != first["task_id"]

        changed = client.post(
            "/api/videos/process",
            json={
                "video_key": "dedupe:key",
                "video_url": "https://cdn.douyinvod.com/two",
            },
        ).json()
        assert changed["task_id"] not in {first["task_id"], retry["task_id"]}

    assert processor.task_ids == [first["task_id"], retry["task_id"], changed["task_id"]]


def test_concurrent_api_requests_submit_only_one_task(tmp_path) -> None:
    store = TaskStore()
    processor = CountingMediaProcessor()
    app = create_app(
        Settings(audio_dir=tmp_path / "audio", media_temp_dir=tmp_path / "temp"),
        task_store=store,
        media_processor=processor,
    )
    payload = {
        "video_key": "concurrent:dedupe",
        "video_url": "https://cdn.douyinvod.com/same",
    }

    with TestClient(app, base_url="http://localhost") as client:
        with ThreadPoolExecutor(max_workers=12) as executor:
            responses = list(
                executor.map(
                    lambda _index: client.post("/api/videos/process", json=payload),
                    range(32),
                )
            )

    assert all(response.status_code == 202 for response in responses)
    task_ids = {response.json()["task_id"] for response in responses}
    assert len(task_ids) == 1
    assert processor.task_ids == [task_ids.pop()]


def test_full_processing_queue_returns_503_without_leaking_task(tmp_path) -> None:
    store = TaskStore()
    app = create_app(
        Settings(audio_dir=tmp_path / "audio", media_temp_dir=tmp_path / "temp"),
        task_store=store,
        media_processor=FullMediaProcessor(),
    )

    with TestClient(app, base_url="http://localhost") as client:
        response = client.post(
            "/api/videos/process",
            json={"video_key": "full", "video_url": "https://cdn.douyinvod.com/video"},
        )

    assert response.status_code == 503
    assert response.headers["retry-after"] == "5"
    assert store._records == {}


def test_queue_failure_cannot_publish_a_dangling_deduplicated_task(tmp_path) -> None:
    store = TaskStore()
    processor = BlockingFullMediaProcessor()
    app = create_app(
        Settings(audio_dir=tmp_path / "audio", media_temp_dir=tmp_path / "temp"),
        task_store=store,
        media_processor=processor,
    )
    payload = {
        "video_key": "full:concurrent",
        "video_url": "https://cdn.douyinvod.com/video",
    }

    with TestClient(app, base_url="http://localhost") as client, ThreadPoolExecutor(max_workers=2) as executor:
        first = executor.submit(client.post, "/api/videos/process", json=payload)
        assert processor.entered.wait(timeout=1)
        second = executor.submit(client.post, "/api/videos/process", json=payload)
        processor.release.set()
        responses = [first.result(timeout=2), second.result(timeout=2)]

    assert [response.status_code for response in responses] == [503, 503]
    assert store._records == {}
