export type BackendTaskStatus = "PROCESSING" | "READY" | "ERROR";

export type TaskStage = "FETCHING" | "EXTRACTING" | "TRANSCRIBING" | "TRANSLATING" | "READY";

export type ProcessingStepStatus = "PENDING" | "PROCESSING" | "READY" | "ERROR" | "SKIPPED";

export interface ProcessingStep {
  status: ProcessingStepStatus;
  cacheHit: boolean | null;
}

export interface ProcessingSteps {
  asr: ProcessingStep;
  translation: ProcessingStep;
}

export interface TranscriptSegment {
  segmentId: string;
  start: number;
  end: number;
  text: string;
}

export interface SubtitleSegment {
  segmentId: string;
  start: number;
  end: number;
  zh: string;
  en: string;
}

export interface DubSegment {
  start: number;
  end: number;
  zh: string;
  en: string;
  audioUrl: string;
}

export interface ProcessVideoInput {
  videoKey: string;
  videoUrl: string;
}

export interface VideoTask {
  taskId: string;
  status: BackendTaskStatus;
  progress?: number;
  audioUrl?: string;
  error?: string;
  stage?: TaskStage;
  steps?: ProcessingSteps;
  transcript?: TranscriptSegment[];
  subtitles?: SubtitleSegment[];
  segments?: DubSegment[];
  taskReused?: boolean;
  legacyMediaReady?: boolean;
}

export type VideoProcessingRequest =
  | { type: "PROCESS_VIDEO_SOURCE"; payload: ProcessVideoInput }
  | { type: "GET_VIDEO_TASK"; taskId: string };

export type VideoProcessingResponse =
  | { ok: true; task: VideoTask }
  | { ok: false; error: string };

export type VideoProcessingState =
  | "IDLE"
  | "SOURCE_UNAVAILABLE"
  | "SUBMITTING"
  | "PROCESSING"
  | "READY"
  | "DEGRADED"
  | "ERROR";

export interface VideoProcessingStatus {
  state: VideoProcessingState;
  message: string;
  videoKey?: string;
  sourceUrl?: string;
  sourceProvider?: string;
  sourceConfidence?: "direct" | "bound" | "heuristic";
  taskId?: string;
  progress?: number;
  audioUrl?: string;
  error?: string;
  stage?: TaskStage;
  steps?: ProcessingSteps;
  transcript?: TranscriptSegment[];
  subtitles?: SubtitleSegment[];
  segments?: DubSegment[];
  taskReused?: boolean;
  legacyMediaReady?: boolean;
}
