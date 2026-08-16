import { createLogger } from "../utils/logger";
import { VideoKeyFactory } from "./videoKey";
import { VideoObserver, type VideoCandidate } from "./videoObserver";

export interface ActiveVideo {
  element: HTMLVideoElement;
  videoKey: string;
  currentTime: number;
  playing: boolean;
}

export interface VisibilityViewport {
  width: number;
  height: number;
}

export type ActiveVideoChangeHandler = (current: ActiveVideo | null, previous: ActiveVideo | null) => void;

const logger = createLogger("VideoDetector");
const MIN_VISIBILITY_RATIO = 0.02;

export function getVisibleAreaRatio(
  element: Element,
  viewport: VisibilityViewport = { width: window.innerWidth, height: window.innerHeight },
): number {
  const rect = element.getBoundingClientRect();
  const totalArea = rect.width * rect.height;
  if (totalArea <= 0 || viewport.width <= 0 || viewport.height <= 0) return 0;

  const visibleWidth = Math.max(0, Math.min(rect.right, viewport.width) - Math.max(rect.left, 0));
  const visibleHeight = Math.max(0, Math.min(rect.bottom, viewport.height) - Math.max(rect.top, 0));
  return Math.min(1, (visibleWidth * visibleHeight) / totalArea);
}

export function getCandidateScore(candidate: VideoCandidate): number {
  const geometryRatio = getVisibleAreaRatio(candidate.element);
  const visibleRatio =
    candidate.intersectionRatio === null ? geometryRatio : Math.min(candidate.intersectionRatio, geometryRatio);
  if (visibleRatio < MIN_VISIBILITY_RATIO) return Number.NEGATIVE_INFINITY;
  const playingBonus = !candidate.element.paused && !candidate.element.ended ? 2 : 0;
  return playingBonus + visibleRatio;
}

export function selectActiveCandidate(candidates: VideoCandidate[]): VideoCandidate | null {
  let selected: VideoCandidate | null = null;
  let selectedScore = Number.NEGATIVE_INFINITY;

  for (const candidate of candidates) {
    const score = getCandidateScore(candidate);
    if (score > selectedScore) {
      selected = candidate;
      selectedScore = score;
    }
  }

  return Number.isFinite(selectedScore) ? selected : null;
}

export class VideoDetector {
  private readonly observer: VideoObserver;
  private readonly keyFactory = new VideoKeyFactory();
  private readonly listeners = new Set<ActiveVideoChangeHandler>();
  private active: ActiveVideo | null = null;
  private evaluationScheduled = false;
  private evaluationRevision = 0;

  constructor() {
    this.observer = new VideoObserver(() => this.scheduleEvaluation());
  }

  start(): void {
    this.observer.start();
    logger.info("Video detection started");
  }

  stop(): void {
    this.evaluationRevision += 1;
    this.observer.stop();
    this.setActive(null);
    logger.info("Video detection stopped");
  }

  onActiveVideoChanged(handler: ActiveVideoChangeHandler): () => void {
    this.listeners.add(handler);
    return () => this.listeners.delete(handler);
  }

  getActiveVideo(): ActiveVideo | null {
    if (!this.active) return null;
    return {
      ...this.active,
      currentTime: this.active.element.currentTime,
      playing: !this.active.element.paused && !this.active.element.ended,
    };
  }

  async evaluateNow(): Promise<void> {
    const revision = ++this.evaluationRevision;
    const candidate = selectActiveCandidate(this.observer.getCandidates());
    if (!candidate) {
      this.setActive(null);
      return;
    }

    const videoKey = await this.keyFactory.getKey(candidate.element);
    if (revision !== this.evaluationRevision || !candidate.element.isConnected) return;

    const next: ActiveVideo = {
      element: candidate.element,
      videoKey,
      currentTime: candidate.element.currentTime,
      playing: !candidate.element.paused && !candidate.element.ended,
    };
    if (this.active?.element === next.element && this.active.videoKey === next.videoKey) {
      this.active = next;
      return;
    }
    this.setActive(next);
  }

  private scheduleEvaluation(): void {
    if (this.evaluationScheduled) return;
    this.evaluationScheduled = true;
    queueMicrotask(() => {
      this.evaluationScheduled = false;
      void this.evaluateNow().catch((error: unknown) => logger.error("Failed to evaluate active video", error));
    });
  }

  private setActive(next: ActiveVideo | null): void {
    const previous = this.active;
    if (previous?.element === next?.element && previous?.videoKey === next?.videoKey) return;
    this.active = next;
    logger.info(`Active video changed: ${previous?.videoKey ?? "none"} -> ${next?.videoKey ?? "none"}`);
    this.listeners.forEach((listener) => listener(next, previous));
  }
}
