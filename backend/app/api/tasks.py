from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status

from app.api.dependencies import get_task_store
from app.schemas.video import TaskResponse
from app.services.task_store import TaskStore


router = APIRouter(prefix="/api/tasks", tags=["tasks"])


@router.get("/{task_id}", response_model=TaskResponse)
def get_task(
    task_id: str,
    task_store: Annotated[TaskStore, Depends(get_task_store)],
) -> TaskResponse:
    record = task_store.get(task_id)
    if record is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Task not found",
        )
    return record.to_response()
