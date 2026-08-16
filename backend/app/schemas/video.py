from enum import StrEnum
from typing import Annotated
from urllib.parse import unquote

from pydantic import AnyUrl, BaseModel, ConfigDict, Field, UrlConstraints, field_validator


MediaUrl = Annotated[
    AnyUrl,
    UrlConstraints(
        max_length=8192,
        allowed_schemes=["https"],
        host_required=True,
        default_port=443,
    ),
]


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
    video_url: MediaUrl

    @field_validator("video_url")
    @classmethod
    def require_safe_authority(cls, value: AnyUrl) -> AnyUrl:
        if value.username is not None or value.password is not None:
            raise ValueError("video_url credentials are not allowed")
        if value.port != 443:
            raise ValueError("video_url must use HTTPS port 443")
        if unquote(value.path or "").lower().endswith((".m3u8", ".mpd")):
            raise ValueError("streaming manifest URLs are not supported")
        return value


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
    audio_url: str | None = None
    error: str | None = None
    segments: list[DubSegment] = Field(default_factory=list)
