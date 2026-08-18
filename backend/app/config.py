from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path


BACKEND_ROOT = Path(__file__).resolve().parents[1]


def _default_cors_origins() -> tuple[str, ...]:
    return ("http://localhost:5173", "http://127.0.0.1:5173")


def _parse_cors_origins(value: str | None) -> tuple[str, ...]:
    if value is None:
        return _default_cors_origins()
    return tuple(origin.strip() for origin in value.split(",") if origin.strip())


def _resolve_audio_dir(value: str | None) -> Path:
    if not value:
        return BACKEND_ROOT / "output" / "audio"
    path = Path(value).expanduser()
    return path.resolve() if path.is_absolute() else (BACKEND_ROOT / path).resolve()


def _resolve_backend_path(value: str | None, default: str) -> Path:
    path = Path(value or default).expanduser()
    return path.resolve() if path.is_absolute() else (BACKEND_ROOT / path).resolve()


def _parse_csv(value: str | None, default: tuple[str, ...]) -> tuple[str, ...]:
    if value is None:
        return default
    return tuple(item.strip().lower().lstrip(".") for item in value.split(",") if item.strip())


def _parse_bool(value: str | None, default: bool) -> bool:
    if value is None:
        return default
    normalized = value.strip().lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    raise ValueError(f"Invalid boolean setting: {value!r}")


def _parse_positive_int(value: str | None, default: int, name: str) -> int:
    parsed = default if value is None else int(value)
    if parsed <= 0:
        raise ValueError(f"{name} must be greater than zero")
    return parsed


def _parse_positive_float(value: str | None, default: float, name: str) -> float:
    parsed = default if value is None else float(value)
    if parsed <= 0:
        raise ValueError(f"{name} must be greater than zero")
    return parsed


DEFAULT_MEDIA_HOST_SUFFIXES = (
    "douyin.com",
    "douyinvod.com",
    "bytevcloud.com",
    "bytecdn.cn",
    "zjcdn.com",
    "bytedance.com",
    "bytedance.net",
    "snssdk.com",
)


@dataclass(frozen=True, slots=True)
class Settings:
    app_name: str = "Douyin English API"
    app_version: str = "0.2.1"
    environment: str = "development"
    audio_dir: Path = field(default_factory=lambda: BACKEND_ROOT / "output" / "audio")
    media_temp_dir: Path = field(default_factory=lambda: BACKEND_ROOT / "temp" / "media")
    cors_origins: tuple[str, ...] = field(default_factory=_default_cors_origins)
    cors_origin_regex: str = r"^chrome-extension://[a-p]{32}$"
    trusted_hosts: tuple[str, ...] = ("127.0.0.1", "localhost")
    allow_missing_origin: bool = True
    media_host_suffixes: tuple[str, ...] = DEFAULT_MEDIA_HOST_SUFFIXES
    media_max_download_bytes: int = 100 * 1024 * 1024
    media_max_redirects: int = 3
    media_connect_timeout_seconds: float = 5.0
    media_read_timeout_seconds: float = 30.0
    media_total_timeout_seconds: float = 60.0
    ffmpeg_binary: str = "ffmpeg"
    ffmpeg_timeout_seconds: float = 120.0
    max_concurrent_jobs: int = 2
    max_pending_jobs: int = 8

    def __post_init__(self) -> None:
        audio_dir = self.audio_dir.expanduser()
        media_temp_dir = self.media_temp_dir.expanduser()
        object.__setattr__(
            self,
            "audio_dir",
            audio_dir.resolve()
            if audio_dir.is_absolute()
            else (BACKEND_ROOT / audio_dir).resolve(),
        )
        object.__setattr__(
            self,
            "media_temp_dir",
            media_temp_dir.resolve()
            if media_temp_dir.is_absolute()
            else (BACKEND_ROOT / media_temp_dir).resolve(),
        )
        if self.max_concurrent_jobs <= 0:
            raise ValueError("max_concurrent_jobs must be greater than zero")
        if self.max_pending_jobs < self.max_concurrent_jobs:
            raise ValueError("max_pending_jobs must be at least max_concurrent_jobs")
        if not self.ffmpeg_binary.strip():
            raise ValueError("ffmpeg_binary must not be empty")

    @classmethod
    def from_environment(cls) -> "Settings":
        return cls(
            environment=os.getenv("DOUYIN_ENGLISH_ENVIRONMENT", "development"),
            audio_dir=_resolve_audio_dir(os.getenv("DOUYIN_ENGLISH_AUDIO_DIR")),
            media_temp_dir=_resolve_backend_path(
                os.getenv("DOUYIN_ENGLISH_MEDIA_TEMP_DIR"),
                "temp/media",
            ),
            cors_origins=_parse_cors_origins(os.getenv("DOUYIN_ENGLISH_CORS_ORIGINS")),
            cors_origin_regex=os.getenv(
                "DOUYIN_ENGLISH_CORS_ORIGIN_REGEX",
                r"^chrome-extension://[a-p]{32}$",
            ),
            trusted_hosts=_parse_csv(
                os.getenv("DOUYIN_ENGLISH_TRUSTED_HOSTS"),
                ("127.0.0.1", "localhost"),
            ),
            allow_missing_origin=_parse_bool(
                os.getenv("DOUYIN_ENGLISH_ALLOW_MISSING_ORIGIN"),
                True,
            ),
            media_host_suffixes=_parse_csv(
                os.getenv("DOUYIN_ENGLISH_MEDIA_HOST_SUFFIXES"),
                DEFAULT_MEDIA_HOST_SUFFIXES,
            ),
            media_max_download_bytes=_parse_positive_int(
                os.getenv("DOUYIN_ENGLISH_MEDIA_MAX_DOWNLOAD_BYTES"),
                100 * 1024 * 1024,
                "DOUYIN_ENGLISH_MEDIA_MAX_DOWNLOAD_BYTES",
            ),
            media_max_redirects=_parse_positive_int(
                os.getenv("DOUYIN_ENGLISH_MEDIA_MAX_REDIRECTS"),
                3,
                "DOUYIN_ENGLISH_MEDIA_MAX_REDIRECTS",
            ),
            media_connect_timeout_seconds=_parse_positive_float(
                os.getenv("DOUYIN_ENGLISH_MEDIA_CONNECT_TIMEOUT_SECONDS"),
                5.0,
                "DOUYIN_ENGLISH_MEDIA_CONNECT_TIMEOUT_SECONDS",
            ),
            media_read_timeout_seconds=_parse_positive_float(
                os.getenv("DOUYIN_ENGLISH_MEDIA_READ_TIMEOUT_SECONDS"),
                30.0,
                "DOUYIN_ENGLISH_MEDIA_READ_TIMEOUT_SECONDS",
            ),
            media_total_timeout_seconds=_parse_positive_float(
                os.getenv("DOUYIN_ENGLISH_MEDIA_TOTAL_TIMEOUT_SECONDS"),
                60.0,
                "DOUYIN_ENGLISH_MEDIA_TOTAL_TIMEOUT_SECONDS",
            ),
            ffmpeg_binary=os.getenv("DOUYIN_ENGLISH_FFMPEG_BINARY", "ffmpeg"),
            ffmpeg_timeout_seconds=_parse_positive_float(
                os.getenv("DOUYIN_ENGLISH_FFMPEG_TIMEOUT_SECONDS"),
                120.0,
                "DOUYIN_ENGLISH_FFMPEG_TIMEOUT_SECONDS",
            ),
            max_concurrent_jobs=_parse_positive_int(
                os.getenv("DOUYIN_ENGLISH_MAX_CONCURRENT_JOBS"),
                2,
                "DOUYIN_ENGLISH_MAX_CONCURRENT_JOBS",
            ),
            max_pending_jobs=_parse_positive_int(
                os.getenv("DOUYIN_ENGLISH_MAX_PENDING_JOBS"),
                8,
                "DOUYIN_ENGLISH_MAX_PENDING_JOBS",
            ),
        )
