from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app


class NoopMediaProcessor:
    def submit(self, _task_id: str) -> None:
        return None


def test_chrome_extension_cors_preflight(client: TestClient) -> None:
    origin = f"chrome-extension://{'a' * 32}"
    response = client.options(
        "/api/videos/process",
        headers={
            "Origin": origin,
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type",
        },
    )

    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == origin
    assert response.headers.get("access-control-allow-credentials") != "true"


def test_chrome_extension_origin_is_allowed_on_post(client: TestClient) -> None:
    origin = f"chrome-extension://{'b' * 32}"
    response = client.post(
        "/api/videos/process",
        headers={"Origin": origin},
        json={
            "video_key": "cors:post",
            "video_url": "https://www.douyin.com/video/123456789",
        },
    )

    assert response.status_code == 202
    assert response.headers["access-control-allow-origin"] == origin


def test_untrusted_origin_is_not_allowed(client: TestClient) -> None:
    response = client.options(
        "/api/videos/process",
        headers={
            "Origin": "https://evil.example",
            "Access-Control-Request-Method": "POST",
        },
    )

    assert response.status_code == 400
    assert "access-control-allow-origin" not in response.headers


def test_untrusted_origin_post_is_rejected_before_task_creation(
    client: TestClient,
) -> None:
    response = client.post(
        "/api/videos/process",
        headers={"Origin": "https://evil.example"},
        json={"video_key": "blocked", "video_url": "https://www.douyin.com/video/1"},
    )

    assert response.status_code == 403
    assert response.json() == {"detail": "Origin is not allowed"}
    assert client.app.state.task_store._records == {}


def test_untrusted_host_is_rejected(client: TestClient) -> None:
    response = client.get("/health", headers={"Host": "attacker.example"})

    assert response.status_code == 400


def test_missing_origin_can_be_disabled_for_write_requests(tmp_path) -> None:
    app = create_app(
        Settings(
            audio_dir=tmp_path / "audio",
            media_temp_dir=tmp_path / "temp",
            allow_missing_origin=False,
        ),
        media_processor=NoopMediaProcessor(),
    )

    with TestClient(app, base_url="http://localhost") as strict_client:
        response = strict_client.post(
            "/api/videos/process",
            json={
                "video_key": "no-origin",
                "video_url": "https://cdn.douyinvod.com/video",
            },
        )

    assert response.status_code == 403


def test_audio_static_server(app: FastAPI) -> None:
    audio_dir = app.state.settings.audio_dir
    sample = b"phase-4-audio-fixture"
    (audio_dir / "sample.mp3").write_bytes(sample)

    with TestClient(app, base_url="http://localhost") as client:
        response = client.get("/audio/sample.mp3")

    assert response.status_code == 200
    assert response.content == sample
    assert response.headers["content-type"] == "audio/mpeg"
