from __future__ import annotations

import ipaddress
import socket
import time
from collections.abc import Callable, Iterable
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeoutError
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol
from urllib.parse import unquote, urljoin, urlsplit, urlunsplit

import httpx


REDIRECT_STATUS_CODES = {301, 302, 303, 307, 308}


class MediaDownloadError(RuntimeError):
    """A download failure whose message is safe to expose through the task API."""


class HostResolver(Protocol):
    def __call__(self, host: str, port: int) -> Iterable[str]: ...


def system_host_resolver(host: str, port: int) -> tuple[str, ...]:
    try:
        records = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except socket.gaierror as exc:
        raise MediaDownloadError("Media host could not be resolved") from exc
    return tuple(dict.fromkeys(record[4][0] for record in records))


@dataclass(frozen=True, slots=True)
class ResolvedTarget:
    url: str
    request_url: str
    host: str
    port: int
    addresses: frozenset[ipaddress.IPv4Address | ipaddress.IPv6Address]
    pinned_address: ipaddress.IPv4Address | ipaddress.IPv6Address


class HttpMediaDownloader:
    """Streams an allowlisted public HTTP(S) resource into a bounded local file."""

    def __init__(
        self,
        *,
        allowed_host_suffixes: tuple[str, ...],
        max_download_bytes: int,
        max_redirects: int,
        connect_timeout_seconds: float,
        read_timeout_seconds: float,
        total_timeout_seconds: float,
        resolver: HostResolver = system_host_resolver,
        client: httpx.Client | None = None,
        require_connected_peer: bool = True,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._allowed_host_suffixes = tuple(
            suffix.lower().strip().lstrip(".")
            for suffix in allowed_host_suffixes
            if suffix.strip()
        )
        self._max_download_bytes = max_download_bytes
        self._max_redirects = max_redirects
        self._resolver = resolver
        self._connect_timeout_seconds = connect_timeout_seconds
        self._read_timeout_seconds = read_timeout_seconds
        self._total_timeout_seconds = total_timeout_seconds
        self._require_connected_peer = require_connected_peer
        self._clock = clock
        self._resolver_executor = ThreadPoolExecutor(
            max_workers=4,
            thread_name_prefix="media-dns",
        )
        self._owns_client = client is None
        self._client = client or httpx.Client(
            follow_redirects=False,
            trust_env=False,
            timeout=httpx.Timeout(
                connect=connect_timeout_seconds,
                read=read_timeout_seconds,
                write=read_timeout_seconds,
                pool=connect_timeout_seconds,
            ),
            headers={"User-Agent": "DouyinEnglishMVP/0.2"},
        )

    def close(self) -> None:
        if self._owns_client:
            self._client.close()
        self._resolver_executor.shutdown(wait=False, cancel_futures=True)

    def download(self, url: str, destination: Path) -> None:
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.unlink(missing_ok=True)
        current_url = url
        redirects_followed = 0
        completed = False
        deadline = self._clock() + self._total_timeout_seconds

        try:
            while True:
                target = self._validate_and_resolve(current_url, deadline)
                remaining = self._remaining(deadline)
                request_timeout = httpx.Timeout(
                    connect=min(self._connect_timeout_seconds, remaining),
                    read=min(self._read_timeout_seconds, remaining),
                    write=min(self._read_timeout_seconds, remaining),
                    pool=min(self._connect_timeout_seconds, remaining),
                )
                with self._client.stream(
                    "GET",
                    target.request_url,
                    headers={
                        "Accept": "video/*,audio/*,application/octet-stream;q=0.8",
                        "Accept-Encoding": "identity",
                        "Connection": "close",
                        "Host": target.host,
                    },
                    timeout=request_timeout,
                    extensions={"sni_hostname": target.host},
                ) as response:
                    self._validate_connected_peer(
                        response,
                        target.pinned_address,
                        required=self._require_connected_peer,
                    )

                    if response.status_code in REDIRECT_STATUS_CODES:
                        if redirects_followed >= self._max_redirects:
                            raise MediaDownloadError("Media URL redirected too many times")
                        location = response.headers.get("location")
                        if not location or len(location) > 4096:
                            raise MediaDownloadError("Media URL returned an invalid redirect")
                        current_url = urljoin(target.url, location)
                        redirects_followed += 1
                        continue

                    try:
                        response.raise_for_status()
                    except httpx.HTTPStatusError as exc:
                        raise MediaDownloadError("Media server rejected the download") from exc

                    self._validate_content_type(response)

                    declared_size = self._content_length(response)
                    if declared_size is not None and declared_size > self._max_download_bytes:
                        raise MediaDownloadError("Media file exceeds the download size limit")

                    total = 0
                    prefix = bytearray()
                    with destination.open("xb") as output:
                        for chunk in response.iter_bytes(chunk_size=64 * 1024):
                            self._remaining(deadline)
                            total += len(chunk)
                            if total > self._max_download_bytes:
                                raise MediaDownloadError(
                                    "Media file exceeds the download size limit"
                                )
                            if len(prefix) < 4096:
                                prefix.extend(chunk[: 4096 - len(prefix)])
                            output.write(chunk)
                    if total == 0:
                        raise MediaDownloadError("Media server returned an empty file")
                    if self._looks_like_streaming_manifest(bytes(prefix)):
                        raise MediaDownloadError("Streaming manifests are not supported")
                    completed = True
                    return
        except MediaDownloadError:
            raise
        except httpx.TimeoutException as exc:
            raise MediaDownloadError("Media download timed out") from exc
        except httpx.RequestError as exc:
            raise MediaDownloadError("Media download failed") from exc
        except OSError as exc:
            raise MediaDownloadError("Media file could not be saved") from exc
        finally:
            if not completed:
                destination.unlink(missing_ok=True)

    def _validate_and_resolve(self, url: str, deadline: float) -> ResolvedTarget:
        if len(url) > 8192:
            raise MediaDownloadError("Media URL is too long")
        try:
            parsed = urlsplit(url)
            port = parsed.port
        except ValueError as exc:
            raise MediaDownloadError("Media URL is invalid") from exc

        scheme = parsed.scheme.lower()
        if scheme != "https":
            raise MediaDownloadError("Media URL must use HTTPS")
        if parsed.username is not None or parsed.password is not None:
            raise MediaDownloadError("Media URL credentials are not allowed")
        if not parsed.hostname:
            raise MediaDownloadError("Media URL has no host")
        decoded_path = unquote(parsed.path).lower()
        if decoded_path.endswith((".m3u8", ".mpd")):
            raise MediaDownloadError("Streaming manifest URLs are not supported")

        try:
            host = parsed.hostname.rstrip(".").encode("idna").decode("ascii").lower()
        except UnicodeError as exc:
            raise MediaDownloadError("Media URL host is invalid") from exc
        if not self._host_is_allowlisted(host):
            raise MediaDownloadError("Media host is not allowed")

        resolved_port = port or 443
        if resolved_port != 443:
            raise MediaDownloadError("Media URL must use HTTPS port 443")
        try:
            resolution = self._resolver_executor.submit(self._resolver, host, resolved_port)
            raw_addresses = tuple(resolution.result(timeout=self._remaining(deadline)))
            addresses = frozenset(ipaddress.ip_address(value) for value in raw_addresses)
        except FutureTimeoutError as exc:
            resolution.cancel()
            raise MediaDownloadError("Media download timed out") from exc
        except MediaDownloadError:
            raise
        except (ValueError, OSError) as exc:
            raise MediaDownloadError("Media host could not be resolved") from exc
        if not addresses:
            raise MediaDownloadError("Media host could not be resolved")
        if any(not address.is_global for address in addresses):
            raise MediaDownloadError("Media host resolved to a non-public address")

        normalized_url = urlunsplit(
            (scheme, parsed.netloc, parsed.path or "/", parsed.query, "")
        )
        pinned_address = sorted(
            addresses,
            key=lambda address: (address.version, int(address)),
        )[0]
        pinned_host = (
            f"[{pinned_address.compressed}]"
            if pinned_address.version == 6
            else pinned_address.compressed
        )
        request_url = urlunsplit(
            (scheme, pinned_host, parsed.path or "/", parsed.query, "")
        )
        return ResolvedTarget(
            url=normalized_url,
            request_url=request_url,
            host=host,
            port=resolved_port,
            addresses=addresses,
            pinned_address=pinned_address,
        )

    def _host_is_allowlisted(self, host: str) -> bool:
        return any(
            host == suffix or host.endswith(f".{suffix}")
            for suffix in self._allowed_host_suffixes
        )

    @staticmethod
    def _content_length(response: httpx.Response) -> int | None:
        value = response.headers.get("content-length")
        if value is None:
            return None
        try:
            parsed = int(value)
        except ValueError:
            return None
        return parsed if parsed >= 0 else None

    @staticmethod
    def _validate_content_type(response: httpx.Response) -> None:
        content_type = response.headers.get("content-type", "")
        media_type = content_type.partition(";")[0].strip().lower()
        if media_type.startswith("text/") or media_type in {
            "application/json",
            "application/ld+json",
            "application/xml",
            "application/xhtml+xml",
            "application/javascript",
            "application/vnd.apple.mpegurl",
            "application/x-mpegurl",
            "application/mpegurl",
            "application/dash+xml",
            "audio/mpegurl",
            "audio/x-mpegurl",
        }:
            raise MediaDownloadError("Media URL returned a non-media response")

    @staticmethod
    def _looks_like_streaming_manifest(prefix: bytes) -> bool:
        normalized = prefix.lstrip(b"\xef\xbb\xbf \t\r\n").lower()
        return (
            normalized.startswith(b"#extm3u")
            or normalized.startswith(b"ffconcat version")
            or b"<mpd" in normalized
        )

    @staticmethod
    def _validate_connected_peer(
        response: httpx.Response,
        pinned_address: ipaddress.IPv4Address | ipaddress.IPv6Address,
        *,
        required: bool,
    ) -> None:
        stream = response.extensions.get("network_stream")
        if stream is None or not hasattr(stream, "get_extra_info"):
            if required:
                raise MediaDownloadError("Media connection address could not be verified")
            return
        server_address = stream.get_extra_info("server_addr")
        if not server_address:
            if required:
                raise MediaDownloadError("Media connection address could not be verified")
            return
        value = server_address[0] if isinstance(server_address, tuple) else server_address
        try:
            peer = ipaddress.ip_address(value)
        except ValueError as exc:
            raise MediaDownloadError("Media connection address is invalid") from exc
        if not peer.is_global or peer != pinned_address:
            raise MediaDownloadError("Media connection address did not pass validation")

    def _remaining(self, deadline: float) -> float:
        remaining = deadline - self._clock()
        if remaining <= 0:
            raise MediaDownloadError("Media download timed out")
        return remaining
