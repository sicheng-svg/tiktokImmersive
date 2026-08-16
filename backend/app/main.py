from __future__ import annotations

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from app.api import tasks_router, videos_router
from app.config import Settings
from app.schemas.health import HealthResponse
from app.services.task_store import TaskStore


def create_app(
    settings: Settings | None = None,
    task_store: TaskStore | None = None,
) -> FastAPI:
    resolved_settings = settings or Settings.from_environment()
    resolved_settings.audio_dir.mkdir(parents=True, exist_ok=True)

    application = FastAPI(
        title=resolved_settings.app_name,
        version=resolved_settings.app_version,
        description="Phase 4 API skeleton for Douyin English.",
    )
    application.state.settings = resolved_settings
    application.state.task_store = task_store or TaskStore()

    application.add_middleware(
        CORSMiddleware,
        allow_origins=list(resolved_settings.cors_origins),
        allow_origin_regex=resolved_settings.cors_origin_regex,
        allow_credentials=False,
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["Accept", "Content-Type"],
    )

    @application.get("/health", response_model=HealthResponse, tags=["health"])
    def health_check() -> HealthResponse:
        return HealthResponse()

    application.include_router(videos_router)
    application.include_router(tasks_router)
    application.mount(
        "/audio",
        StaticFiles(directory=str(resolved_settings.audio_dir)),
        name="audio",
    )
    return application


app = create_app()
