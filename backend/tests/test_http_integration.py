from fastapi import FastAPI
from fastapi.testclient import TestClient


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


def test_audio_static_server(app: FastAPI) -> None:
    audio_dir = app.state.settings.audio_dir
    sample = b"phase-4-audio-fixture"
    (audio_dir / "sample.mp3").write_bytes(sample)

    with TestClient(app) as client:
        response = client.get("/audio/sample.mp3")

    assert response.status_code == 200
    assert response.content == sample
    assert response.headers["content-type"] == "audio/mpeg"
