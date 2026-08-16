from __future__ import annotations

import re
from collections.abc import Awaitable, Callable

from fastapi import Request, Response, status
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware


class OriginGuardMiddleware(BaseHTTPMiddleware):
    """Reject state-changing browser requests before they reach the API."""

    def __init__(
        self,
        app,
        *,
        allowed_origins: tuple[str, ...],
        allowed_origin_regex: str,
        allow_missing_origin: bool,
    ) -> None:
        super().__init__(app)
        self._allowed_origins = frozenset(allowed_origins)
        self._allowed_origin_pattern = re.compile(allowed_origin_regex)
        self._allow_missing_origin = allow_missing_origin

    async def dispatch(
        self,
        request: Request,
        call_next: Callable[[Request], Awaitable[Response]],
    ) -> Response:
        if request.method not in {"POST", "PUT", "PATCH", "DELETE"}:
            return await call_next(request)

        origin = request.headers.get("origin")
        if origin is None and self._allow_missing_origin:
            return await call_next(request)
        if origin is not None and (
            origin in self._allowed_origins
            or self._allowed_origin_pattern.fullmatch(origin) is not None
        ):
            return await call_next(request)
        return JSONResponse(
            status_code=status.HTTP_403_FORBIDDEN,
            content={"detail": "Origin is not allowed"},
        )
