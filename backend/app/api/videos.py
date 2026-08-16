from typing import Annotated

from fastapi import APIRouter, Depends, status

from app.api.dependencies import get_task_store
from app.schemas.video import ProcessVideoRequest, ProcessVideoResponse
from app.services.task_store import TaskStore


router = APIRouter(prefix="/api/videos", tags=["videos"])


@router.post(
    "/process",
    response_model=ProcessVideoResponse,
    status_code=status.HTTP_202_ACCEPTED,
)
def process_video(
    payload: ProcessVideoRequest,
    task_store: Annotated[TaskStore, Depends(get_task_store)],
) -> ProcessVideoResponse:
    record = task_store.create(
        video_key=payload.video_key,
        video_url=str(payload.video_url),
    )
    return ProcessVideoResponse(task_id=record.task_id, status=record.status)
