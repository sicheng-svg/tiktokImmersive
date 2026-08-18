import type {
  ProcessVideoInput,
  VideoProcessingRequest,
  VideoProcessingResponse,
  VideoProcessingStatus,
  VideoTask,
} from "../types/videoProcessing";
import { createLogger } from "../utils/logger";
import { AudioSourceResolver, type ResolvedAudioSource } from "./audioSourceProvider";
import { hasSameActiveVideoIdentity, type ActiveVideo } from "./videoDetector";

export interface VideoTaskTransport {
  start(input: ProcessVideoInput): Promise<VideoTask>;
  get(taskId: string): Promise<VideoTask>;
}

interface PollScheduler {
  set(callback: () => void, delayMs: number): number;
  clear(handle: number): void;
}

type ProcessingStatusHandler = (status: VideoProcessingStatus) => void;

const logger = createLogger("ProcessingCoordinator");
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_MAX_POLL_ATTEMPTS = 300;
const RETRYABLE_SOURCE_ERROR_PREFIXES = [
  "Media server rejected the download",
  "Media download failed",
  "Media download timed out",
  "Media host could not be resolved",
] as const;

function getResponseTask(response: unknown): VideoTask {
  const result = response as VideoProcessingResponse | undefined;
  if (!result || typeof result !== "object" || !("ok" in result)) {
    throw new Error("Extension background did not return a response");
  }
  if (!result.ok) throw new Error(result.error);
  return result.task;
}

export class ChromeVideoTaskTransport implements VideoTaskTransport {
  async start(input: ProcessVideoInput): Promise<VideoTask> {
    const request: VideoProcessingRequest = { type: "PROCESS_VIDEO_SOURCE", payload: input };
    return getResponseTask(await chrome.runtime.sendMessage(request));
  }

  async get(taskId: string): Promise<VideoTask> {
    const request: VideoProcessingRequest = { type: "GET_VIDEO_TASK", taskId };
    return getResponseTask(await chrome.runtime.sendMessage(request));
  }
}

export class VideoProcessingCoordinator {
  private active: ActiveVideo | null = null;
  private observedVideo: HTMLVideoElement | null = null;
  private enabled = false;
  private generation = 0;
  private pollTimer: number | null = null;

  constructor(
    private readonly resolver: AudioSourceResolver,
    private readonly transport: VideoTaskTransport,
    private readonly onStatus: ProcessingStatusHandler,
    private readonly pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    private readonly maxPollAttempts = DEFAULT_MAX_POLL_ATTEMPTS,
    private readonly scheduler: PollScheduler = {
      set: (callback, delayMs) => window.setTimeout(callback, delayMs),
      clear: (handle) => window.clearTimeout(handle),
    },
  ) {}

  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    this.restart();
  }

  setActiveVideo(next: ActiveVideo | null): void {
    const sameVideo = hasSameActiveVideoIdentity(this.active, next);
    this.observeSourceChanges(next?.element ?? null);
    this.active = next;
    if (sameVideo) return;
    this.restart();
  }

  stop(): void {
    this.observeSourceChanges(null);
    this.active = null;
    this.enabled = false;
    this.cancelPendingWork();
    this.emit({ state: "IDLE", message: "Media extraction stopped" });
  }

  retry(): void {
    if (this.enabled) this.restart();
  }

  private restart(): void {
    this.cancelPendingWork();
    const generation = this.generation;
    const active = this.active;
    if (!this.enabled || !active) {
      this.emit({
        state: "IDLE",
        message: this.enabled ? "Waiting for a video source" : "Media extraction is off",
        videoKey: active?.videoKey,
      });
      return;
    }

    const resolution = this.resolver.resolve(active.element, active.videoKey);
    if (!resolution.source) {
      this.emit({
        state: "SOURCE_UNAVAILABLE",
        message: "Video source unavailable; mock playback is unchanged",
        videoKey: active.videoKey,
        error: resolution.reason,
      });
      return;
    }

    this.submitSource(resolution.source, generation, active.videoKey);
  }

  private submitSource(
    source: ResolvedAudioSource,
    generation: number,
    videoKey: string,
    isFallback = false,
  ): void {
    if (!this.isCurrent(generation, videoKey)) return;
    this.emit({
      state: "SUBMITTING",
      message:
        isFallback
          ? "Retrying an alternate media source"
          : source.confidence === "heuristic"
            ? "Submitting heuristic media source"
            : source.confidence === "bound"
              ? "Submitting aweme-bound media source"
              : "Submitting video source",
      videoKey,
      sourceUrl: source.url,
      sourceProvider: source.provider,
      sourceConfidence: source.confidence,
    });
    void this.transport
      .start({ videoKey, videoUrl: source.url })
      .then((task) => this.handleTask(task, generation, videoKey, source, 0))
      .catch((error: unknown) => this.handleFailure(error, generation, videoKey, source));
  }

  private handleTask(
    task: VideoTask,
    generation: number,
    videoKey: string,
    source: ResolvedAudioSource,
    pollAttempt: number,
  ): void {
    if (!this.isCurrent(generation, videoKey)) return;
    const common = {
      videoKey,
      sourceUrl: source.url,
      sourceProvider: source.provider,
      sourceConfidence: source.confidence,
      taskId: task.taskId,
      progress: task.progress,
      audioUrl: task.audioUrl,
      error: task.error,
    };

    if (task.status === "READY") {
      logger.info("Extracted audio is ready", { taskId: task.taskId, audioUrl: task.audioUrl });
      this.emit({ state: "READY", message: "Media extraction ready (not played in Phase 5)", ...common });
      return;
    }
    if (task.status === "ERROR") {
      if (this.tryNextSource(task.error, source, generation, videoKey)) return;
      logger.error("Media extraction task failed", task.error);
      this.emit({ state: "ERROR", message: "Media extraction failed; mock playback is unchanged", ...common });
      return;
    }
    if (pollAttempt >= this.maxPollAttempts) {
      this.emit({
        state: "ERROR",
        message: "Media extraction polling timed out; mock playback is unchanged",
        ...common,
        error: "Task did not finish before the polling limit",
      });
      return;
    }

    this.emit({ state: "PROCESSING", message: "Backend is extracting the media audio", ...common });
    this.pollTimer = this.scheduler.set(() => {
      this.pollTimer = null;
      void this.transport
        .get(task.taskId)
        .then((nextTask) => this.handleTask(nextTask, generation, videoKey, source, pollAttempt + 1))
        .catch((error: unknown) => this.handleFailure(error, generation, videoKey, source, task.taskId));
    }, this.pollIntervalMs);
  }

  private handleFailure(
    error: unknown,
    generation: number,
    videoKey: string,
    source: ResolvedAudioSource,
    taskId?: string,
  ): void {
    if (!this.isCurrent(generation, videoKey)) return;
    const detail = error instanceof Error ? error.message : String(error);
    logger.error("Media extraction request failed", error);
    this.emit({
      state: "ERROR",
      message: "Backend unavailable; mock playback is unchanged",
      videoKey,
      sourceUrl: source.url,
      sourceProvider: source.provider,
      sourceConfidence: source.confidence,
      taskId,
      error: detail,
    });
  }

  private isCurrent(generation: number, videoKey: string): boolean {
    return generation === this.generation && this.enabled && this.active?.videoKey === videoKey;
  }

  private tryNextSource(
    error: string | undefined,
    source: ResolvedAudioSource,
    generation: number,
    videoKey: string,
  ): boolean {
    if (!error || !RETRYABLE_SOURCE_ERROR_PREFIXES.some((prefix) => error.startsWith(prefix))) return false;
    const [nextUrl, ...remainingUrls] = source.fallbackUrls ?? [];
    if (!nextUrl) return false;
    logger.warn("Retrying alternate captured media source", { videoKey, remaining: remainingUrls.length });
    this.submitSource(
      {
        ...source,
        url: nextUrl,
        fallbackUrls: remainingUrls,
      },
      generation,
      videoKey,
      true,
    );
    return true;
  }

  private cancelPendingWork(): void {
    this.generation += 1;
    if (this.pollTimer !== null) {
      this.scheduler.clear(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private observeSourceChanges(video: HTMLVideoElement | null): void {
    if (this.observedVideo === video) return;
    this.observedVideo?.removeEventListener("loadedmetadata", this.handleSourceChange);
    this.observedVideo?.removeEventListener("emptied", this.handleSourceChange);
    this.observedVideo = video;
    video?.addEventListener("loadedmetadata", this.handleSourceChange);
    video?.addEventListener("emptied", this.handleSourceChange);
  }

  private readonly handleSourceChange = (event: Event): void => {
    if (event.currentTarget !== this.active?.element || !this.enabled) return;
    this.restart();
  };

  private emit(status: VideoProcessingStatus): void {
    this.onStatus(status);
  }
}
