from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from starlette.middleware.trustedhost import TrustedHostMiddleware

from app.api import tasks_router, videos_router
from app.config import Settings
from app.middleware import OriginGuardMiddleware
from app.schemas.health import HealthResponse
from app.services.ffmpeg import FfmpegAudioExtractor
from app.services.media_downloader import HttpMediaDownloader
from app.services.media_processor import MediaTaskProcessor
from app.services.task_store import TaskStore


def create_app(
    settings: Settings | None = None,
    task_store: TaskStore | None = None,
    media_processor: MediaTaskProcessor | None = None,
) -> FastAPI:
    resolved_settings = settings or Settings.from_environment()
    resolved_settings.audio_dir.mkdir(parents=True, exist_ok=True)
    resolved_settings.media_temp_dir.mkdir(parents=True, exist_ok=True)
    resolved_store = task_store or TaskStore()
    resolved_processor = media_processor or MediaTaskProcessor(
        task_store=resolved_store,
        downloader=HttpMediaDownloader(
            allowed_host_suffixes=resolved_settings.media_host_suffixes,
            max_download_bytes=resolved_settings.media_max_download_bytes,
            max_redirects=resolved_settings.media_max_redirects,
            connect_timeout_seconds=resolved_settings.media_connect_timeout_seconds,
            read_timeout_seconds=resolved_settings.media_read_timeout_seconds,
            total_timeout_seconds=resolved_settings.media_total_timeout_seconds,
        ),
        audio_extractor=FfmpegAudioExtractor(
            executable=resolved_settings.ffmpeg_binary,
            timeout_seconds=resolved_settings.ffmpeg_timeout_seconds,
        ),
        media_temp_dir=resolved_settings.media_temp_dir,
        audio_dir=resolved_settings.audio_dir,
        max_concurrent_jobs=resolved_settings.max_concurrent_jobs,
        max_pending_jobs=resolved_settings.max_pending_jobs,
    )
    owns_processor = media_processor is None

    @asynccontextmanager
    async def lifespan(_application: FastAPI) -> AsyncIterator[None]:
        yield
        if owns_processor:
            resolved_processor.shutdown()

    application = FastAPI(
        title=resolved_settings.app_name,
        version=resolved_settings.app_version,
        description="Phase 5 media extraction API for Douyin English.",
        lifespan=lifespan,
    )
    application.state.settings = resolved_settings
    application.state.task_store = resolved_store
    application.state.media_processor = resolved_processor

    application.add_middleware(
        CORSMiddleware,
        allow_origins=list(resolved_settings.cors_origins),
        allow_origin_regex=resolved_settings.cors_origin_regex,
        allow_credentials=False,
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["Accept", "Content-Type"],
    )
    application.add_middleware(
        TrustedHostMiddleware,
        allowed_hosts=list(resolved_settings.trusted_hosts),
    )
    application.add_middleware(
        OriginGuardMiddleware,
        allowed_origins=resolved_settings.cors_origins,
        allowed_origin_regex=resolved_settings.cors_origin_regex,
        allow_missing_origin=resolved_settings.allow_missing_origin,
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
