from fastapi import Request

from app.services.media_processor import MediaTaskProcessor
from app.services.task_store import TaskStore


def get_task_store(request: Request) -> TaskStore:
    return request.app.state.task_store


def get_media_processor(request: Request) -> MediaTaskProcessor:
    return request.app.state.media_processor
