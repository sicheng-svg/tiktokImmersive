import { describe, expect, it, vi } from "vitest";
import { VideoTaskGateway } from "../src/background/videoTaskGateway";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function phase6Task(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    task_id: "task-phase-6",
    status: "PROCESSING",
    stage: "FETCHING",
    progress: 5,
    steps: {
      asr: { status: "PENDING", cache_hit: null },
      translation: { status: "PENDING", cache_hit: null },
    },
    transcript: [],
    subtitles: [],
    segments: [],
    audio_url: null,
    error: null,
    ...overrides,
  };
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

  it("recognizes a legacy READY response without exposing it as subtitles", async () => {
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
      legacyMediaReady: true,
    });
    expect(fetchMock.mock.calls[0][0]).toBe("http://127.0.0.1:8000/api/tasks/task%2Fa");
  });

  it("submits again after a legacy task reaches READY so a backend upgrade can take effect", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ task_id: "legacy-task", status: "PROCESSING", progress: 40 }, 202))
      .mockResolvedValueOnce(jsonResponse({ task_id: "legacy-task", status: "READY", progress: 100 }))
      .mockResolvedValueOnce(
        jsonResponse(
          phase6Task({ task_id: "phase-6-task", task_reused: false }),
          202,
        ),
      );
    const gateway = new VideoTaskGateway(fetchMock);
    const input = { videoKey: "upgrade-video", videoUrl: "https://media.example/upgrade.mp4" };

    await expect(gateway.start(input)).resolves.toMatchObject({ status: "PROCESSING" });
    await expect(gateway.get("legacy-task")).resolves.toMatchObject({
      status: "READY",
      legacyMediaReady: true,
    });
    const upgraded = await gateway.start(input);
    expect(upgraded).toMatchObject({
      taskId: "phase-6-task",
      taskReused: false,
    });
    expect(upgraded.legacyMediaReady).toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.map((call) => call[1]?.method)).toEqual(["POST", "GET", "POST"]);
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

  it("strictly maps a complete Phase 6 READY response", async () => {
    const transcript = [{ segment_id: "s000001", start: 0.25, end: 1.5, text: "你好" }];
    const subtitles = [{ segment_id: "s000001", start: 0.25, end: 1.5, zh: "你好", en: "Hello" }];
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(
        phase6Task({
          status: "READY",
          stage: "READY",
          progress: 100,
          steps: {
            asr: { status: "READY", cache_hit: true },
            translation: { status: "READY", cache_hit: false },
          },
          transcript,
          subtitles,
          audio_url: "/audio/source.wav",
        }),
      ),
    );
    const gateway = new VideoTaskGateway(fetchMock);

    await expect(gateway.get("task-phase-6")).resolves.toMatchObject({
      taskId: "task-phase-6",
      status: "READY",
      stage: "READY",
      progress: 100,
      steps: {
        asr: { status: "READY", cacheHit: true },
        translation: { status: "READY", cacheHit: false },
      },
      transcript: [{ segmentId: "s000001", start: 0.25, end: 1.5, text: "你好" }],
      subtitles: [{ segmentId: "s000001", start: 0.25, end: 1.5, zh: "你好", en: "Hello" }],
      segments: [],
      audioUrl: "http://127.0.0.1:8000/audio/source.wav",
    });
  });

  it("requires POST task_reused and keeps it distinct from local request deduplication", async () => {
    const response = phase6Task({ task_reused: false });
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(response, 202));
    const gateway = new VideoTaskGateway(fetchMock);
    const input = { videoKey: "phase-6", videoUrl: "https://media.example/phase-6.mp4" };

    const first = await gateway.start(input);
    const second = await gateway.start(input);

    expect(first.taskReused).toBe(false);
    expect(second.taskReused).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const missingFlag = new VideoTaskGateway(
      vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(phase6Task(), 202)),
    );
    await expect(missingFlag.start({ ...input, videoKey: "missing-flag" })).rejects.toThrow(
      "Backend returned an invalid task response",
    );
  });

  it("maps a translating task and a translation failure with the Chinese transcript intact", async () => {
    const transcript = [{ segment_id: "s000001", start: 0, end: 1, text: "中文" }];
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse(
          phase6Task({
            stage: "TRANSLATING",
            progress: 85,
            steps: {
              asr: { status: "READY", cache_hit: false },
              translation: { status: "PROCESSING", cache_hit: null },
            },
            transcript,
            audio_url: "/audio/task-phase-6/audio.wav",
          }),
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          phase6Task({
            status: "ERROR",
            stage: "TRANSLATING",
            progress: 85,
            steps: {
              asr: { status: "READY", cache_hit: false },
              translation: { status: "ERROR", cache_hit: false },
            },
            transcript,
            audio_url: "/audio/task-phase-6/audio.wav",
            error: "Translation provider unavailable",
          }),
        ),
      );
    const gateway = new VideoTaskGateway(fetchMock);

    await expect(gateway.get("first")).resolves.toMatchObject({
      status: "PROCESSING",
      stage: "TRANSLATING",
      transcript: [{ text: "中文" }],
    });
    await expect(gateway.get("second")).resolves.toMatchObject({
      status: "ERROR",
      stage: "TRANSLATING",
      transcript: [{ text: "中文" }],
      error: "Translation provider unavailable",
    });
  });

  it.each([
    ["partial Phase 6 fields", { task_id: "bad", status: "PROCESSING", stage: "FETCHING" }],
    ["nonempty Phase 6 dub segments", phase6Task({ segments: [{ start: 0, end: 1, zh: "中", en: "En", audio_url: "/a.wav" }] })],
    [
      "invalid TRANSCRIBING steps",
      phase6Task({
        stage: "TRANSCRIBING",
        steps: {
          asr: { status: "PENDING", cache_hit: null },
          translation: { status: "PENDING", cache_hit: null },
        },
      }),
    ],
    ["ERROR without a safe error", phase6Task({ status: "ERROR", stage: "FETCHING", steps: {
      asr: { status: "SKIPPED", cache_hit: null },
      translation: { status: "SKIPPED", cache_hit: null },
    } })],
    [
      "mismatched READY subtitles",
      phase6Task({
        status: "READY",
        stage: "READY",
        progress: 100,
        steps: {
          asr: { status: "READY", cache_hit: false },
          translation: { status: "READY", cache_hit: false },
        },
        transcript: [{ segment_id: "s000001", start: 0, end: 1, text: "中文" }],
        subtitles: [{ segment_id: "s000001", start: 0, end: 1, zh: "被修改", en: "English" }],
      }),
    ],
  ])("rejects %s", async (_label, payload) => {
    const gateway = new VideoTaskGateway(vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(payload)));
    await expect(gateway.get("bad")).rejects.toThrow("Backend returned an invalid task response");
  });
});
