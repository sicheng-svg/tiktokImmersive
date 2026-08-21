from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status

from app.api.dependencies import get_media_processor, get_task_store
from app.schemas.video import ProcessVideoRequest, ProcessVideoResponse
from app.services.media_processor import MediaTaskProcessor, ProcessingCapacityError
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
    media_processor: Annotated[MediaTaskProcessor, Depends(get_media_processor)],
) -> ProcessVideoResponse:
    try:
        record, created = task_store.create_or_get_and_submit(
            video_key=payload.video_key,
            video_url=str(payload.video_url),
            submit=media_processor.submit,
        )
    except ProcessingCapacityError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=str(exc),
            headers={"Retry-After": "5"},
        ) from exc
    latest = task_store.get(record.task_id) or record
    return latest.to_process_response(task_reused=not created)
