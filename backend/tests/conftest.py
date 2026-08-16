from collections.abc import Iterator

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app


class NoopMediaProcessor:
    def submit(self, _task_id: str) -> None:
        return None


@pytest.fixture
def app(tmp_path) -> FastAPI:
    return create_app(
        settings=Settings(
            audio_dir=tmp_path / "audio",
            media_temp_dir=tmp_path / "media",
            cors_origins=("http://localhost:5173",),
        ),
        media_processor=NoopMediaProcessor(),
    )


@pytest.fixture
def client(app: FastAPI) -> Iterator[TestClient]:
    with TestClient(app, base_url="http://localhost") as test_client:
        yield test_client
