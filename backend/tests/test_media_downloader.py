from __future__ import annotations

import logging
from pathlib import Path

import httpx
import pytest

from app.services.media_downloader import (
    DOUYIN_BROWSER_USER_AGENT,
    DOUYIN_REFERER,
    HttpMediaDownloader,
    MediaDownloadError,
)


PUBLIC_IP = "93.184.216.34"


def make_downloader(
    handler,
    *,
    suffixes: tuple[str, ...] = ("example.com",),
    resolver=lambda _host, _port: (PUBLIC_IP,),
    max_bytes: int = 1024,
    max_redirects: int = 2,
    require_peer: bool = False,
    total_timeout: float = 10,
    clock=None,
) -> HttpMediaDownloader:
    client = httpx.Client(transport=httpx.MockTransport(handler), follow_redirects=False)
    kwargs = {} if clock is None else {"clock": clock}
    return HttpMediaDownloader(
        allowed_host_suffixes=suffixes,
        max_download_bytes=max_bytes,
        max_redirects=max_redirects,
        connect_timeout_seconds=1,
        read_timeout_seconds=1,
        total_timeout_seconds=total_timeout,
        resolver=resolver,
        client=client,
        require_connected_peer=require_peer,
        **kwargs,
    )


def test_successful_download_is_streamed_with_identity_encoding(tmp_path: Path) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["accept"] == "*/*"
        assert request.headers["accept-encoding"] == "identity"
        assert request.headers["host"] == "cdn.example.com"
        assert request.headers["referer"] == DOUYIN_REFERER
        assert request.headers["user-agent"] == DOUYIN_BROWSER_USER_AGENT
        assert request.extensions["sni_hostname"] == "cdn.example.com"
        assert request.extensions["timeout"] == {
            "connect": 1,
            "read": 1,
            "write": 1,
            "pool": 1,
        }
        assert request.url.host == PUBLIC_IP
        return httpx.Response(200, content=b"media", headers={"content-type": "video/mp4"})

    downloader = make_downloader(handler)
    destination = tmp_path / "source.media"
    try:
        downloader.download("https://cdn.example.com/video.mp4#ignored", destination)
    finally:
        downloader.close()

    assert destination.read_bytes() == b"media"


def test_browser_compatibility_headers_are_retained_across_redirects(
    tmp_path: Path,
) -> None:
    hosts: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        hosts.append(request.headers["host"])
        assert request.headers["accept"] == "*/*"
        assert request.headers["accept-encoding"] == "identity"
        assert request.headers["referer"] == DOUYIN_REFERER
        assert request.headers["user-agent"] == DOUYIN_BROWSER_USER_AGENT
        assert request.extensions["sni_hostname"] == request.headers["host"]
        if request.headers["host"] == "cdn.example.com":
            return httpx.Response(302, headers={"location": "https://media.example.com/file.mp4"})
        return httpx.Response(200, content=b"media", headers={"content-type": "video/mp4"})

    downloader = make_downloader(handler)
    destination = tmp_path / "redirected.media"
    try:
        downloader.download("https://cdn.example.com/start.mp4", destination)
    finally:
        downloader.close()

    assert hosts == ["cdn.example.com", "media.example.com"]
    assert destination.read_bytes() == b"media"


@pytest.mark.parametrize("status_code", [401, 403, 404, 410, 416, 429, 500])
def test_http_rejection_exposes_only_safe_status_and_host_diagnostics(
    tmp_path: Path,
    caplog: pytest.LogCaptureFixture,
    status_code: int,
) -> None:
    downloader = make_downloader(lambda _request: httpx.Response(status_code))
    secret = "signature=top-secret-token"
    try:
        with caplog.at_level(logging.WARNING, logger="app.services.media_downloader"):
            with pytest.raises(MediaDownloadError) as captured:
                downloader.download(
                    f"https://cdn.example.com/video.mp4?{secret}",
                    tmp_path / "rejected.media",
                )
    finally:
        downloader.close()

    assert str(captured.value) == f"Media server rejected the download (HTTP {status_code})"
    assert f"host=cdn.example.com status={status_code}" in caplog.text
    assert secret not in str(captured.value)
    assert secret not in caplog.text


def test_partial_content_response_is_accepted(tmp_path: Path) -> None:
    downloader = make_downloader(
        lambda _request: httpx.Response(
            206,
            content=b"partial-media",
            headers={"content-type": "video/mp4"},
        )
    )
    destination = tmp_path / "partial.media"
    try:
        downloader.download("https://cdn.example.com/video.mp4", destination)
    finally:
        downloader.close()

    assert destination.read_bytes() == b"partial-media"


@pytest.mark.parametrize(
    "address",
    ["127.0.0.1", "10.0.0.1", "172.16.0.1", "192.168.1.1", "169.254.1.1", "0.0.0.0"],
)
def test_non_public_resolved_addresses_are_rejected(
    tmp_path: Path,
    address: str,
) -> None:
    downloader = make_downloader(
        lambda _request: pytest.fail("request must not be sent"),
        resolver=lambda _host, _port: (address,),
    )
    try:
        with pytest.raises(MediaDownloadError, match="non-public"):
            downloader.download("https://cdn.example.com/video.mp4", tmp_path / "media")
    finally:
        downloader.close()


def test_mixed_public_and_private_dns_answer_is_rejected(tmp_path: Path) -> None:
    downloader = make_downloader(
        lambda _request: pytest.fail("request must not be sent"),
        resolver=lambda _host, _port: (PUBLIC_IP, "127.0.0.1"),
    )
    try:
        with pytest.raises(MediaDownloadError, match="non-public"):
            downloader.download("https://cdn.example.com/video.mp4", tmp_path / "media")
    finally:
        downloader.close()


def test_http_non_standard_port_credentials_and_suffix_confusion_are_rejected(
    tmp_path: Path,
) -> None:
    downloader = make_downloader(lambda _request: pytest.fail("request must not be sent"))
    invalid_urls = [
        "http://cdn.example.com/video.mp4",
        "https://cdn.example.com:444/video.mp4",
        "https://user:password@cdn.example.com/video.mp4",
        "https://example.com.attacker.test/video.mp4",
    ]
    try:
        for url in invalid_urls:
            with pytest.raises(MediaDownloadError):
                downloader.download(url, tmp_path / "media")
    finally:
        downloader.close()


@pytest.mark.parametrize(
    "url",
    [
        "https://cdn.example.com/live.m3u8?token=secret",
        "https://cdn.example.com/live.MPD",
        "https://cdn.example.com/live%2Em3u8",
    ],
)
def test_streaming_manifest_url_is_rejected_before_request(
    tmp_path: Path,
    url: str,
) -> None:
    downloader = make_downloader(lambda _request: pytest.fail("request must not be sent"))
    try:
        with pytest.raises(MediaDownloadError, match="manifest"):
            downloader.download(url, tmp_path / "media")
    finally:
        downloader.close()


def test_redirect_target_is_revalidated_before_second_request(tmp_path: Path) -> None:
    requests: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(str(request.url))
        return httpx.Response(302, headers={"location": "https://private.example.com/file"})

    def resolver(host: str, _port: int):
        return ("127.0.0.1",) if host == "private.example.com" else (PUBLIC_IP,)

    downloader = make_downloader(handler, resolver=resolver)
    try:
        with pytest.raises(MediaDownloadError, match="non-public"):
            downloader.download("https://cdn.example.com/video", tmp_path / "media")
    finally:
        downloader.close()

    assert requests == [f"https://{PUBLIC_IP}/video"]


def test_redirect_limit_is_enforced(tmp_path: Path) -> None:
    downloader = make_downloader(
        lambda _request: httpx.Response(302, headers={"location": "/again"}),
        max_redirects=1,
    )
    try:
        with pytest.raises(MediaDownloadError, match="too many"):
            downloader.download("https://cdn.example.com/start", tmp_path / "media")
    finally:
        downloader.close()


@pytest.mark.parametrize(
    "response",
    [
        httpx.Response(200, content=b"x", headers={"content-length": "2048"}),
        httpx.Response(200, content=b"x" * 2048),
    ],
)
def test_size_limit_removes_partial_file(tmp_path: Path, response: httpx.Response) -> None:
    downloader = make_downloader(lambda _request: response, max_bytes=1024)
    destination = tmp_path / "media"
    try:
        with pytest.raises(MediaDownloadError, match="size limit"):
            downloader.download("https://cdn.example.com/video", destination)
    finally:
        downloader.close()

    assert not destination.exists()


@pytest.mark.parametrize("content_type", ["text/html", "application/json; charset=utf-8"])
def test_non_media_responses_are_rejected(tmp_path: Path, content_type: str) -> None:
    downloader = make_downloader(
        lambda _request: httpx.Response(
            200,
            content=b"not media",
            headers={"content-type": content_type},
        )
    )
    try:
        with pytest.raises(MediaDownloadError, match="non-media"):
            downloader.download("https://cdn.example.com/video", tmp_path / "media")
    finally:
        downloader.close()


@pytest.mark.parametrize(
    "content_type",
    [
        "application/vnd.apple.mpegurl",
        "application/x-mpegurl",
        "application/dash+xml",
        "audio/mpegurl",
    ],
)
def test_hls_and_dash_content_types_are_rejected(
    tmp_path: Path,
    content_type: str,
) -> None:
    downloader = make_downloader(
        lambda _request: httpx.Response(
            200,
            content=b"manifest",
            headers={"content-type": content_type},
        )
    )
    try:
        with pytest.raises(MediaDownloadError, match="non-media"):
            downloader.download("https://cdn.example.com/video", tmp_path / "media")
    finally:
        downloader.close()


@pytest.mark.parametrize(
    "content",
    [
        b"#EXTM3U\n#EXT-X-VERSION:3",
        b"<?xml version='1.0'?><MPD></MPD>",
        b"ffconcat version 1.0\nfile http://example.test/a.mp3",
    ],
)
def test_disguised_streaming_manifest_content_is_rejected(
    tmp_path: Path,
    content: bytes,
) -> None:
    downloader = make_downloader(
        lambda _request: httpx.Response(
            200,
            content=content,
            headers={"content-type": "application/octet-stream"},
        )
    )
    destination = tmp_path / "media"
    try:
        with pytest.raises(MediaDownloadError, match="manifest"):
            downloader.download("https://cdn.example.com/video", destination)
    finally:
        downloader.close()
    assert not destination.exists()


def test_empty_and_timeout_responses_are_rejected(tmp_path: Path) -> None:
    empty = make_downloader(lambda _request: httpx.Response(200, content=b""))
    try:
        with pytest.raises(MediaDownloadError, match="empty"):
            empty.download("https://cdn.example.com/video", tmp_path / "empty")
    finally:
        empty.close()

    def timeout(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("slow", request=request)

    timed_out = make_downloader(timeout)
    try:
        with pytest.raises(MediaDownloadError, match="timed out"):
            timed_out.download("https://cdn.example.com/video", tmp_path / "timeout")
    finally:
        timed_out.close()


def test_overall_wall_clock_deadline_is_enforced(tmp_path: Path) -> None:
    class Clock:
        value = 0.0

        def __call__(self) -> float:
            return self.value

    class SlowStream(httpx.SyncByteStream):
        def __init__(self, clock: Clock) -> None:
            self.clock = clock

        def __iter__(self):
            self.clock.value = 2.0
            yield b"late"

    clock = Clock()
    downloader = make_downloader(
        lambda _request: httpx.Response(200, stream=SlowStream(clock)),
        total_timeout=1,
        clock=clock,
    )
    try:
        with pytest.raises(MediaDownloadError, match="timed out"):
            downloader.download("https://cdn.example.com/video", tmp_path / "media")
    finally:
        downloader.close()


def test_connected_peer_must_be_present_public_and_pre_resolved(tmp_path: Path) -> None:
    missing = make_downloader(
        lambda _request: httpx.Response(200, content=b"media"),
        require_peer=True,
    )
    try:
        with pytest.raises(MediaDownloadError, match="could not be verified"):
            missing.download("https://cdn.example.com/video", tmp_path / "missing")
    finally:
        missing.close()

    class FakeNetworkStream:
        def get_extra_info(self, _name: str):
            return ("127.0.0.1", 443)

    private = make_downloader(
        lambda _request: httpx.Response(
            200,
            content=b"media",
            extensions={"network_stream": FakeNetworkStream()},
        ),
        require_peer=True,
    )
    try:
        with pytest.raises(MediaDownloadError, match="did not pass"):
            private.download("https://cdn.example.com/video", tmp_path / "private")
    finally:
        private.close()

    class MatchingNetworkStream:
        def get_extra_info(self, _name: str):
            return (PUBLIC_IP, 443)

    matching = make_downloader(
        lambda _request: httpx.Response(
            200,
            content=b"media",
            extensions={"network_stream": MatchingNetworkStream()},
        ),
        require_peer=True,
    )
    destination = tmp_path / "matching"
    try:
        matching.download("https://cdn.example.com/video", destination)
    finally:
        matching.close()
    assert destination.read_bytes() == b"media"
