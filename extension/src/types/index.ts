export type SubtitleMode = "bilingual" | "english" | "off";

export interface ExtensionSettings {
  enabled: boolean;
  subtitleMode: SubtitleMode;
  playbackRate: number;
  debug: boolean;
}

export type VideoStatus =
  | "NEW"
  | "FETCHING"
  | "TRANSCRIBING"
  | "TRANSLATING"
  | "SYNTHESIZING"
  | "READY"
  | "PLAYING"
  | "ERROR";

export interface ContentStatus {
  enabled: boolean;
  state:
    | "IDLE"
    | "DETECTING"
    | "PROCESSING"
    | "SUBTITLES_READY"
    | "DEGRADED"
    | "LEGACY_BACKEND"
    | "ERROR";
  message: string;
  videoKey?: string;
  debug?: {
    videoTime: number;
    playing: boolean;
    processingState?: import("./videoProcessing").VideoProcessingState;
    stage?: import("./videoProcessing").TaskStage;
    taskId?: string;
    progress?: number;
    transcriptCount: number;
    subtitleCount: number;
    taskReused?: boolean;
    asrCacheHit?: boolean | null;
    translationCacheHit?: boolean | null;
    backendError?: string;
  };
}

export type ExtensionMessage =
  | { type: "SETTINGS_UPDATED"; settings: ExtensionSettings }
  | { type: "GET_CONTENT_STATUS" }
  | { type: "RETRY_VIDEO_PROCESSING" }
  | { type: "CONTENT_STATUS_UPDATED"; status: ContentStatus };

export type {
  BackendTaskStatus,
  DubSegment,
  ProcessVideoInput,
  ProcessingStep,
  ProcessingStepStatus,
  ProcessingSteps,
  SubtitleSegment,
  TaskStage,
  TranscriptSegment,
  VideoProcessingRequest,
  VideoProcessingResponse,
  VideoProcessingState,
  VideoProcessingStatus,
  VideoTask,
} from "./videoProcessing";
