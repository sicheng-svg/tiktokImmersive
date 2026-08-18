import { describe, expect, it, vi } from "vitest";
import { VideoTaskGateway } from "../src/background/videoTaskGateway";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("VideoTaskGateway", () => {
  it("invokes fetch with the worker global as its receiver", async () => {
    const receivers: unknown[] = [];
    const fetchMock = new Proxy(
      vi.fn<typeof fetch>().mockResolvedValue(
        jsonResponse({ task_id: "task-worker", status: "PROCESSING", progress: 0 }, 202),
      ),
      {
        apply(target, thisArg, argumentsList) {
          receivers.push(thisArg);
          return Reflect.apply(target, thisArg, argumentsList);
        },
      },
    );
    const gateway = new VideoTaskGateway(fetchMock);

    await expect(
      gateway.start({ videoKey: "video-worker", videoUrl: "https://media.example/worker.mp4" }),
    ).resolves.toMatchObject({ taskId: "task-worker" });
    expect(receivers).toEqual([globalThis]);
  });

  it("deduplicates concurrent submissions for the same videoKey", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({ task_id: "task-1", status: "PROCESSING", progress: 0 }, 202),
    );
    const gateway = new VideoTaskGateway(fetchMock);

    const first = gateway.start({ videoKey: "video-1", videoUrl: "https://media.example/one.mp4" });
    const second = gateway.start({ videoKey: "video-1", videoUrl: "https://media.example/one.mp4" });

    await expect(first).resolves.toMatchObject({ taskId: "task-1", status: "PROCESSING" });
    await expect(second).resolves.toMatchObject({ taskId: "task-1" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      video_key: "video-1",
      video_url: "https://media.example/one.mp4",
    });
  });

  it("maps READY audio_url and error fields without requiring segments", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({ task_id: "task/a", status: "READY", progress: 100, audio_url: "/audio/task.wav" }),
    );
    const gateway = new VideoTaskGateway(fetchMock);

    await expect(gateway.get("task/a")).resolves.toEqual({
      taskId: "task/a",
      status: "READY",
      progress: 100,
      audioUrl: "http://127.0.0.1:8000/audio/task.wav",
      error: undefined,
    });
    expect(fetchMock.mock.calls[0][0]).toBe("http://127.0.0.1:8000/api/tasks/task%2Fa");
  });

  it("allows a retry after a failed submission", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ detail: "temporary failure" }, 503))
      .mockResolvedValueOnce(jsonResponse({ task_id: "task-2", status: "PROCESSING" }, 202));
    const gateway = new VideoTaskGateway(fetchMock);
    const input = { videoKey: "video-2", videoUrl: "https://media.example/two.mp4" };

    await expect(gateway.start(input)).rejects.toThrow("temporary failure");
    await expect(gateway.start(input)).resolves.toMatchObject({ taskId: "task-2" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("submits again when a recycled videoKey points to a new source URL", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ task_id: "task-old", status: "PROCESSING" }, 202))
      .mockResolvedValueOnce(jsonResponse({ task_id: "task-new", status: "PROCESSING" }, 202));
    const gateway = new VideoTaskGateway(fetchMock);

    await gateway.start({ videoKey: "video-3", videoUrl: "https://media.example/old.mp4" });
    await expect(
      gateway.start({ videoKey: "video-3", videoUrl: "https://media.example/new.mp4" }),
    ).resolves.toMatchObject({ taskId: "task-new" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("allows the same source to retry after a backend ERROR task", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ task_id: "task-error", status: "ERROR", error: "ffmpeg failed" }, 202))
      .mockResolvedValueOnce(jsonResponse({ task_id: "task-retry", status: "PROCESSING" }, 202));
    const gateway = new VideoTaskGateway(fetchMock);
    const input = { videoKey: "video-4", videoUrl: "https://media.example/retry.mp4" };

    await expect(gateway.start(input)).resolves.toMatchObject({ status: "ERROR", error: "ffmpeg failed" });
    await expect(gateway.start(input)).resolves.toMatchObject({ taskId: "task-retry", status: "PROCESSING" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
