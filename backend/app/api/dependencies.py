from fastapi import Request

from app.services.task_store import TaskStore


def get_task_store(request: Request) -> TaskStore:
    return request.app.state.task_store
