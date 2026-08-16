from collections.abc import Iterator

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app


@pytest.fixture
def app(tmp_path) -> FastAPI:
    return create_app(
        settings=Settings(
            audio_dir=tmp_path / "audio",
            cors_origins=("http://localhost:5173",),
        )
    )


@pytest.fixture
def client(app: FastAPI) -> Iterator[TestClient]:
    with TestClient(app) as test_client:
        yield test_client
