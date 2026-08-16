import type { ExtensionSettings } from "../types";
import { createLogger } from "../utils/logger";
import type { DubPlayback } from "./dubPlayer";
import type { ActiveVideo } from "./videoDetector";

export type MockPlaybackState = "IDLE" | "READY" | "PLAYING" | "ERROR";

export interface MockPlaybackStatus {
  state: MockPlaybackState;
  message: string;
  videoKey?: string;
  error?: string;
}

export interface PlaybackDebugSnapshot {
  videoKey?: string;
  videoUrl?: string;
  videoTime: number;
  dubTime: number;
  syncOffset: number;
  playing: boolean;
}

type StatusHandler = (status: MockPlaybackStatus) => void;

interface OriginalAudioState {
  muted: boolean;
  volume: number;
}

const logger = createLogger("AudioController");
const VIDEO_EVENTS: Array<keyof HTMLMediaElementEventMap> = [
  "play",
  "pause",
  "ended",
  "seeking",
  "seeked",
  "timeupdate",
  "ratechange",
  "volumechange",
  "emptied",
];

export class VideoAudioController {
  private active: ActiveVideo | null = null;
  private settings: ExtensionSettings;
  private originalAudioState: OriginalAudioState | null = null;
  private generation = 0;
  private dubLoaded = false;
  private failed = false;
  private starting = false;
  private playAttempt = 0;

  constructor(
    private readonly dub: DubPlayback,
    private readonly mockAudioUrl: string,
    initialSettings: ExtensionSettings,
    private readonly onStatus: StatusHandler,
  ) {
    this.settings = initialSettings;
  }

  setActiveVideo(next: ActiveVideo | null): void {
    if (this.active?.element === next?.element && this.active?.videoKey === next?.videoKey) return;
    this.releaseActiveVideo();
    this.active = next;
    this.failed = false;
    if (!next) {
      this.emit({ state: "IDLE", message: this.settings.enabled ? "Waiting for the active video" : "English Mode is off" });
      return;
    }

    this.addVideoListeners(next.element);
    logger.info("Attached active video", { videoKey: next.videoKey });
    if (this.settings.enabled) {
      this.activateCurrentVideo();
    } else {
      this.emit({ state: "IDLE", message: "English Mode is off", videoKey: next.videoKey });
    }
  }

  updateSettings(nextSettings: ExtensionSettings): void {
    const wasEnabled = this.settings.enabled;
    this.settings = nextSettings;
    if (!nextSettings.enabled) {
      this.deactivateCurrentVideo();
      return;
    }

    this.dub.setPlaybackRate(this.getCombinedPlaybackRate());
    if (!this.active) {
      this.emit({ state: "IDLE", message: "Waiting for the active video" });
      return;
    }
    if (!wasEnabled || this.failed) {
      this.failed = false;
      this.activateCurrentVideo();
    }
  }

  stop(): void {
    this.releaseActiveVideo();
    this.active = null;
  }

  getDebugSnapshot(): PlaybackDebugSnapshot {
    const video = this.active?.element;
    const videoTime = video?.currentTime ?? 0;
    const dubTime = this.dub.getCurrentTime();
    const dubDuration = this.dub.getDuration();
    const expectedDubTime = dubDuration > 0 ? videoTime % dubDuration : videoTime;
    return {
      videoKey: this.active?.videoKey,
      videoUrl: video?.currentSrc || video?.src || undefined,
      videoTime,
      dubTime,
      syncOffset: dubTime - expectedDubTime,
      playing: Boolean(video && !video.paused && !video.ended && this.settings.enabled && !this.failed),
    };
  }

  private activateCurrentVideo(): void {
    if (!this.active || !this.settings.enabled || this.failed) return;
    try {
      this.captureAndMute(this.active.element);
      this.ensureDubLoaded();
      this.dub.setPlaybackRate(this.getCombinedPlaybackRate());
      this.dub.seek(this.active.element.currentTime, true);
      this.emit({ state: "READY", message: "Mock English audio ready", videoKey: this.active.videoKey });
      if (!this.active.element.paused && !this.active.element.ended) void this.startPlayback();
    } catch (error) {
      this.failActiveVideo(error);
    }
  }

  private deactivateCurrentVideo(): void {
    this.generation += 1;
    this.cancelPendingPlayback();
    this.dub.stop();
    this.dubLoaded = false;
    this.restoreOriginalAudio();
    this.emit({ state: "IDLE", message: "English Mode is off", videoKey: this.active?.videoKey });
  }

  private releaseActiveVideo(): void {
    this.generation += 1;
    this.cancelPendingPlayback();
    const previous = this.active;
    if (previous) this.removeVideoListeners(previous.element);
    this.dub.stop();
    this.dubLoaded = false;
    this.restoreOriginalAudio();
    if (previous) logger.info("Released active video", { videoKey: previous.videoKey });
  }

  private ensureDubLoaded(): void {
    if (this.dubLoaded) return;
    this.dub.load(this.mockAudioUrl);
    this.dubLoaded = true;
  }

  private async startPlayback(): Promise<void> {
    if (!this.active || !this.settings.enabled || this.failed || this.starting) return;
    const generation = this.generation;
    const playAttempt = ++this.playAttempt;
    const video = this.active.element;
    const videoKey = this.active.videoKey;
    this.starting = true;
    try {
      this.captureAndMute(video);
      this.ensureDubLoaded();
      await this.dub.play(video.currentTime, this.getCombinedPlaybackRate());
      if (
        generation !== this.generation ||
        playAttempt !== this.playAttempt ||
        this.active?.element !== video ||
        !this.settings.enabled ||
        video.paused ||
        video.ended
      ) {
        return;
      }
      this.emit({ state: "PLAYING", message: "Playing mock English audio", videoKey });
    } catch (error) {
      if (
        generation === this.generation &&
        playAttempt === this.playAttempt &&
        this.active?.element === video &&
        !video.paused &&
        !video.ended
      ) {
        this.failActiveVideo(error);
      }
    } finally {
      if (generation === this.generation && playAttempt === this.playAttempt) this.starting = false;
    }
  }

  private failActiveVideo(error: unknown): void {
    this.failed = true;
    this.generation += 1;
    this.cancelPendingPlayback();
    this.dub.stop();
    this.dubLoaded = false;
    this.restoreOriginalAudio();
    const message = error instanceof Error ? error.message : String(error);
    logger.error("Mock dub unavailable; original audio restored", error);
    this.emit({ state: "ERROR", message: "English audio unavailable", videoKey: this.active?.videoKey, error: message });
  }

  private captureAndMute(video: HTMLVideoElement): void {
    if (!this.originalAudioState) {
      this.originalAudioState = { muted: video.muted, volume: video.volume };
    }
    video.muted = true;
  }

  private restoreOriginalAudio(): void {
    if (!this.active || !this.originalAudioState) return;
    this.active.element.volume = this.originalAudioState.volume;
    this.active.element.muted = this.originalAudioState.muted;
    this.originalAudioState = null;
  }

  private getCombinedPlaybackRate(): number {
    return this.settings.playbackRate * (this.active?.element.playbackRate ?? 1);
  }

  private readonly handleVideoEvent = (event: Event): void => {
    if (!this.active || event.currentTarget !== this.active.element) return;
    switch (event.type) {
      case "play":
        if (this.settings.enabled && !this.failed) void this.startPlayback();
        break;
      case "pause":
        this.cancelPendingPlayback();
        this.dub.pause();
        if (this.settings.enabled && !this.failed) {
          this.emit({ state: "READY", message: "Mock English audio paused", videoKey: this.active.videoKey });
        }
        break;
      case "ended":
        this.cancelPendingPlayback();
        this.dub.stop();
        this.dubLoaded = false;
        break;
      case "seeking":
      case "seeked":
        this.dub.seek(this.active.element.currentTime, true);
        break;
      case "timeupdate":
        this.dub.seek(this.active.element.currentTime);
        break;
      case "ratechange":
        this.dub.setPlaybackRate(this.getCombinedPlaybackRate());
        break;
      case "volumechange":
        if (this.settings.enabled && !this.failed && !this.active.element.muted) {
          this.active.element.muted = true;
        }
        break;
      case "emptied":
        this.cancelPendingPlayback();
        this.dub.stop();
        this.dubLoaded = false;
        break;
    }
  };

  private addVideoListeners(video: HTMLVideoElement): void {
    VIDEO_EVENTS.forEach((event) => video.addEventListener(event, this.handleVideoEvent));
  }

  private removeVideoListeners(video: HTMLVideoElement): void {
    VIDEO_EVENTS.forEach((event) => video.removeEventListener(event, this.handleVideoEvent));
  }

  private cancelPendingPlayback(): void {
    this.playAttempt += 1;
    this.starting = false;
  }

  private emit(status: MockPlaybackStatus): void {
    this.onStatus(status);
  }
}
