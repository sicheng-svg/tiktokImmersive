import type {
  BackendTaskStatus,
  DubSegment,
  ProcessVideoInput,
  ProcessingStep,
  ProcessingStepStatus,
  ProcessingSteps,
  SubtitleSegment,
  TaskStage,
  TranscriptSegment,
  VideoTask,
} from "../types/videoProcessing";

interface BackendTaskPayload {
  task_id?: unknown;
  status?: unknown;
  stage?: unknown;
  progress?: unknown;
  steps?: unknown;
  transcript?: unknown;
  subtitles?: unknown;
  segments?: unknown;
  audio_url?: unknown;
  error?: unknown;
  task_reused?: unknown;
  detail?: unknown;
}

interface Submission {
  videoUrl: string;
  pending?: Promise<VideoTask>;
  task?: VideoTask;
}

type FetchImplementation = typeof fetch;
type EndpointKind = "process" | "task";

const TASK_STATUSES = new Set<BackendTaskStatus>(["PROCESSING", "READY", "ERROR"]);
const TASK_STAGES = new Set<TaskStage>([
  "FETCHING",
  "EXTRACTING",
  "TRANSCRIBING",
  "TRANSLATING",
  "READY",
]);
const STEP_STATUSES = new Set<ProcessingStepStatus>([
  "PENDING",
  "PROCESSING",
  "READY",
  "ERROR",
  "SKIPPED",
]);
const NEW_RESPONSE_FIELDS = ["stage", "steps", "transcript", "subtitles"] as const;
const MAX_SEGMENTS = 5_000;
const MAX_TRANSCRIPT_CHARACTERS = 500_000;
const MAX_TRANSLATION_CHARACTERS = 1_000_000;
const SEGMENT_ID_PATTERN = /^s\d{6}$/;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;
const INVALID_RESPONSE_ERROR = "Backend returned an invalid task response";

export const BACKEND_BASE_URL = "http://127.0.0.1:8000";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(payload: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(payload, key);
}

function invalidResponse(): never {
  throw new Error(INVALID_RESPONSE_ERROR);
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readNullableString(payload: BackendTaskPayload, key: "audio_url" | "error"): string | null {
  if (!hasOwn(payload, key) || (payload[key] !== null && typeof payload[key] !== "string")) {
    return invalidResponse();
  }
  return payload[key] as string | null;
}

function readText(value: unknown, maxCharacters: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxCharacters ||
    value.trim().length === 0 ||
    CONTROL_CHARACTER_PATTERN.test(value)
  ) {
    return invalidResponse();
  }
  return value;
}

function readTime(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return invalidResponse();
  return value;
}

function readSegmentId(value: unknown): string {
  if (typeof value !== "string" || !SEGMENT_ID_PATTERN.test(value)) return invalidResponse();
  return value;
}

function resolveAudioUrl(value: string | null, baseUrl: string): string | undefined {
  if (value === null) return undefined;
  if (value.length === 0) return invalidResponse();
  try {
    const resolved = new URL(value, `${baseUrl}/`);
    if (resolved.protocol !== "http:" && resolved.protocol !== "https:") return invalidResponse();
    return resolved.href;
  } catch {
    return invalidResponse();
  }
}

function parseStep(value: unknown): ProcessingStep {
  if (!isRecord(value) || !STEP_STATUSES.has(value.status as ProcessingStepStatus)) return invalidResponse();
  if (value.cache_hit !== null && typeof value.cache_hit !== "boolean") return invalidResponse();
  return {
    status: value.status as ProcessingStepStatus,
    cacheHit: value.cache_hit,
  };
}

function parseSteps(value: unknown): ProcessingSteps {
  if (!isRecord(value) || !hasOwn(value, "asr") || !hasOwn(value, "translation")) return invalidResponse();
  return {
    asr: parseStep(value.asr),
    translation: parseStep(value.translation),
  };
}

function parseTranscript(value: unknown): TranscriptSegment[] {
  if (!Array.isArray(value) || value.length > MAX_SEGMENTS) return invalidResponse();
  const result: TranscriptSegment[] = [];
  const ids = new Set<string>();
  let totalCharacters = 0;
  let previousStart = -1;
  let previousEnd = 0;
  for (const [index, item] of value.entries()) {
    if (!isRecord(item)) return invalidResponse();
    const segmentId = readSegmentId(item.segment_id);
    const start = readTime(item.start);
    const end = readTime(item.end);
    const text = readText(item.text, 4_096);
    if (
      segmentId !== `s${String(index + 1).padStart(6, "0")}` ||
      end <= start ||
      start < previousStart ||
      start < previousEnd - 0.25 ||
      ids.has(segmentId)
    ) {
      return invalidResponse();
    }
    totalCharacters += text.length;
    if (totalCharacters > MAX_TRANSCRIPT_CHARACTERS) return invalidResponse();
    ids.add(segmentId);
    previousStart = start;
    previousEnd = end;
    result.push({ segmentId, start, end, text });
  }
  return result;
}

function parseSubtitles(value: unknown): SubtitleSegment[] {
  if (!Array.isArray(value) || value.length > MAX_SEGMENTS) return invalidResponse();
  const result: SubtitleSegment[] = [];
  const ids = new Set<string>();
  let totalZhCharacters = 0;
  let totalEnCharacters = 0;
  let previousStart = -1;
  let previousEnd = 0;
  for (const [index, item] of value.entries()) {
    if (!isRecord(item)) return invalidResponse();
    const segmentId = readSegmentId(item.segment_id);
    const start = readTime(item.start);
    const end = readTime(item.end);
    const zh = readText(item.zh, 4_096);
    const en = readText(item.en, 8_192);
    if (
      segmentId !== `s${String(index + 1).padStart(6, "0")}` ||
      end <= start ||
      start < previousStart ||
      start < previousEnd - 0.25 ||
      ids.has(segmentId)
    ) {
      return invalidResponse();
    }
    totalZhCharacters += zh.length;
    totalEnCharacters += en.length;
    if (
      totalZhCharacters > MAX_TRANSCRIPT_CHARACTERS ||
      totalEnCharacters > MAX_TRANSLATION_CHARACTERS
    ) {
      return invalidResponse();
    }
    ids.add(segmentId);
    previousStart = start;
    previousEnd = end;
    result.push({ segmentId, start, end, zh, en });
  }
  return result;
}

function parseDubSegments(value: unknown, baseUrl: string): DubSegment[] {
  if (!Array.isArray(value) || value.length > MAX_SEGMENTS) return invalidResponse();
  return value.map((item) => {
    if (!isRecord(item)) return invalidResponse();
    const start = readTime(item.start);
    const end = readTime(item.end);
    const audioUrl = resolveAudioUrl(readText(item.audio_url, 8_192), baseUrl);
    if (end <= start || !audioUrl) return invalidResponse();
    return {
      start,
      end,
      zh: readText(item.zh, 4_096),
      en: readText(item.en, 8_192),
      audioUrl,
    };
  });
}

function assertTranscriptSubtitlePairing(
  transcript: TranscriptSegment[],
  subtitles: SubtitleSegment[],
): void {
  if (transcript.length !== subtitles.length) return invalidResponse();
  transcript.forEach((segment, index) => {
    const subtitle = subtitles[index];
    if (
      !subtitle ||
      subtitle.segmentId !== segment.segmentId ||
      subtitle.start !== segment.start ||
      subtitle.end !== segment.end ||
      subtitle.zh !== segment.text
    ) {
      invalidResponse();
    }
  });
}

function assertTaskInvariants(task: VideoTask): void {
  const { status, stage, steps, transcript = [], subtitles = [] } = task;
  if (!stage || !steps) return invalidResponse();
  if ((task.segments?.length ?? 0) !== 0) return invalidResponse();

  const isPending = (step: ProcessingStep): boolean => step.status === "PENDING" && step.cacheHit === null;
  const isProcessing = (step: ProcessingStep): boolean => step.status === "PROCESSING" && step.cacheHit === null;
  const isReady = (step: ProcessingStep): boolean => step.status === "READY" && typeof step.cacheHit === "boolean";
  const isSkipped = (step: ProcessingStep): boolean => step.status === "SKIPPED" && step.cacheHit === null;
  const isError = (step: ProcessingStep): boolean =>
    step.status === "ERROR" && (step.cacheHit === null || step.cacheHit === false);

  if (status === "READY") {
    if (
      stage !== "READY" ||
      task.progress !== 100 ||
      task.audioUrl === undefined ||
      task.error !== undefined ||
      transcript.length === 0 ||
      subtitles.length === 0 ||
      !isReady(steps.asr) ||
      !isReady(steps.translation)
    ) {
      return invalidResponse();
    }
    assertTranscriptSubtitlePairing(transcript, subtitles);
    return;
  }

  if (status === "ERROR") {
    if (!task.error || task.progress === undefined || task.progress >= 100) return invalidResponse();
    if (stage === "FETCHING" || stage === "EXTRACTING") {
      if (
        task.audioUrl !== undefined ||
        transcript.length !== 0 ||
        subtitles.length !== 0 ||
        !isSkipped(steps.asr) ||
        !isSkipped(steps.translation)
      ) {
        return invalidResponse();
      }
      return;
    }
    if (stage === "TRANSCRIBING") {
      if (
        transcript.length !== 0 ||
        subtitles.length !== 0 ||
        task.audioUrl === undefined ||
        !isError(steps.asr) ||
        !isSkipped(steps.translation)
      ) {
        return invalidResponse();
      }
      return;
    }
    if (stage === "TRANSLATING") {
      if (
        transcript.length === 0 ||
        subtitles.length !== 0 ||
        task.audioUrl === undefined ||
        !isReady(steps.asr) ||
        !isError(steps.translation)
      ) {
        return invalidResponse();
      }
      return;
    }
    return invalidResponse();
  }

  if (task.error !== undefined || task.progress === undefined || task.progress >= 100 || stage === "READY") {
    return invalidResponse();
  }
  if (stage === "FETCHING" || stage === "EXTRACTING") {
    if (
      task.audioUrl !== undefined ||
      transcript.length !== 0 ||
      subtitles.length !== 0 ||
      !isPending(steps.asr) ||
      !isPending(steps.translation)
    ) {
      return invalidResponse();
    }
    return;
  }
  if (stage === "TRANSCRIBING") {
    if (
      task.audioUrl === undefined ||
      transcript.length !== 0 ||
      subtitles.length !== 0 ||
      !isProcessing(steps.asr) ||
      !isPending(steps.translation)
    ) {
      return invalidResponse();
    }
    return;
  }
  if (stage === "TRANSLATING") {
    if (
      transcript.length === 0 ||
      subtitles.length !== 0 ||
      task.audioUrl === undefined ||
      !isReady(steps.asr) ||
      !isProcessing(steps.translation)
    ) {
      return invalidResponse();
    }
    return;
  }
  return invalidResponse();
}

function parseLegacyTask(payload: BackendTaskPayload, baseUrl: string): VideoTask {
  if (
    typeof payload.task_id !== "string" ||
    payload.task_id.length === 0 ||
    !TASK_STATUSES.has(payload.status as BackendTaskStatus)
  ) {
    return invalidResponse();
  }
  const audioUrl =
    payload.audio_url === undefined || payload.audio_url === null
      ? undefined
      : typeof payload.audio_url === "string"
        ? resolveAudioUrl(payload.audio_url, baseUrl)
        : invalidResponse();
  if (payload.progress !== undefined && (typeof payload.progress !== "number" || !Number.isFinite(payload.progress))) {
    return invalidResponse();
  }
  if (payload.error !== undefined && payload.error !== null && typeof payload.error !== "string") {
    return invalidResponse();
  }
  return {
    taskId: payload.task_id,
    status: payload.status as BackendTaskStatus,
    progress: payload.progress as number | undefined,
    audioUrl,
    error: readOptionalString(payload.error),
    legacyMediaReady: payload.status === "READY",
  };
}

function parseTask(payload: BackendTaskPayload, baseUrl: string, endpoint: EndpointKind): VideoTask {
  if (!isRecord(payload)) return invalidResponse();
  const presentNewFields = NEW_RESPONSE_FIELDS.filter((field) => hasOwn(payload, field));
  if (presentNewFields.length === 0) return parseLegacyTask(payload, baseUrl);
  if (presentNewFields.length !== NEW_RESPONSE_FIELDS.length) return invalidResponse();
  if (
    typeof payload.task_id !== "string" ||
    payload.task_id.length === 0 ||
    !TASK_STATUSES.has(payload.status as BackendTaskStatus) ||
    !TASK_STAGES.has(payload.stage as TaskStage) ||
    typeof payload.progress !== "number" ||
    !Number.isInteger(payload.progress) ||
    payload.progress < 0 ||
    payload.progress > 100 ||
    !hasOwn(payload, "segments")
  ) {
    return invalidResponse();
  }
  if (endpoint === "process" && typeof payload.task_reused !== "boolean") return invalidResponse();
  if (endpoint === "task" && hasOwn(payload, "task_reused")) return invalidResponse();

  const transcript = parseTranscript(payload.transcript);
  const subtitles = parseSubtitles(payload.subtitles);
  const errorValue = readNullableString(payload, "error");
  const task: VideoTask = {
    taskId: payload.task_id,
    status: payload.status as BackendTaskStatus,
    stage: payload.stage as TaskStage,
    progress: payload.progress,
    steps: parseSteps(payload.steps),
    transcript,
    subtitles,
    segments: parseDubSegments(payload.segments, baseUrl),
    audioUrl: resolveAudioUrl(readNullableString(payload, "audio_url"), baseUrl),
    error: errorValue === null ? undefined : readText(errorValue, 256),
    taskReused: endpoint === "process" ? (payload.task_reused as boolean) : undefined,
  };
  assertTaskInvariants(task);
  return task;
}

async function readPayload(response: Response): Promise<BackendTaskPayload> {
  try {
    const payload: unknown = await response.json();
    if (!isRecord(payload)) return invalidResponse();
    return payload as BackendTaskPayload;
  } catch (error) {
    if (error instanceof Error && error.message === INVALID_RESPONSE_ERROR) throw error;
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
      if (existing.task?.status !== "ERROR" && !existing.task?.legacyMediaReady && existing.task) {
        return Promise.resolve(existing.task);
      }
    }

    const submission: Submission = { videoUrl: input.videoUrl };
    const pending = this.request(
      "/api/videos/process",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ video_key: input.videoKey, video_url: input.videoUrl }),
      },
      "process",
    )
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
    const task = await this.request(`/api/tasks/${encodeURIComponent(taskId)}`, { method: "GET" }, "task");
    const videoKey = this.taskOwners.get(taskId);
    const submission = videoKey ? this.submissions.get(videoKey) : undefined;
    if (submission?.task?.taskId === taskId) {
      submission.task = { ...task, taskReused: submission.task.taskReused };
    }
    return task;
  }

  private async request(path: string, init: RequestInit, endpoint: EndpointKind): Promise<VideoTask> {
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
      return parseTask(payload, this.baseUrl, endpoint);
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
