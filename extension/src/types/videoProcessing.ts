export type BackendTaskStatus = "PROCESSING" | "READY" | "ERROR";

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
}
