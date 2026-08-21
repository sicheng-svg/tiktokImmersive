from __future__ import annotations

import os
import math
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


def _parse_nonnegative_int(value: str | None, default: int, name: str) -> int:
    parsed = default if value is None else int(value)
    if parsed < 0:
        raise ValueError(f"{name} must not be negative")
    return parsed


def _optional_setting(value: str | None) -> str | None:
    normalized = value.strip() if value is not None else ""
    return normalized or None


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
    app_version: str = "0.3.0"
    environment: str = "development"
    audio_dir: Path = field(default_factory=lambda: BACKEND_ROOT / "output" / "audio")
    media_temp_dir: Path = field(default_factory=lambda: BACKEND_ROOT / "temp" / "media")
    language_cache_dir: Path = field(default_factory=lambda: BACKEND_ROOT / "cache")
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
    shutdown_grace_seconds: float = 10.0
    asr_provider: str = "fake"
    asr_model: str = "fake-asr-v1"
    asr_language: str = "zh"
    asr_timestamp_granularity: str = "segment"
    asr_api_key: str | None = field(default=None, repr=False)
    asr_proxy_url: str | None = field(default=None, repr=False)
    asr_connect_timeout_seconds: float = 5.0
    asr_read_timeout_seconds: float = 60.0
    asr_write_timeout_seconds: float = 60.0
    asr_total_timeout_seconds: float = 90.0
    asr_max_retries: int = 2
    asr_max_audio_bytes: int = 24_000_000
    asr_max_audio_duration_seconds: float = 12 * 60
    transcript_max_segments: int = 5000
    transcript_max_segment_characters: int = 4096
    transcript_max_total_characters: int = 500_000
    transcript_overlap_tolerance_seconds: float = 0.25
    transcript_duration_tolerance_seconds: float = 0.5
    translation_provider: str = "fake"
    translation_model: str = "fake-translation-v1"
    translation_api_version: str = "fake-v1"
    translation_source_language: str = "zh"
    translation_target_language: str = "en"
    translation_prompt_version: str = "subtitle-v1"
    translation_strategy_version: str = "context-v1"
    translation_api_key: str | None = field(default=None, repr=False)
    translation_proxy_url: str | None = field(default=None, repr=False)
    translation_connect_timeout_seconds: float = 5.0
    translation_read_timeout_seconds: float = 60.0
    translation_write_timeout_seconds: float = 60.0
    translation_total_timeout_seconds: float = 90.0
    translation_max_retries: int = 2
    translation_max_segment_characters: int = 8192
    translation_max_total_characters: int = 1_000_000
    language_cache_max_json_bytes: int = 8 * 1024 * 1024

    def __post_init__(self) -> None:
        audio_dir = self.audio_dir.expanduser()
        media_temp_dir = self.media_temp_dir.expanduser()
        language_cache_dir = self.language_cache_dir.expanduser()
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
        object.__setattr__(
            self,
            "language_cache_dir",
            language_cache_dir.resolve()
            if language_cache_dir.is_absolute()
            else (BACKEND_ROOT / language_cache_dir).resolve(),
        )
        object.__setattr__(self, "asr_provider", self.asr_provider.strip().lower())
        object.__setattr__(
            self,
            "translation_provider",
            self.translation_provider.strip().lower(),
        )
        for name in (
            "asr_model",
            "asr_timestamp_granularity",
            "translation_model",
            "translation_api_version",
            "translation_prompt_version",
            "translation_strategy_version",
        ):
            object.__setattr__(self, name, getattr(self, name).strip())
        object.__setattr__(self, "asr_language", self.asr_language.strip().lower())
        object.__setattr__(
            self,
            "translation_source_language",
            self.translation_source_language.strip().lower(),
        )
        object.__setattr__(
            self,
            "translation_target_language",
            self.translation_target_language.strip().lower(),
        )
        if self.max_concurrent_jobs <= 0:
            raise ValueError("max_concurrent_jobs must be greater than zero")
        if self.max_pending_jobs < self.max_concurrent_jobs:
            raise ValueError("max_pending_jobs must be at least max_concurrent_jobs")
        if not self.ffmpeg_binary.strip():
            raise ValueError("ffmpeg_binary must not be empty")
        required_names = {
            "asr_provider": self.asr_provider,
            "asr_model": self.asr_model,
            "asr_language": self.asr_language,
            "asr_timestamp_granularity": self.asr_timestamp_granularity,
            "translation_provider": self.translation_provider,
            "translation_model": self.translation_model,
            "translation_api_version": self.translation_api_version,
            "translation_source_language": self.translation_source_language,
            "translation_target_language": self.translation_target_language,
            "translation_prompt_version": self.translation_prompt_version,
            "translation_strategy_version": self.translation_strategy_version,
        }
        for name, value in required_names.items():
            if not value.strip():
                raise ValueError(f"{name} must not be empty")
        positive_values = {
            "shutdown_grace_seconds": self.shutdown_grace_seconds,
            "asr_connect_timeout_seconds": self.asr_connect_timeout_seconds,
            "asr_read_timeout_seconds": self.asr_read_timeout_seconds,
            "asr_write_timeout_seconds": self.asr_write_timeout_seconds,
            "asr_total_timeout_seconds": self.asr_total_timeout_seconds,
            "asr_max_audio_bytes": self.asr_max_audio_bytes,
            "asr_max_audio_duration_seconds": self.asr_max_audio_duration_seconds,
            "transcript_max_segments": self.transcript_max_segments,
            "transcript_max_segment_characters": self.transcript_max_segment_characters,
            "transcript_max_total_characters": self.transcript_max_total_characters,
            "translation_connect_timeout_seconds": self.translation_connect_timeout_seconds,
            "translation_read_timeout_seconds": self.translation_read_timeout_seconds,
            "translation_write_timeout_seconds": self.translation_write_timeout_seconds,
            "translation_total_timeout_seconds": self.translation_total_timeout_seconds,
            "translation_max_segment_characters": self.translation_max_segment_characters,
            "translation_max_total_characters": self.translation_max_total_characters,
            "language_cache_max_json_bytes": self.language_cache_max_json_bytes,
        }
        for name, value in positive_values.items():
            if not math.isfinite(float(value)) or value <= 0:
                raise ValueError(f"{name} must be greater than zero")
        if self.asr_max_retries < 0 or self.translation_max_retries < 0:
            raise ValueError("Provider retry limits must not be negative")
        if (
            not math.isfinite(self.transcript_overlap_tolerance_seconds)
            or not math.isfinite(self.transcript_duration_tolerance_seconds)
            or self.transcript_overlap_tolerance_seconds < 0
            or self.transcript_duration_tolerance_seconds < 0
        ):
            raise ValueError("Transcript tolerances must not be negative")
        if self.asr_language != "zh" or self.translation_source_language != "zh":
            raise ValueError("Phase 6 requires explicit Chinese ASR and translation input")
        if self.translation_target_language != "en":
            raise ValueError("Phase 6 requires explicit English translation output")
        if self.asr_provider != "fake" and not self.asr_api_key:
            raise ValueError("ASR API key is required for a real provider")
        if self.translation_provider != "fake" and not self.translation_api_key:
            raise ValueError("Translation API key is required for a real provider")

    @classmethod
    def from_environment(cls) -> "Settings":
        return cls(
            environment=os.getenv("DOUYIN_ENGLISH_ENVIRONMENT", "development"),
            audio_dir=_resolve_audio_dir(os.getenv("DOUYIN_ENGLISH_AUDIO_DIR")),
            media_temp_dir=_resolve_backend_path(
                os.getenv("DOUYIN_ENGLISH_MEDIA_TEMP_DIR"),
                "temp/media",
            ),
            language_cache_dir=_resolve_backend_path(
                os.getenv("DOUYIN_ENGLISH_LANGUAGE_CACHE_DIR"),
                "cache",
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
            shutdown_grace_seconds=_parse_positive_float(
                os.getenv("DOUYIN_ENGLISH_SHUTDOWN_GRACE_SECONDS"),
                10.0,
                "DOUYIN_ENGLISH_SHUTDOWN_GRACE_SECONDS",
            ),
            asr_provider=os.getenv("DOUYIN_ENGLISH_ASR_PROVIDER", "fake"),
            asr_model=os.getenv("DOUYIN_ENGLISH_ASR_MODEL", "fake-asr-v1"),
            asr_language=os.getenv("DOUYIN_ENGLISH_ASR_LANGUAGE", "zh"),
            asr_timestamp_granularity=os.getenv(
                "DOUYIN_ENGLISH_ASR_TIMESTAMP_GRANULARITY",
                "segment",
            ),
            asr_api_key=_optional_setting(os.getenv("DOUYIN_ENGLISH_ASR_API_KEY")),
            asr_proxy_url=_optional_setting(os.getenv("DOUYIN_ENGLISH_ASR_PROXY_URL")),
            asr_connect_timeout_seconds=_parse_positive_float(
                os.getenv("DOUYIN_ENGLISH_ASR_CONNECT_TIMEOUT_SECONDS"),
                5.0,
                "DOUYIN_ENGLISH_ASR_CONNECT_TIMEOUT_SECONDS",
            ),
            asr_read_timeout_seconds=_parse_positive_float(
                os.getenv("DOUYIN_ENGLISH_ASR_READ_TIMEOUT_SECONDS"),
                60.0,
                "DOUYIN_ENGLISH_ASR_READ_TIMEOUT_SECONDS",
            ),
            asr_write_timeout_seconds=_parse_positive_float(
                os.getenv("DOUYIN_ENGLISH_ASR_WRITE_TIMEOUT_SECONDS"),
                60.0,
                "DOUYIN_ENGLISH_ASR_WRITE_TIMEOUT_SECONDS",
            ),
            asr_total_timeout_seconds=_parse_positive_float(
                os.getenv("DOUYIN_ENGLISH_ASR_TOTAL_TIMEOUT_SECONDS"),
                90.0,
                "DOUYIN_ENGLISH_ASR_TOTAL_TIMEOUT_SECONDS",
            ),
            asr_max_retries=_parse_nonnegative_int(
                os.getenv("DOUYIN_ENGLISH_ASR_MAX_RETRIES"),
                2,
                "DOUYIN_ENGLISH_ASR_MAX_RETRIES",
            ),
            asr_max_audio_bytes=_parse_positive_int(
                os.getenv("DOUYIN_ENGLISH_ASR_MAX_AUDIO_BYTES"),
                24_000_000,
                "DOUYIN_ENGLISH_ASR_MAX_AUDIO_BYTES",
            ),
            asr_max_audio_duration_seconds=_parse_positive_float(
                os.getenv("DOUYIN_ENGLISH_ASR_MAX_AUDIO_DURATION_SECONDS"),
                12 * 60,
                "DOUYIN_ENGLISH_ASR_MAX_AUDIO_DURATION_SECONDS",
            ),
            transcript_max_segments=_parse_positive_int(
                os.getenv("DOUYIN_ENGLISH_TRANSCRIPT_MAX_SEGMENTS"),
                5000,
                "DOUYIN_ENGLISH_TRANSCRIPT_MAX_SEGMENTS",
            ),
            transcript_max_segment_characters=_parse_positive_int(
                os.getenv("DOUYIN_ENGLISH_TRANSCRIPT_MAX_SEGMENT_CHARACTERS"),
                4096,
                "DOUYIN_ENGLISH_TRANSCRIPT_MAX_SEGMENT_CHARACTERS",
            ),
            transcript_max_total_characters=_parse_positive_int(
                os.getenv("DOUYIN_ENGLISH_TRANSCRIPT_MAX_TOTAL_CHARACTERS"),
                500_000,
                "DOUYIN_ENGLISH_TRANSCRIPT_MAX_TOTAL_CHARACTERS",
            ),
            transcript_overlap_tolerance_seconds=float(
                os.getenv("DOUYIN_ENGLISH_TRANSCRIPT_OVERLAP_TOLERANCE_SECONDS", "0.25")
            ),
            transcript_duration_tolerance_seconds=float(
                os.getenv("DOUYIN_ENGLISH_TRANSCRIPT_DURATION_TOLERANCE_SECONDS", "0.5")
            ),
            translation_provider=os.getenv(
                "DOUYIN_ENGLISH_TRANSLATION_PROVIDER",
                "fake",
            ),
            translation_model=os.getenv(
                "DOUYIN_ENGLISH_TRANSLATION_MODEL",
                "fake-translation-v1",
            ),
            translation_api_version=os.getenv(
                "DOUYIN_ENGLISH_TRANSLATION_API_VERSION",
                "fake-v1",
            ),
            translation_source_language=os.getenv(
                "DOUYIN_ENGLISH_TRANSLATION_SOURCE_LANGUAGE",
                "zh",
            ),
            translation_target_language=os.getenv(
                "DOUYIN_ENGLISH_TRANSLATION_TARGET_LANGUAGE",
                "en",
            ),
            translation_prompt_version=os.getenv(
                "DOUYIN_ENGLISH_TRANSLATION_PROMPT_VERSION",
                "subtitle-v1",
            ),
            translation_strategy_version=os.getenv(
                "DOUYIN_ENGLISH_TRANSLATION_STRATEGY_VERSION",
                "context-v1",
            ),
            translation_api_key=_optional_setting(
                os.getenv("DOUYIN_ENGLISH_TRANSLATION_API_KEY")
            ),
            translation_proxy_url=_optional_setting(
                os.getenv("DOUYIN_ENGLISH_TRANSLATION_PROXY_URL")
            ),
            translation_connect_timeout_seconds=_parse_positive_float(
                os.getenv("DOUYIN_ENGLISH_TRANSLATION_CONNECT_TIMEOUT_SECONDS"),
                5.0,
                "DOUYIN_ENGLISH_TRANSLATION_CONNECT_TIMEOUT_SECONDS",
            ),
            translation_read_timeout_seconds=_parse_positive_float(
                os.getenv("DOUYIN_ENGLISH_TRANSLATION_READ_TIMEOUT_SECONDS"),
                60.0,
                "DOUYIN_ENGLISH_TRANSLATION_READ_TIMEOUT_SECONDS",
            ),
            translation_write_timeout_seconds=_parse_positive_float(
                os.getenv("DOUYIN_ENGLISH_TRANSLATION_WRITE_TIMEOUT_SECONDS"),
                60.0,
                "DOUYIN_ENGLISH_TRANSLATION_WRITE_TIMEOUT_SECONDS",
            ),
            translation_total_timeout_seconds=_parse_positive_float(
                os.getenv("DOUYIN_ENGLISH_TRANSLATION_TOTAL_TIMEOUT_SECONDS"),
                90.0,
                "DOUYIN_ENGLISH_TRANSLATION_TOTAL_TIMEOUT_SECONDS",
            ),
            translation_max_retries=_parse_nonnegative_int(
                os.getenv("DOUYIN_ENGLISH_TRANSLATION_MAX_RETRIES"),
                2,
                "DOUYIN_ENGLISH_TRANSLATION_MAX_RETRIES",
            ),
            translation_max_segment_characters=_parse_positive_int(
                os.getenv("DOUYIN_ENGLISH_TRANSLATION_MAX_SEGMENT_CHARACTERS"),
                8192,
                "DOUYIN_ENGLISH_TRANSLATION_MAX_SEGMENT_CHARACTERS",
            ),
            translation_max_total_characters=_parse_positive_int(
                os.getenv("DOUYIN_ENGLISH_TRANSLATION_MAX_TOTAL_CHARACTERS"),
                1_000_000,
                "DOUYIN_ENGLISH_TRANSLATION_MAX_TOTAL_CHARACTERS",
            ),
            language_cache_max_json_bytes=_parse_positive_int(
                os.getenv("DOUYIN_ENGLISH_LANGUAGE_CACHE_MAX_JSON_BYTES"),
                8 * 1024 * 1024,
                "DOUYIN_ENGLISH_LANGUAGE_CACHE_MAX_JSON_BYTES",
            ),
        )
