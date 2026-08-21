import type {
  ProcessVideoInput,
  TaskStage,
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
const DEFAULT_MAX_POLL_ATTEMPTS = 900;
const RETRYABLE_SOURCE_ERROR_PREFIXES = [
  "Media server rejected the download",
  "Media download failed",
  "Media download timed out",
  "Media host could not be resolved",
] as const;

const STAGE_MESSAGES: Record<TaskStage, string> = {
  FETCHING: "正在下载视频",
  EXTRACTING: "正在提取音频",
  TRANSCRIBING: "正在识别中文",
  TRANSLATING: "正在翻译英文",
  READY: "双语字幕就绪",
};

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
    this.emit({ state: "IDLE", message: "字幕处理已停止" });
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
        message: this.enabled ? "正在等待可处理的视频" : "智能字幕已关闭",
        videoKey: active?.videoKey,
      });
      return;
    }

    const resolution = this.resolver.resolve(active.element, active.videoKey);
    if (!resolution.source) {
      this.emit({
        state: "SOURCE_UNAVAILABLE",
        message: "暂时无法获取当前视频源",
        videoKey: active.videoKey,
        error: resolution.reason,
      });
      return;
    }

    this.submitSource(resolution.source, generation, active);
  }

  private submitSource(
    source: ResolvedAudioSource,
    generation: number,
    active: ActiveVideo,
    isFallback = false,
  ): void {
    if (!this.isCurrent(generation, active)) return;
    this.emit({
      state: "SUBMITTING",
      message: isFallback ? "正在尝试备用视频源" : "正在提交字幕任务",
      videoKey: active.videoKey,
      sourceUrl: source.url,
      sourceProvider: source.provider,
      sourceConfidence: source.confidence,
    });
    void this.transport
      .start({ videoKey: active.videoKey, videoUrl: source.url })
      .then((task) => this.handleTask(task, generation, active, source, 0, task.taskReused))
      .catch((error: unknown) => this.handleFailure(error, generation, active, source));
  }

  private handleTask(
    task: VideoTask,
    generation: number,
    active: ActiveVideo,
    source: ResolvedAudioSource,
    pollAttempt: number,
    initialTaskReused?: boolean,
  ): void {
    if (!this.isCurrent(generation, active)) return;
    const legacyMediaReady =
      task.legacyMediaReady === true ||
      (task.status === "READY" && task.stage === undefined && task.transcript === undefined && task.subtitles === undefined);
    const common = {
      videoKey: active.videoKey,
      sourceUrl: source.url,
      sourceProvider: source.provider,
      sourceConfidence: source.confidence,
      taskId: task.taskId,
      progress: task.progress,
      audioUrl: task.audioUrl,
      error: task.error,
      stage: task.stage,
      steps: task.steps,
      transcript: task.transcript,
      subtitles: task.subtitles,
      segments: task.segments,
      taskReused: task.taskReused ?? initialTaskReused,
      legacyMediaReady,
    };

    if (task.status === "READY") {
      if (legacyMediaReady) {
        logger.warn("Legacy backend response cannot provide subtitles", { taskId: task.taskId });
        this.emit({ state: "READY", message: "后端版本过旧，请升级后使用字幕", ...common });
        return;
      }
      logger.info("Bilingual subtitles are ready", {
        taskId: task.taskId,
        subtitleCount: task.subtitles?.length ?? 0,
      });
      this.emit({ state: "READY", message: "双语字幕就绪", ...common });
      return;
    }

    if (task.status === "ERROR") {
      if (task.stage === "TRANSLATING" && task.transcript?.length) {
        logger.warn("Translation failed; Chinese transcript remains available", { taskId: task.taskId });
        this.emit({ state: "DEGRADED", message: "翻译失败，已降级为中文字幕", ...common });
        return;
      }
      if (task.stage === "FETCHING" && this.tryNextSource(task.error, source, generation, active)) return;
      logger.error("Subtitle task failed", { taskId: task.taskId, stage: task.stage });
      this.emit({
        state: "ERROR",
        message: task.stage === "TRANSCRIBING" ? "中文识别失败，未显示字幕" : "字幕处理失败",
        ...common,
      });
      return;
    }

    if (pollAttempt >= this.maxPollAttempts) {
      this.emit({
        state: "ERROR",
        message: "字幕处理等待超时",
        ...common,
        error: "Task did not finish before the polling limit",
      });
      return;
    }

    this.emit({
      state: "PROCESSING",
      message: task.stage ? STAGE_MESSAGES[task.stage] : "旧版后端正在处理媒体",
      ...common,
    });
    this.pollTimer = this.scheduler.set(() => {
      this.pollTimer = null;
      void this.transport
        .get(task.taskId)
        .then((nextTask) =>
          this.handleTask(nextTask, generation, active, source, pollAttempt + 1, initialTaskReused ?? task.taskReused),
        )
        .catch((error: unknown) => this.handleFailure(error, generation, active, source, task.taskId));
    }, this.pollIntervalMs);
  }

  private handleFailure(
    error: unknown,
    generation: number,
    active: ActiveVideo,
    source: ResolvedAudioSource,
    taskId?: string,
  ): void {
    if (!this.isCurrent(generation, active)) return;
    const detail = error instanceof Error ? error.message : String(error);
    logger.error("Subtitle backend request failed", error);
    this.emit({
      state: "ERROR",
      message: "无法连接字幕后端",
      videoKey: active.videoKey,
      sourceUrl: source.url,
      sourceProvider: source.provider,
      sourceConfidence: source.confidence,
      taskId,
      error: detail,
    });
  }

  private isCurrent(generation: number, active: ActiveVideo): boolean {
    return generation === this.generation && this.enabled && hasSameActiveVideoIdentity(this.active, active);
  }

  private tryNextSource(
    error: string | undefined,
    source: ResolvedAudioSource,
    generation: number,
    active: ActiveVideo,
  ): boolean {
    if (!error || !RETRYABLE_SOURCE_ERROR_PREFIXES.some((prefix) => error.startsWith(prefix))) return false;
    const [nextUrl, ...remainingUrls] = source.fallbackUrls ?? [];
    if (!nextUrl) return false;
    logger.warn("Retrying alternate captured media source", {
      videoKey: active.videoKey,
      remaining: remainingUrls.length,
    });
    this.submitSource(
      {
        ...source,
        url: nextUrl,
        fallbackUrls: remainingUrls,
      },
      generation,
      active,
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
