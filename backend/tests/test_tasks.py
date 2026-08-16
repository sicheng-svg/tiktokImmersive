from concurrent.futures import ThreadPoolExecutor

from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app
from app.services.task_store import TaskStore


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
    ]

    for payload in invalid_payloads:
        response = client.post("/api/videos/process", json=payload)
        assert response.status_code == 422


def test_each_app_has_an_independent_task_store(tmp_path) -> None:
    first_app = create_app(Settings(audio_dir=tmp_path / "first"))
    second_app = create_app(Settings(audio_dir=tmp_path / "second"))

    with TestClient(first_app) as first, TestClient(second_app) as second:
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
