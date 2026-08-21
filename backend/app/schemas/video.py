from enum import StrEnum
from typing import Annotated, Self
from urllib.parse import unquote

from pydantic import (
    AnyUrl,
    BaseModel,
    ConfigDict,
    Field,
    UrlConstraints,
    field_validator,
    model_validator,
)


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


class TaskStage(StrEnum):
    FETCHING = "FETCHING"
    EXTRACTING = "EXTRACTING"
    TRANSCRIBING = "TRANSCRIBING"
    TRANSLATING = "TRANSLATING"
    READY = "READY"


class TaskStepStatus(StrEnum):
    PENDING = "PENDING"
    PROCESSING = "PROCESSING"
    READY = "READY"
    ERROR = "ERROR"
    SKIPPED = "SKIPPED"


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


class DubSegment(BaseModel):
    """Reserved for a later English speech/TTS phase."""

    start: float = Field(ge=0)
    end: float = Field(gt=0)
    zh: str
    en: str
    audio_url: str


class TranscriptSegment(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

    segment_id: str = Field(pattern=r"^s[0-9]{6}$")
    start: float = Field(ge=0)
    end: float = Field(gt=0)
    text: str = Field(min_length=1)

    @model_validator(mode="after")
    def require_positive_duration(self) -> Self:
        if self.end <= self.start:
            raise ValueError("transcript segment end must be greater than start")
        return self


class SubtitleSegment(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

    segment_id: str = Field(pattern=r"^s[0-9]{6}$")
    start: float = Field(ge=0)
    end: float = Field(gt=0)
    zh: str = Field(min_length=1)
    en: str = Field(min_length=1)

    @model_validator(mode="after")
    def require_positive_duration(self) -> Self:
        if self.end <= self.start:
            raise ValueError("subtitle segment end must be greater than start")
        return self


class TaskStepResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    status: TaskStepStatus
    cache_hit: bool | None = Field(
        description=(
            "true only when a valid disk cache entry was used; false only after a "
            "cache miss and provider call; null when not checked or unknown"
        )
    )


class TaskStepsResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    asr: TaskStepResponse
    translation: TaskStepResponse


class TaskResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    task_id: str
    status: TaskStatus
    stage: TaskStage = Field(
        description="The current or failed stage; failures do not use a generic ERROR stage"
    )
    progress: int = Field(ge=0, le=100)
    steps: TaskStepsResponse
    transcript: list[TranscriptSegment]
    subtitles: list[SubtitleSegment]
    segments: list[DubSegment] = Field(
        description="Reserved for later English speech; always empty in Phase 6"
    )
    audio_url: str | None = Field(
        description="Original Chinese WAV URL once extraction has succeeded"
    )
    error: str | None = Field(
        description="Stable public error text; Provider payloads and secrets are omitted"
    )

    @model_validator(mode="after")
    def enforce_phase_six_invariants(self) -> Self:
        if self.segments:
            raise ValueError("segments must remain empty in Phase 6")
        expected_ids = [f"s{index:06d}" for index in range(1, len(self.transcript) + 1)]
        if [segment.segment_id for segment in self.transcript] != expected_ids:
            raise ValueError("transcript segment IDs must be stable and continuous")
        if self.status is TaskStatus.PROCESSING:
            self._validate_processing()
        elif self.status is TaskStatus.READY:
            self._validate_ready()
        else:
            self._validate_error()
        return self

    def _validate_processing(self) -> None:
        if self.error is not None or self.stage is TaskStage.READY or self.progress >= 100:
            raise ValueError("processing task state is inconsistent")
        if self.transcript or self.subtitles:
            if self.stage is not TaskStage.TRANSLATING or self.subtitles:
                raise ValueError("processing task published results too early")
        if self.stage in {TaskStage.FETCHING, TaskStage.EXTRACTING}:
            self._require_steps(TaskStepStatus.PENDING, TaskStepStatus.PENDING)
            if self.audio_url is not None:
                raise ValueError("media preparation task cannot expose audio")
        elif self.stage is TaskStage.TRANSCRIBING:
            self._require_steps(TaskStepStatus.PROCESSING, TaskStepStatus.PENDING)
            if self.audio_url is None or self.transcript or self.subtitles:
                raise ValueError("transcribing task state is inconsistent")
        elif self.stage is TaskStage.TRANSLATING:
            self._require_steps(TaskStepStatus.READY, TaskStepStatus.PROCESSING)
            if self.audio_url is None or not self.transcript or self.subtitles:
                raise ValueError("translating task state is inconsistent")

    def _validate_ready(self) -> None:
        if (
            self.stage is not TaskStage.READY
            or self.progress != 100
            or self.audio_url is None
            or self.error is not None
        ):
            raise ValueError("ready task state is inconsistent")
        self._require_steps(TaskStepStatus.READY, TaskStepStatus.READY)
        if not self.transcript or len(self.transcript) != len(self.subtitles):
            raise ValueError("ready task requires complete bilingual subtitles")
        for transcript, subtitle in zip(self.transcript, self.subtitles, strict=True):
            if (
                subtitle.segment_id != transcript.segment_id
                or subtitle.start != transcript.start
                or subtitle.end != transcript.end
                or subtitle.zh != transcript.text
            ):
                raise ValueError("ready subtitles do not match the local transcript")

    def _validate_error(self) -> None:
        if not self.error or self.stage is TaskStage.READY or self.progress >= 100:
            raise ValueError("error task state is inconsistent")
        if self.stage in {TaskStage.FETCHING, TaskStage.EXTRACTING}:
            self._require_steps(TaskStepStatus.SKIPPED, TaskStepStatus.SKIPPED)
            if self.audio_url is not None or self.transcript or self.subtitles:
                raise ValueError("media failure cannot publish language results")
        elif self.stage is TaskStage.TRANSCRIBING:
            self._require_steps(TaskStepStatus.ERROR, TaskStepStatus.SKIPPED)
            if self.audio_url is None or self.transcript or self.subtitles:
                raise ValueError("ASR failure task state is inconsistent")
        elif self.stage is TaskStage.TRANSLATING:
            self._require_steps(TaskStepStatus.READY, TaskStepStatus.ERROR)
            if self.audio_url is None or not self.transcript or self.subtitles:
                raise ValueError("translation failure task state is inconsistent")

    def _require_steps(
        self,
        asr_status: TaskStepStatus,
        translation_status: TaskStepStatus,
    ) -> None:
        if (
            self.steps.asr.status is not asr_status
            or self.steps.translation.status is not translation_status
        ):
            raise ValueError("task step state does not match its stage")
        for step in (self.steps.asr, self.steps.translation):
            if step.status is TaskStepStatus.READY and step.cache_hit is None:
                raise ValueError("ready step requires a known cache result")
            if step.status is TaskStepStatus.ERROR and step.cache_hit is True:
                raise ValueError("failed step cannot report a cache hit")
            if step.status in {
                TaskStepStatus.PENDING,
                TaskStepStatus.PROCESSING,
                TaskStepStatus.SKIPPED,
            } and step.cache_hit is not None:
                raise ValueError("unfinished or skipped step cannot report cache usage")


class ProcessVideoResponse(TaskResponse):
    task_reused: bool = Field(
        description="Whether the in-memory task was reused; independent of step cache hits"
    )
