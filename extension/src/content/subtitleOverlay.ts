import type { SubtitleMode } from "../types";
import type { SubtitleSegment, TranscriptSegment } from "../types/videoProcessing";
import { hasSameActiveVideoIdentity, type ActiveVideo } from "./videoDetector";

type OverlayCue = {
  start: number;
  end: number;
  zh: string;
  en?: string;
};

type VideoWithFrameCallbacks = HTMLVideoElement & {
  requestVideoFrameCallback?: (callback: (now: number, metadata: unknown) => void) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

const VIDEO_EVENTS = [
  "play",
  "pause",
  "seeking",
  "seeked",
  "timeupdate",
  "ended",
  "emptied",
  "loadedmetadata",
] as const;
const FALLBACK_REFRESH_MS = 200;

export class SubtitleOverlay {
  private active: ActiveVideo | null = null;
  private mode: SubtitleMode = "off";
  private cues: OverlayCue[] = [];
  private fallbackTranscript = false;
  private host: HTMLDivElement | null = null;
  private panel: HTMLDivElement | null = null;
  private primaryLine: HTMLDivElement | null = null;
  private secondaryLine: HTMLDivElement | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private frameHandle: number | null = null;
  private timerHandle: number | null = null;
  private clockGeneration = 0;
  private nativeTrack: TextTrack | null = null;
  private nativeTrackVideo: HTMLVideoElement | null = null;

  setActiveVideo(next: ActiveVideo | null): void {
    if (hasSameActiveVideoIdentity(this.active, next)) return;
    this.detachVideo();
    this.active = next;
    this.cues = [];
    this.fallbackTranscript = false;
    this.hidePanel();
    if (!next) {
      return;
    }
    this.attachVideo(next.element);
    this.mountForFullscreen();
    this.updatePosition();
    this.render();
    this.syncClock();
  }

  setMode(mode: SubtitleMode): void {
    if (this.mode === mode) return;
    this.mode = mode;
    this.refreshNativeTrack();
    this.render();
    this.syncClock();
  }

  showSubtitles(subtitles: readonly SubtitleSegment[]): void {
    this.fallbackTranscript = false;
    this.cues = subtitles
      .map((segment) => ({ start: segment.start, end: segment.end, zh: segment.zh, en: segment.en }))
      .filter(isValidCue)
      .sort(compareCues);
    this.refreshNativeTrack();
    this.render();
    this.syncClock();
  }

  showTranscript(transcript: readonly TranscriptSegment[]): void {
    this.fallbackTranscript = true;
    this.cues = transcript
      .map((segment) => ({ start: segment.start, end: segment.end, zh: segment.text }))
      .filter(isValidCue)
      .sort(compareCues);
    this.refreshNativeTrack();
    this.render();
    this.syncClock();
  }

  clearCues(): void {
    this.cues = [];
    this.fallbackTranscript = false;
    this.refreshNativeTrack();
    this.hidePanel();
    this.stopClock();
  }

  stop(): void {
    this.detachVideo();
    this.active = null;
    this.cues = [];
    this.fallbackTranscript = false;
    this.hidePanel();
    this.host?.remove();
  }

  private attachVideo(video: HTMLVideoElement): void {
    VIDEO_EVENTS.forEach((eventName) => video.addEventListener(eventName, this.handleVideoEvent));
    window.addEventListener("resize", this.handleLayoutChange);
    window.addEventListener("scroll", this.handleLayoutChange, true);
    document.addEventListener("fullscreenchange", this.handleFullscreenChange);
    if (typeof ResizeObserver === "function") {
      this.resizeObserver = new ResizeObserver(this.handleLayoutChange);
      this.resizeObserver.observe(video);
    }
  }

  private detachVideo(): void {
    this.stopClock();
    this.releaseNativeTrack();
    const video = this.active?.element;
    if (video) {
      VIDEO_EVENTS.forEach((eventName) => video.removeEventListener(eventName, this.handleVideoEvent));
    }
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    window.removeEventListener("resize", this.handleLayoutChange);
    window.removeEventListener("scroll", this.handleLayoutChange, true);
    document.removeEventListener("fullscreenchange", this.handleFullscreenChange);
  }

  private startClock(): void {
    const video = this.active?.element as VideoWithFrameCallbacks | undefined;
    if (!video || this.frameHandle !== null || this.timerHandle !== null) return;
    const generation = this.clockGeneration;
    if (typeof video.requestVideoFrameCallback === "function") {
      const tick = (): void => {
        if (generation !== this.clockGeneration || video !== this.active?.element) return;
        this.render();
        this.frameHandle = video.requestVideoFrameCallback?.(tick) ?? null;
      };
      this.frameHandle = video.requestVideoFrameCallback(tick);
      return;
    }
    this.timerHandle = window.setInterval(() => this.render(), FALLBACK_REFRESH_MS);
  }

  private stopClock(): void {
    this.clockGeneration += 1;
    const video = this.active?.element as VideoWithFrameCallbacks | undefined;
    if (this.frameHandle !== null) video?.cancelVideoFrameCallback?.(this.frameHandle);
    this.frameHandle = null;
    if (this.timerHandle !== null) window.clearInterval(this.timerHandle);
    this.timerHandle = null;
  }

  private syncClock(): void {
    const shouldRun =
      this.active !== null &&
      this.mode !== "off" &&
      this.cues.length > 0 &&
      !this.isNativeVideoFullscreen();
    if (!shouldRun) {
      this.stopClock();
      return;
    }
    this.startClock();
  }

  private readonly handleVideoEvent = (event: Event): void => {
    if (event.type === "emptied") {
      this.clearCues();
      return;
    }
    this.updatePosition();
    this.render();
  };

  private readonly handleLayoutChange = (): void => {
    this.render();
  };

  private readonly handleFullscreenChange = (): void => {
    this.mountForFullscreen();
    this.updatePosition();
    this.render();
    this.syncClock();
  };

  private ensureElements(): void {
    if (this.host) return;
    const host = document.createElement("div");
    host.id = "douyin-english-subtitle-overlay";
    Object.assign(host.style, {
      position: "fixed",
      inset: "0",
      zIndex: "2147483646",
      pointerEvents: "none",
      contain: "layout style",
    });

    const shadow = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = `
      :host { all: initial; }
      .panel {
        position: fixed;
        display: none;
        box-sizing: border-box;
        padding: 10px 16px;
        border-radius: 10px;
        color: #fff;
        background: rgba(0, 0, 0, 0.72);
        box-shadow: 0 3px 14px rgba(0, 0, 0, 0.25);
        text-align: center;
        text-shadow: 0 1px 3px rgba(0, 0, 0, 0.95);
        transform: translate(-50%, -100%);
        pointer-events: none;
        overflow-wrap: anywhere;
        font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      .primary { font-size: clamp(18px, 2.2vw, 30px); font-weight: 650; line-height: 1.28; }
      .secondary { margin-top: 4px; font-size: clamp(14px, 1.55vw, 21px); line-height: 1.3; color: #f2f2f2; }
      .secondary:empty { display: none; }
      .panel.fallback .primary { font-size: clamp(17px, 2vw, 27px); }
    `;
    const panel = document.createElement("div");
    panel.className = "panel";
    panel.setAttribute("role", "status");
    panel.setAttribute("aria-live", "off");
    const primaryLine = document.createElement("div");
    primaryLine.className = "primary";
    const secondaryLine = document.createElement("div");
    secondaryLine.className = "secondary";
    panel.append(primaryLine, secondaryLine);
    shadow.append(style, panel);
    document.documentElement.append(host);
    this.host = host;
    this.panel = panel;
    this.primaryLine = primaryLine;
    this.secondaryLine = secondaryLine;
  }

  private mountForFullscreen(): void {
    this.ensureElements();
    if (!this.host) return;
    const video = this.active?.element;
    const fullscreen = document.fullscreenElement;
    const target = video && fullscreen && fullscreen !== video && fullscreen.contains(video)
      ? fullscreen
      : document.documentElement;
    if (this.host.parentElement !== target) target.append(this.host);
    this.refreshNativeTrack();
  }

  private isNativeVideoFullscreen(): boolean {
    return this.active?.element === document.fullscreenElement;
  }

  private refreshNativeTrack(): void {
    const video = this.active?.element;
    const shouldShow =
      video !== undefined &&
      this.isNativeVideoFullscreen() &&
      this.mode !== "off" &&
      this.cues.length > 0 &&
      !(this.mode === "english" && this.fallbackTranscript);
    if (!video || !shouldShow) {
      this.disableNativeTrack();
      return;
    }

    const CueConstructor = globalThis.VTTCue;
    if (typeof CueConstructor !== "function" || typeof video.addTextTrack !== "function") {
      this.disableNativeTrack();
      return;
    }
    if (this.nativeTrackVideo !== video || !this.nativeTrack) {
      this.releaseNativeTrack();
      try {
        this.nativeTrack = video.addTextTrack("subtitles", "Douyin bilingual subtitles", "en");
        this.nativeTrackVideo = video;
      } catch {
        this.nativeTrack = null;
        this.nativeTrackVideo = null;
        return;
      }
    }

    const track = this.nativeTrack;
    this.clearNativeCues(track);
    track.mode = "hidden";
    try {
      buildNativeIntervals(this.cues).forEach((interval, index) => {
        const text = this.getNativeCueText(interval.cue);
        if (!text) return;
        const cue = new CueConstructor(interval.start, interval.end, text);
        cue.id = `douyin-english-${index}`;
        track.addCue(cue);
      });
      track.mode = "showing";
    } catch {
      this.clearNativeCues(track);
      track.mode = "disabled";
    }
  }

  private getNativeCueText(cue: OverlayCue): string {
    const zh = escapeWebVttText(cue.zh);
    const en = cue.en ? escapeWebVttText(cue.en) : "";
    if (this.fallbackTranscript) return this.mode === "bilingual" ? zh : "";
    if (this.mode === "english") return en;
    return en ? `${en}\n${zh}` : zh;
  }

  private clearNativeCues(track = this.nativeTrack): void {
    if (!track?.cues) return;
    for (const cue of Array.from(track.cues)) {
      try {
        track.removeCue(cue);
      } catch {
        // A browser may remove cues itself while replacing the media source.
      }
    }
  }

  private disableNativeTrack(): void {
    if (!this.nativeTrack) return;
    this.clearNativeCues(this.nativeTrack);
    this.nativeTrack.mode = "disabled";
  }

  private releaseNativeTrack(): void {
    this.disableNativeTrack();
    this.nativeTrack = null;
    this.nativeTrackVideo = null;
  }

  private updatePosition(): boolean {
    this.ensureElements();
    const video = this.active?.element;
    if (!video || !this.panel) return false;
    const rect = video.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0 || rect.bottom <= 0 || rect.top >= window.innerHeight) {
      this.hidePanel();
      return false;
    }
    const visibleLeft = Math.max(0, rect.left);
    const visibleRight = Math.min(window.innerWidth, rect.right);
    const visibleWidth = Math.max(0, visibleRight - visibleLeft);
    const bottomInset = Math.max(20, Math.min(84, rect.height * 0.12));
    this.panel.style.left = `${visibleLeft + visibleWidth / 2}px`;
    this.panel.style.top = `${Math.min(window.innerHeight - 8, rect.bottom - bottomInset)}px`;
    this.panel.style.width = `${Math.max(0, Math.min(visibleWidth - 24, 960))}px`;
    return visibleWidth > 24;
  }

  private render(): void {
    this.ensureElements();
    const video = this.active?.element;
    if (this.isNativeVideoFullscreen()) {
      this.hidePanel();
      return;
    }
    if (!video || this.mode === "off" || this.cues.length === 0) {
      this.hidePanel();
      return;
    }
    const cue = findActiveCue(this.cues, video.currentTime);
    if (!cue || (this.mode === "english" && this.fallbackTranscript)) {
      this.hidePanel();
      return;
    }
    if (!this.panel || !this.primaryLine || !this.secondaryLine) return;
    this.panel.classList.toggle("fallback", this.fallbackTranscript);
    if (this.fallbackTranscript) {
      this.primaryLine.textContent = cue.zh;
      this.secondaryLine.textContent = "";
    } else {
      this.primaryLine.textContent = cue.en ?? "";
      this.secondaryLine.textContent = this.mode === "bilingual" ? cue.zh : "";
    }
    if (!this.updatePosition()) {
      this.hidePanel();
      return;
    }
    this.panel.style.display = "block";
  }

  private hidePanel(): void {
    if (!this.panel) return;
    this.panel.style.display = "none";
    if (this.primaryLine) this.primaryLine.textContent = "";
    if (this.secondaryLine) this.secondaryLine.textContent = "";
  }
}

function escapeWebVttText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

type NativeCueInterval = {
  start: number;
  end: number;
  cue: OverlayCue;
};

function buildNativeIntervals(cues: readonly OverlayCue[]): NativeCueInterval[] {
  const boundaries = [...new Set(cues.flatMap((cue) => [cue.start, cue.end]))].sort((left, right) => left - right);
  const ends = cues
    .map((cue, index) => ({ end: cue.end, index }))
    .sort((left, right) => left.end - right.end || left.index - right.index);
  const active = new Array<boolean>(cues.length).fill(false);
  const heap: number[] = [];
  const intervals: NativeCueInterval[] = [];
  let nextStart = 0;
  let nextEnd = 0;

  for (let boundaryIndex = 0; boundaryIndex < boundaries.length - 1; boundaryIndex += 1) {
    const start = boundaries[boundaryIndex];
    const end = boundaries[boundaryIndex + 1];
    while (nextEnd < ends.length && ends[nextEnd].end <= start) {
      active[ends[nextEnd].index] = false;
      nextEnd += 1;
    }
    while (nextStart < cues.length && cues[nextStart].start <= start) {
      active[nextStart] = true;
      pushMaxHeap(heap, nextStart);
      nextStart += 1;
    }
    while (heap.length > 0 && !active[heap[0]]) popMaxHeap(heap);
    const cue = cues[heap[0]];
    if (!cue || end <= start) continue;
    const previous = intervals.at(-1);
    if (previous?.cue === cue && previous.end === start) previous.end = end;
    else intervals.push({ start, end, cue });
  }
  return intervals;
}

function pushMaxHeap(heap: number[], value: number): void {
  heap.push(value);
  let index = heap.length - 1;
  while (index > 0) {
    const parent = (index - 1) >>> 1;
    if (heap[parent] >= value) break;
    heap[index] = heap[parent];
    index = parent;
  }
  heap[index] = value;
}

function popMaxHeap(heap: number[]): number | undefined {
  if (heap.length === 0) return undefined;
  const result = heap[0];
  const last = heap.pop();
  if (heap.length === 0 || last === undefined) return result;
  let index = 0;
  while (true) {
    const left = index * 2 + 1;
    if (left >= heap.length) break;
    const right = left + 1;
    const child = right < heap.length && heap[right] > heap[left] ? right : left;
    if (heap[child] <= last) break;
    heap[index] = heap[child];
    index = child;
  }
  heap[index] = last;
  return result;
}

function isValidCue(cue: OverlayCue): boolean {
  return (
    Number.isFinite(cue.start) &&
    Number.isFinite(cue.end) &&
    cue.start >= 0 &&
    cue.end > cue.start &&
    cue.zh.length > 0 &&
    (cue.en === undefined || cue.en.length > 0)
  );
}

function compareCues(left: OverlayCue, right: OverlayCue): number {
  return left.start - right.start || left.end - right.end;
}

export function findActiveCue<T extends Pick<OverlayCue, "start" | "end">>(
  cues: readonly T[],
  currentTime: number,
): T | undefined {
  if (!Number.isFinite(currentTime)) return undefined;
  let low = 0;
  let high = cues.length - 1;
  let candidate = -1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    if (cues[middle].start <= currentTime) {
      candidate = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  for (let index = candidate; index >= 0; index -= 1) {
    const cue = cues[index];
    if (currentTime >= cue.start && currentTime < cue.end) return cue;
  }
  return undefined;
}
