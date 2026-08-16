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


@dataclass(frozen=True, slots=True)
class Settings:
    app_name: str = "Douyin English API"
    app_version: str = "0.1.0"
    environment: str = "development"
    audio_dir: Path = field(default_factory=lambda: BACKEND_ROOT / "output" / "audio")
    cors_origins: tuple[str, ...] = field(default_factory=_default_cors_origins)
    cors_origin_regex: str = r"^chrome-extension://[a-p]{32}$"

    @classmethod
    def from_environment(cls) -> "Settings":
        return cls(
            environment=os.getenv("DOUYIN_ENGLISH_ENVIRONMENT", "development"),
            audio_dir=_resolve_audio_dir(os.getenv("DOUYIN_ENGLISH_AUDIO_DIR")),
            cors_origins=_parse_cors_origins(os.getenv("DOUYIN_ENGLISH_CORS_ORIGINS")),
            cors_origin_regex=os.getenv(
                "DOUYIN_ENGLISH_CORS_ORIGIN_REGEX",
                r"^chrome-extension://[a-p]{32}$",
            ),
        )
