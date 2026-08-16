import { describe, expect, it, vi } from "vitest";
import { AudioSourceResolver, DirectVideoSourceProvider } from "../src/content/audioSourceProvider";
import type { ActiveVideo } from "../src/content/videoDetector";
import {
  VideoProcessingCoordinator,
  type VideoTaskTransport,
} from "../src/content/videoProcessingCoordinator";
import type { VideoProcessingStatus, VideoTask } from "../src/types/videoProcessing";

function createActiveVideo(videoKey: string, sourceUrl: string): ActiveVideo {
  const element = document.createElement("video");
  Object.defineProperty(element, "currentSrc", { configurable: true, value: sourceUrl });
  return { element, videoKey, currentTime: 0, playing: false };
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

    coordinator.setActiveVideo(createActiveVideo("video-1", "https://media.example/one.mp4"));
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

    coordinator.setActiveVideo(createActiveVideo("A", "https://media.example/a.mp4"));
    coordinator.setEnabled(true);
    coordinator.setActiveVideo(createActiveVideo("B", "https://media.example/b.mp4"));
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
    const active = createActiveVideo("A", "https://media.example/a.mp4");
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

    coordinator.setActiveVideo(createActiveVideo("A", "https://media.example/a.mp4"));
    coordinator.setEnabled(true);
    await flushPromises();
    expect(statuses.at(-1)).toMatchObject({ state: "ERROR" });

    coordinator.retry();
    await flushPromises();

    expect(transport.start).toHaveBeenCalledTimes(2);
    expect(statuses.at(-1)).toMatchObject({ state: "READY", taskId: "task-retry" });
  });
});
