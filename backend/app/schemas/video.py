from enum import StrEnum

from pydantic import BaseModel, ConfigDict, Field, HttpUrl


class TaskStatus(StrEnum):
    PROCESSING = "PROCESSING"
    READY = "READY"
    ERROR = "ERROR"


class ProcessVideoRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    video_key: str = Field(
        min_length=1,
        max_length=256,
        pattern=r"^[A-Za-z0-9:_-]+$",
    )
    video_url: HttpUrl


class ProcessVideoResponse(BaseModel):
    task_id: str
    status: TaskStatus


class DubSegment(BaseModel):
    start: float = Field(ge=0)
    end: float = Field(gt=0)
    zh: str
    en: str
    audio_url: str


class TaskResponse(BaseModel):
    task_id: str
    status: TaskStatus
    progress: int = Field(ge=0, le=100)
    segments: list[DubSegment] = Field(default_factory=list)
