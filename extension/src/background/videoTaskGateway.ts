import type { BackendTaskStatus, ProcessVideoInput, VideoTask } from "../types/videoProcessing";
import { createLogger } from "../utils/logger";

interface BackendTaskPayload {
  task_id?: unknown;
  status?: unknown;
  progress?: unknown;
  audio_url?: unknown;
  error?: unknown;
  detail?: unknown;
}

interface Submission {
  videoUrl: string;
  pending?: Promise<VideoTask>;
  task?: VideoTask;
}

type FetchImplementation = typeof fetch;

const logger = createLogger("VideoTaskGateway");
const TASK_STATUSES = new Set<BackendTaskStatus>(["PROCESSING", "READY", "ERROR"]);
export const BACKEND_BASE_URL = "http://127.0.0.1:8000";

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function resolveAudioUrl(value: unknown, baseUrl: string): string | undefined {
  const audioUrl = readOptionalString(value);
  if (!audioUrl) return undefined;
  try {
    const resolved = new URL(audioUrl, `${baseUrl}/`);
    return resolved.protocol === "http:" || resolved.protocol === "https:" ? resolved.href : undefined;
  } catch {
    return undefined;
  }
}

function parseTask(payload: BackendTaskPayload, baseUrl: string): VideoTask {
  if (typeof payload.task_id !== "string" || !TASK_STATUSES.has(payload.status as BackendTaskStatus)) {
    throw new Error("Backend returned an invalid task response");
  }
  return {
    taskId: payload.task_id,
    status: payload.status as BackendTaskStatus,
    progress: typeof payload.progress === "number" ? payload.progress : undefined,
    audioUrl: resolveAudioUrl(payload.audio_url, baseUrl),
    error: readOptionalString(payload.error),
  };
}

async function readPayload(response: Response): Promise<BackendTaskPayload> {
  try {
    return (await response.json()) as BackendTaskPayload;
  } catch {
    throw new Error(`Backend returned a non-JSON response (${response.status})`);
  }
}

export class VideoTaskGateway {
  private readonly submissions = new Map<string, Submission>();
  private readonly taskOwners = new Map<string, string>();

  constructor(
    private readonly fetchImplementation: FetchImplementation = fetch,
    private readonly baseUrl = BACKEND_BASE_URL,
    private readonly timeoutMs = 15_000,
  ) {}

  start(input: ProcessVideoInput): Promise<VideoTask> {
    const existing = this.submissions.get(input.videoKey);
    if (existing?.videoUrl === input.videoUrl) {
      if (existing.pending) return existing.pending;
      if (existing.task?.status !== "ERROR" && existing.task) return Promise.resolve(existing.task);
    }

    const submission: Submission = { videoUrl: input.videoUrl };
    const pending = this.request("/api/videos/process", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ video_key: input.videoKey, video_url: input.videoUrl }),
    })
      .then((task) => {
        if (this.submissions.get(input.videoKey) === submission) {
          submission.pending = undefined;
          submission.task = task;
          this.taskOwners.set(task.taskId, input.videoKey);
        }
        return task;
      })
      .catch((error: unknown) => {
        if (this.submissions.get(input.videoKey) === submission) this.submissions.delete(input.videoKey);
        throw error;
      });
    submission.pending = pending;
    this.submissions.set(input.videoKey, submission);
    return pending;
  }

  async get(taskId: string): Promise<VideoTask> {
    const task = await this.request(`/api/tasks/${encodeURIComponent(taskId)}`, { method: "GET" });
    const videoKey = this.taskOwners.get(taskId);
    const submission = videoKey ? this.submissions.get(videoKey) : undefined;
    if (submission?.task?.taskId === taskId) submission.task = task;
    return task;
  }

  private async request(path: string, init: RequestInit): Promise<VideoTask> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImplementation.call(globalThis, `${this.baseUrl}${path}`, {
        ...init,
        signal: controller.signal,
      });
      const payload = await readPayload(response);
      if (!response.ok) {
        const detail = readOptionalString(payload.detail) ?? readOptionalString(payload.error);
        throw new Error(detail ?? `Backend request failed (${response.status})`);
      }
      return parseTask(payload, this.baseUrl);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new Error("Backend request timed out");
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}
