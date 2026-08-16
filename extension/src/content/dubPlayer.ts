import { createLogger } from "../utils/logger";

export interface DubPlayback {
  load(sourceUrl: string): void;
  play(videoTime: number, playbackRate: number): Promise<void>;
  pause(): void;
  seek(videoTime: number, force?: boolean): void;
  setPlaybackRate(playbackRate: number): void;
  stop(): void;
  getCurrentTime(): number;
  getDuration(): number;
}

type AudioFactory = (sourceUrl: string) => HTMLAudioElement;

const logger = createLogger("DubPlayer");
const SYNC_TOLERANCE_SECONDS = 0.35;

function clampPlaybackRate(value: number): number {
  return Math.min(4, Math.max(0.25, value));
}

export class DubPlayer implements DubPlayback {
  private audio: HTMLAudioElement | null = null;
  private pendingVideoTime: number | null = null;

  constructor(private readonly createAudio: AudioFactory = (sourceUrl) => new Audio(sourceUrl)) {}

  load(sourceUrl: string): void {
    this.stop();
    const audio = this.createAudio(sourceUrl);
    audio.preload = "auto";
    audio.loop = true;
    audio.addEventListener("loadedmetadata", this.handleLoadedMetadata);
    this.audio = audio;
    audio.load();
    logger.info("Mock dub loaded", { sourceUrl });
  }

  async play(videoTime: number, playbackRate: number): Promise<void> {
    if (!this.audio) throw new Error("Dub audio has not been loaded");
    this.setPlaybackRate(playbackRate);
    this.seek(videoTime, true);
    await this.audio.play();
    logger.info("Mock dub playback started");
  }

  pause(): void {
    this.audio?.pause();
  }

  seek(videoTime: number, force = false): void {
    if (!this.audio || !Number.isFinite(videoTime) || videoTime < 0) return;
    if (this.audio.readyState === HTMLMediaElement.HAVE_NOTHING) {
      this.pendingVideoTime = videoTime;
      return;
    }
    const duration = this.getDuration();
    const target = duration > 0 ? videoTime % duration : videoTime;
    if (force || Math.abs(this.audio.currentTime - target) > SYNC_TOLERANCE_SECONDS) {
      try {
        this.audio.currentTime = target;
        this.pendingVideoTime = null;
      } catch (error) {
        this.pendingVideoTime = videoTime;
        logger.warn("Mock dub seek deferred until metadata is ready", error);
      }
    }
  }

  setPlaybackRate(playbackRate: number): void {
    if (this.audio) this.audio.playbackRate = clampPlaybackRate(playbackRate);
  }

  stop(): void {
    const audio = this.audio;
    this.audio = null;
    this.pendingVideoTime = null;
    if (!audio) return;
    audio.removeEventListener("loadedmetadata", this.handleLoadedMetadata);
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
    logger.info("Mock dub playback stopped");
  }

  getCurrentTime(): number {
    return this.audio?.currentTime ?? 0;
  }

  getDuration(): number {
    const duration = this.audio?.duration ?? 0;
    return Number.isFinite(duration) ? duration : 0;
  }

  private readonly handleLoadedMetadata = (event: Event): void => {
    if (event.currentTarget !== this.audio || this.pendingVideoTime === null) return;
    const pendingVideoTime = this.pendingVideoTime;
    this.pendingVideoTime = null;
    this.seek(pendingVideoTime, true);
  };
}
