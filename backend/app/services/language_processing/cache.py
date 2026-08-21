from __future__ import annotations

import hashlib
import json
import os
import re
from collections.abc import Callable
from concurrent.futures import Future
from pathlib import Path
from threading import Lock
from typing import Generic, Protocol, TypeVar
from uuid import uuid4

from app.services.language_processing.errors import CacheWriteError
from app.services.language_processing.models import (
    ProviderMetadata,
    TranscriptResult,
    TranscriptSegment,
    TranslationResult,
    TranslationUnit,
)
from app.services.language_processing.validation import (
    TRANSCRIPT_VALIDATOR_VERSION,
    TRANSLATION_VALIDATOR_VERSION,
)


ASR_CACHE_SCHEMA_VERSION = 1
TRANSLATION_CACHE_SCHEMA_VERSION = 1
_CACHE_KEY_PATTERN = re.compile(r"^[a-f0-9]{64}$")
_SEGMENT_ID_PATTERN = re.compile(r"^s[0-9]{6}$")
_T = TypeVar("_T")


class ASRCache(Protocol):
    def build_key(
        self,
        *,
        audio_sha256: str,
        provider: str,
        model: str,
        language: str,
        timestamp_granularity: str,
        validator_version: str = TRANSCRIPT_VALIDATOR_VERSION,
    ) -> str: ...

    def load(self, key: str) -> TranscriptResult | None: ...

    def save(self, key: str, result: TranscriptResult) -> None: ...


class TranslationCache(Protocol):
    def build_key(
        self,
        *,
        segments: tuple[tuple[str, str], ...],
        provider: str,
        model: str,
        api_version: str,
        source_language: str,
        target_language: str,
        prompt_version: str,
        strategy_version: str,
        validator_version: str = TRANSLATION_VALIDATOR_VERSION,
    ) -> str: ...

    def load(self, key: str) -> TranslationResult | None: ...

    def save(self, key: str, result: TranslationResult) -> None: ...


def _canonical_digest(payload: object) -> str:
    encoded = json.dumps(
        payload,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _reject_json_constant(value: str) -> None:
    raise ValueError(f"Invalid JSON constant: {value}")


def _is_json_number(value: object) -> bool:
    return not isinstance(value, bool) and isinstance(value, (int, float))


def hash_file(path: Path) -> str:
    digest = hashlib.sha256()
    try:
        with path.open("rb") as source:
            while chunk := source.read(1024 * 1024):
                digest.update(chunk)
    except OSError as exc:
        raise CacheWriteError("Extracted audio could not be hashed") from exc
    return digest.hexdigest()


class SingleFlight(Generic[_T]):
    """Shares one in-process computation, including its exception, per cache key."""

    def __init__(self) -> None:
        self._lock = Lock()
        self._inflight: dict[str, Future[_T]] = {}

    def run(self, key: str, compute: Callable[[], _T]) -> _T:
        with self._lock:
            future = self._inflight.get(key)
            if future is None:
                future = Future()
                self._inflight[key] = future
                leader = True
            else:
                leader = False
        if not leader:
            return future.result()
        try:
            result = compute()
        except BaseException as exc:
            future.set_exception(exc)
            raise
        else:
            future.set_result(result)
            return result
        finally:
            with self._lock:
                if self._inflight.get(key) is future:
                    self._inflight.pop(key, None)


class _FileCache:
    def __init__(self, root: Path, *, max_json_bytes: int = 8 * 1024 * 1024) -> None:
        if max_json_bytes <= 0:
            raise ValueError("Cache JSON limit must be greater than zero")
        self._root = root.resolve()
        self._max_json_bytes = max_json_bytes

    def _path(self, key: str, filename: str) -> Path:
        if not _CACHE_KEY_PATTERN.fullmatch(key):
            raise ValueError("Cache key is invalid")
        return self._root / key / filename

    def _read_json(self, path: Path) -> object | None:
        try:
            if not path.is_file() or path.stat().st_size > self._max_json_bytes:
                return None
            return json.loads(
                path.read_text(encoding="utf-8"),
                parse_constant=_reject_json_constant,
            )
        except (OSError, UnicodeError, ValueError, json.JSONDecodeError):
            return None

    def _write_json(self, path: Path, payload: object) -> None:
        try:
            encoded = json.dumps(
                payload,
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
                allow_nan=False,
            ).encode("utf-8")
            if len(encoded) > self._max_json_bytes:
                raise CacheWriteError("Language cache result exceeds the size limit")
            path.parent.mkdir(parents=True, exist_ok=True)
            temporary = path.with_name(f".{path.name}.{uuid4().hex}.tmp")
            try:
                with temporary.open("xb") as output:
                    output.write(encoded)
                    output.flush()
                    os.fsync(output.fileno())
                os.replace(temporary, path)
            finally:
                temporary.unlink(missing_ok=True)
        except CacheWriteError:
            raise
        except OSError as exc:
            raise CacheWriteError("Language cache could not be written") from exc


class FileASRCache(_FileCache):
    filename = "transcript.json"

    @staticmethod
    def build_key(
        *,
        audio_sha256: str,
        provider: str,
        model: str,
        language: str,
        timestamp_granularity: str,
        validator_version: str = TRANSCRIPT_VALIDATOR_VERSION,
    ) -> str:
        return _canonical_digest(
            {
                "audio_sha256": audio_sha256,
                "language": language,
                "model": model,
                "provider": provider,
                "schema_version": ASR_CACHE_SCHEMA_VERSION,
                "timestamp_granularity": timestamp_granularity,
                "validator_version": validator_version,
            }
        )

    def load(self, key: str) -> TranscriptResult | None:
        payload = self._read_json(self._path(key, self.filename))
        try:
            if not isinstance(payload, dict) or set(payload) != {
                "kind",
                "schema_version",
                "transcript",
                "validator_version",
            }:
                return None
            if (
                payload["kind"] != "asr"
                or payload["schema_version"] != ASR_CACHE_SCHEMA_VERSION
                or payload["validator_version"] != TRANSCRIPT_VALIDATOR_VERSION
            ):
                return None
            transcript = payload["transcript"]
            if not isinstance(transcript, dict) or set(transcript) != {
                "audio_duration",
                "language",
                "model",
                "provider",
                "segments",
            }:
                return None
            segments = transcript["segments"]
            if not isinstance(segments, list):
                return None
            if not all(
                isinstance(segment, dict)
                and set(segment) == {"end", "segment_id", "start", "text"}
                and isinstance(segment["segment_id"], str)
                and _SEGMENT_ID_PATTERN.fullmatch(segment["segment_id"]) is not None
                and isinstance(segment["text"], str)
                and _is_json_number(segment["start"])
                and _is_json_number(segment["end"])
                for segment in segments
            ):
                return None
            if (
                not isinstance(transcript["language"], str)
                or not isinstance(transcript["provider"], str)
                or not isinstance(transcript["model"], str)
                or not _is_json_number(transcript["audio_duration"])
            ):
                return None
            return TranscriptResult(
                language=transcript["language"],
                audio_duration=transcript["audio_duration"],
                segments=tuple(
                    TranscriptSegment(
                        segment_id=segment["segment_id"],
                        start=segment["start"],
                        end=segment["end"],
                        text=segment["text"],
                    )
                    for segment in segments
                ),
                provider_metadata=ProviderMetadata(
                    provider=transcript["provider"],
                    model=transcript["model"],
                ),
            )
        except (KeyError, TypeError, ValueError):
            return None

    def save(self, key: str, result: TranscriptResult) -> None:
        self._write_json(
            self._path(key, self.filename),
            {
                "kind": "asr",
                "schema_version": ASR_CACHE_SCHEMA_VERSION,
                "validator_version": TRANSCRIPT_VALIDATOR_VERSION,
                "transcript": {
                    "audio_duration": result.audio_duration,
                    "language": result.language,
                    "model": result.provider_metadata.model,
                    "provider": result.provider_metadata.provider,
                    "segments": [
                        {
                            "end": segment.end,
                            "segment_id": segment.segment_id,
                            "start": segment.start,
                            "text": segment.text,
                        }
                        for segment in result.segments
                    ],
                },
            },
        )


class FileTranslationCache(_FileCache):
    filename = "translation.json"

    @staticmethod
    def build_key(
        *,
        segments: tuple[tuple[str, str], ...],
        provider: str,
        model: str,
        api_version: str,
        source_language: str,
        target_language: str,
        prompt_version: str,
        strategy_version: str,
        validator_version: str = TRANSLATION_VALIDATOR_VERSION,
    ) -> str:
        return _canonical_digest(
            {
                "api_version": api_version,
                "model": model,
                "prompt_version": prompt_version,
                "provider": provider,
                "schema_version": TRANSLATION_CACHE_SCHEMA_VERSION,
                "segments": [
                    {"segment_id": segment_id, "text": text}
                    for segment_id, text in segments
                ],
                "source_language": source_language,
                "strategy_version": strategy_version,
                "target_language": target_language,
                "validator_version": validator_version,
            }
        )

    def load(self, key: str) -> TranslationResult | None:
        payload = self._read_json(self._path(key, self.filename))
        try:
            if not isinstance(payload, dict) or set(payload) != {
                "kind",
                "schema_version",
                "translation",
                "validator_version",
            }:
                return None
            if (
                payload["kind"] != "translation"
                or payload["schema_version"] != TRANSLATION_CACHE_SCHEMA_VERSION
                or payload["validator_version"] != TRANSLATION_VALIDATOR_VERSION
            ):
                return None
            translation = payload["translation"]
            if not isinstance(translation, dict) or set(translation) != {
                "model",
                "provider",
                "source_language",
                "strategy_version",
                "target_language",
                "units",
            }:
                return None
            units = translation["units"]
            if not isinstance(units, list):
                return None
            if not all(
                isinstance(unit, dict)
                and set(unit) == {"segment_id", "text"}
                and isinstance(unit["segment_id"], str)
                and _SEGMENT_ID_PATTERN.fullmatch(unit["segment_id"]) is not None
                and isinstance(unit["text"], str)
                for unit in units
            ):
                return None
            if not all(
                isinstance(translation[name], str)
                for name in (
                    "model",
                    "provider",
                    "source_language",
                    "strategy_version",
                    "target_language",
                )
            ):
                return None
            return TranslationResult(
                source_language=translation["source_language"],
                target_language=translation["target_language"],
                units=tuple(
                    TranslationUnit(
                        segment_id=unit["segment_id"],
                        text=unit["text"],
                    )
                    for unit in units
                ),
                provider_metadata=ProviderMetadata(
                    provider=translation["provider"],
                    model=translation["model"],
                ),
                strategy_version=translation["strategy_version"],
            )
        except (KeyError, TypeError, ValueError):
            return None

    def save(self, key: str, result: TranslationResult) -> None:
        self._write_json(
            self._path(key, self.filename),
            {
                "kind": "translation",
                "schema_version": TRANSLATION_CACHE_SCHEMA_VERSION,
                "validator_version": TRANSLATION_VALIDATOR_VERSION,
                "translation": {
                    "model": result.provider_metadata.model,
                    "provider": result.provider_metadata.provider,
                    "source_language": result.source_language,
                    "strategy_version": result.strategy_version,
                    "target_language": result.target_language,
                    "units": [
                        {"segment_id": unit.segment_id, "text": unit.text}
                        for unit in result.units
                    ],
                },
            },
        )
