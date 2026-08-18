import { describe, expect, it, vi } from "vitest";
import {
  AudioSourceResolver,
  BoundAwemeSourceProvider,
  DirectVideoSourceProvider,
} from "../src/content/audioSourceProvider";
import { CapturedAwemeSourceRegistry } from "../src/content/capturedAwemeSources";
import type { ActiveVideo } from "../src/content/videoDetector";
import { createMediaCaptureMessage } from "../src/shared/awemeMediaCapture";
import {
  VideoProcessingCoordinator,
  type VideoTaskTransport,
} from "../src/content/videoProcessingCoordinator";
import type { VideoProcessingStatus, VideoTask } from "../src/types/videoProcessing";

function createActiveVideo(
  videoKey: string,
  sourceUrl: string,
  boundAwemeId: string | null = null,
  element = document.createElement("video"),
): ActiveVideo {
  Object.defineProperty(element, "currentSrc", { configurable: true, value: sourceUrl });
  return { element, videoKey, boundAwemeId, currentTime: 0, playing: false };
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("VideoProcessingCoordinator", () => {
  it("submits, polls, and exposes READY audio without playing it", async () => {
    const statuses: VideoProcessingStatus[] = [];
    const transport: VideoTaskTransport = {
      start: vi.fn().mockResolvedValue({ taskId: "task-1", status: "PROCESSING", progress: 10 }),
      get: vi.fn().mockResolvedValue({
        taskId: "task-1",
        status: "READY",
        progress: 100,
        audioUrl: "/audio/task-1.wav",
      }),
    };
    let scheduled: (() => void) | undefined;
    const coordinator = new VideoProcessingCoordinator(
      new AudioSourceResolver([new DirectVideoSourceProvider()]),
      transport,
      (status) => statuses.push(status),
      1,
      5,
      { set: (callback) => ((scheduled = callback), 1), clear: vi.fn() },
    );

    coordinator.setActiveVideo(createActiveVideo("video-1", "https://v1.douyinvod.com/one.mp4"));
    coordinator.setEnabled(true);
    await flushPromises();
    expect(statuses.at(-1)).toMatchObject({ state: "PROCESSING", taskId: "task-1", progress: 10 });

    scheduled?.();
    await flushPromises();
    expect(statuses.at(-1)).toMatchObject({
      state: "READY",
      audioUrl: "/audio/task-1.wav",
      message: expect.stringContaining("not played"),
    });
  });

  it("ignores a late response after switching videos", async () => {
    const first = deferred<VideoTask>();
    const statuses: VideoProcessingStatus[] = [];
    const transport: VideoTaskTransport = {
      start: vi
        .fn()
        .mockImplementationOnce(() => first.promise)
        .mockResolvedValueOnce({ taskId: "task-b", status: "READY", audioUrl: "/audio/b.wav" }),
      get: vi.fn(),
    };
    const coordinator = new VideoProcessingCoordinator(
      new AudioSourceResolver([new DirectVideoSourceProvider()]),
      transport,
      (status) => statuses.push(status),
    );

    coordinator.setActiveVideo(createActiveVideo("A", "https://v1.douyinvod.com/a.mp4"));
    coordinator.setEnabled(true);
    coordinator.setActiveVideo(createActiveVideo("B", "https://v1.douyinvod.com/b.mp4"));
    await flushPromises();
    first.resolve({ taskId: "task-a", status: "READY", audioUrl: "/audio/a.wav" });
    await flushPromises();

    expect(statuses.at(-1)).toMatchObject({ state: "READY", videoKey: "B", audioUrl: "/audio/b.wav" });
    expect(statuses.some((status) => status.taskId === "task-a")).toBe(false);
  });

  it("deduplicates the same videoKey and fails gracefully when no source is available", async () => {
    const statuses: VideoProcessingStatus[] = [];
    const transport: VideoTaskTransport = {
      start: vi.fn().mockResolvedValue({ taskId: "task-a", status: "PROCESSING" }),
      get: vi.fn(),
    };
    const coordinator = new VideoProcessingCoordinator(
      new AudioSourceResolver([new DirectVideoSourceProvider()]),
      transport,
      (status) => statuses.push(status),
    );

    coordinator.setEnabled(true);
    const active = createActiveVideo("A", "https://v1.douyinvod.com/a.mp4");
    coordinator.setActiveVideo(active);
    coordinator.setActiveVideo(active);
    await flushPromises();
    expect(transport.start).toHaveBeenCalledTimes(1);

    coordinator.setActiveVideo(createActiveVideo("B", "blob:https://www.douyin.com/no-match"));
    expect(statuses.at(-1)).toMatchObject({
      state: "SOURCE_UNAVAILABLE",
      videoKey: "B",
      message: expect.stringContaining("mock playback is unchanged"),
    });
  });

  it("retries the current source after local backend access becomes available", async () => {
    const statuses: VideoProcessingStatus[] = [];
    const transport: VideoTaskTransport = {
      start: vi
        .fn()
        .mockRejectedValueOnce(new Error("Local network access denied"))
        .mockResolvedValueOnce({ taskId: "task-retry", status: "READY", audioUrl: "/audio/retry.wav" }),
      get: vi.fn(),
    };
    const coordinator = new VideoProcessingCoordinator(
      new AudioSourceResolver([new DirectVideoSourceProvider()]),
      transport,
      (status) => statuses.push(status),
    );

    coordinator.setActiveVideo(createActiveVideo("A", "https://v1.douyinvod.com/a.mp4"));
    coordinator.setEnabled(true);
    await flushPromises();
    expect(statuses.at(-1)).toMatchObject({ state: "ERROR" });

    coordinator.retry();
    await flushPromises();

    expect(transport.start).toHaveBeenCalledTimes(2);
    expect(statuses.at(-1)).toMatchObject({ state: "READY", taskId: "task-retry" });
  });

  it("restarts the same video when its certified aweme binding appears later", async () => {
    const awemeId = "7382738211234567890";
    const mediaUrl = "https://v1.douyinvod.com/video/bound.mp4";
    const registry = new CapturedAwemeSourceRegistry();
    registry.ingest(createMediaCaptureMessage([{ awemeId, urls: [mediaUrl] }]));
    const container = document.createElement("div");
    container.dataset.e2eVid = awemeId;
    const video = document.createElement("video");
    container.append(video);
    document.body.append(container);
    const statuses: VideoProcessingStatus[] = [];
    const transport: VideoTaskTransport = {
      start: vi.fn().mockResolvedValue({ taskId: "task-bound", status: "READY", audioUrl: "/audio/bound.wav" }),
      get: vi.fn(),
    };
    const coordinator = new VideoProcessingCoordinator(
      new AudioSourceResolver([new BoundAwemeSourceProvider(registry)]),
      transport,
      (status) => statuses.push(status),
    );

    coordinator.setActiveVideo(createActiveVideo(awemeId, "blob:https://www.douyin.com/source", null, video));
    coordinator.setEnabled(true);
    expect(statuses.at(-1)).toMatchObject({ state: "SOURCE_UNAVAILABLE" });

    container.dataset.e2e = "feed-active-video";
    coordinator.setActiveVideo(createActiveVideo(awemeId, "blob:https://www.douyin.com/source", awemeId, video));
    await flushPromises();

    expect(transport.start).toHaveBeenCalledTimes(1);
    expect(statuses.at(-1)).toMatchObject({ state: "READY", taskId: "task-bound" });

    delete container.dataset.e2e;
    coordinator.setActiveVideo(createActiveVideo(awemeId, "blob:https://www.douyin.com/source", null, video));
    expect(transport.start).toHaveBeenCalledTimes(1);
    expect(statuses.at(-1)).toMatchObject({ state: "SOURCE_UNAVAILABLE" });
  });

  it("tries the next captured CDN URL only after a retryable backend rejection", async () => {
    const awemeId = "7382738211234567890";
    const primaryUrl = "https://v1.douyinvod.com/video/primary.mp4";
    const backupUrl = "https://v2.douyinvod.com/video/backup.mp4";
    const registry = new CapturedAwemeSourceRegistry();
    registry.ingest(createMediaCaptureMessage([{ awemeId, urls: [primaryUrl, backupUrl] }]));
    const container = document.createElement("div");
    container.dataset.e2e = "feed-active-video";
    container.dataset.e2eVid = awemeId;
    const video = document.createElement("video");
    container.append(video);
    document.body.append(container);
    const statuses: VideoProcessingStatus[] = [];
    const start = vi
      .fn()
      .mockResolvedValueOnce({
        taskId: "task-primary",
        status: "ERROR",
        error: "Media server rejected the download (HTTP 403)",
      })
      .mockResolvedValueOnce({ taskId: "task-backup", status: "READY", audioUrl: "/audio/backup.wav" });
    const coordinator = new VideoProcessingCoordinator(
      new AudioSourceResolver([new BoundAwemeSourceProvider(registry)]),
      { start, get: vi.fn() },
      (status) => statuses.push(status),
    );

    coordinator.setActiveVideo(createActiveVideo(awemeId, "blob:https://www.douyin.com/source", awemeId, video));
    coordinator.setEnabled(true);
    await flushPromises();
    await flushPromises();

    expect(start).toHaveBeenNthCalledWith(1, { videoKey: awemeId, videoUrl: primaryUrl });
    expect(start).toHaveBeenNthCalledWith(2, { videoKey: awemeId, videoUrl: backupUrl });
    expect(statuses.at(-1)).toMatchObject({ state: "READY", taskId: "task-backup", sourceUrl: backupUrl });
  });

  it("does not try alternate URLs after a non-network safety rejection", async () => {
    const awemeId = "7382738211234567890";
    const registry = new CapturedAwemeSourceRegistry();
    registry.ingest(
      createMediaCaptureMessage([
        {
          awemeId,
          urls: [
            "https://v1.douyinvod.com/video/primary.mp4",
            "https://v2.douyinvod.com/video/backup.mp4",
          ],
        },
      ]),
    );
    const container = document.createElement("div");
    container.dataset.e2e = "feed-active-video";
    container.dataset.e2eVid = awemeId;
    const video = document.createElement("video");
    container.append(video);
    document.body.append(container);
    const statuses: VideoProcessingStatus[] = [];
    const start = vi.fn().mockResolvedValue({
      taskId: "task-manifest",
      status: "ERROR",
      error: "Streaming manifests are not supported",
    });
    const coordinator = new VideoProcessingCoordinator(
      new AudioSourceResolver([new BoundAwemeSourceProvider(registry)]),
      { start, get: vi.fn() },
      (status) => statuses.push(status),
    );

    coordinator.setActiveVideo(createActiveVideo(awemeId, "blob:https://www.douyin.com/source", awemeId, video));
    coordinator.setEnabled(true);
    await flushPromises();

    expect(start).toHaveBeenCalledTimes(1);
    expect(statuses.at(-1)).toMatchObject({ state: "ERROR", error: "Streaming manifests are not supported" });
  });
});
