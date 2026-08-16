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
  state: "IDLE" | "DETECTING" | "MOCK_READY" | "MOCK_PLAYING" | "ERROR";
  message: string;
  videoKey?: string;
  debug?: {
    videoUrl?: string;
    videoTime: number;
    dubTime: number;
    syncOffset: number;
  };
}

export type ExtensionMessage =
  | { type: "SETTINGS_UPDATED"; settings: ExtensionSettings }
  | { type: "GET_CONTENT_STATUS" }
  | { type: "CONTENT_STATUS_UPDATED"; status: ContentStatus };
