export interface VideoCandidate {
  element: HTMLVideoElement;
  intersectionRatio: number | null;
}

type CandidateChangeHandler = () => void;

const VIDEO_EVENTS: Array<keyof HTMLMediaElementEventMap> = [
  "play",
  "pause",
  "ended",
  "loadedmetadata",
  "durationchange",
  "emptied",
  "abort",
];

export class VideoObserver {
  private readonly videos = new Set<HTMLVideoElement>();
  private readonly ratios = new WeakMap<HTMLVideoElement, number>();
  private readonly intersectionObserver: IntersectionObserver;
  private readonly mutationObserver: MutationObserver;
  private started = false;

  constructor(private readonly onCandidatesChanged: CandidateChangeHandler) {
    this.intersectionObserver = new IntersectionObserver(this.handleIntersections, {
      threshold: [0, 0.05, 0.25, 0.5, 0.75, 1],
    });
    this.mutationObserver = new MutationObserver(this.handleMutations);
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    document.querySelectorAll<HTMLVideoElement>("video").forEach((video) => this.track(video));
    this.mutationObserver.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-e2e", "data-e2e-vid"],
    });
    window.addEventListener("scroll", this.onViewportChanged, { passive: true });
    window.addEventListener("resize", this.onViewportChanged);
    this.onCandidatesChanged();
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.mutationObserver.disconnect();
    this.intersectionObserver.disconnect();
    window.removeEventListener("scroll", this.onViewportChanged);
    window.removeEventListener("resize", this.onViewportChanged);
    this.videos.forEach((video) => this.removeMediaListeners(video));
    this.videos.clear();
  }

  getCandidates(): VideoCandidate[] {
    for (const video of this.videos) {
      if (!video.isConnected) this.untrack(video);
    }
    return Array.from(this.videos, (element) => ({
      element,
      intersectionRatio: this.ratios.get(element) ?? null,
    }));
  }

  private readonly handleIntersections: IntersectionObserverCallback = (entries) => {
    for (const entry of entries) {
      if (entry.target instanceof HTMLVideoElement) {
        this.ratios.set(entry.target, entry.isIntersecting ? entry.intersectionRatio : 0);
      }
    }
    this.onCandidatesChanged();
  };

  private readonly handleMutations: MutationCallback = (mutations) => {
    for (const mutation of mutations) {
      mutation.addedNodes.forEach((node) => this.scanNode(node, (video) => this.track(video)));
      mutation.removedNodes.forEach((node) =>
        this.scanNode(node, (video) => {
          queueMicrotask(() => {
            if (!video.isConnected) {
              this.untrack(video);
              this.onCandidatesChanged();
            }
          });
        }),
      );
    }
    this.onCandidatesChanged();
  };

  private readonly onViewportChanged = (): void => {
    this.onCandidatesChanged();
  };

  private readonly onMediaEvent = (): void => {
    this.onCandidatesChanged();
  };

  private scanNode(node: Node, callback: (video: HTMLVideoElement) => void): void {
    if (!(node instanceof Element)) return;
    if (node instanceof HTMLVideoElement) callback(node);
    node.querySelectorAll<HTMLVideoElement>("video").forEach(callback);
  }

  private track(video: HTMLVideoElement): void {
    if (this.videos.has(video)) return;
    this.videos.add(video);
    this.intersectionObserver.observe(video);
    VIDEO_EVENTS.forEach((event) => video.addEventListener(event, this.onMediaEvent));
  }

  private untrack(video: HTMLVideoElement): void {
    if (!this.videos.delete(video)) return;
    this.intersectionObserver.unobserve(video);
    this.removeMediaListeners(video);
  }

  private removeMediaListeners(video: HTMLVideoElement): void {
    VIDEO_EVENTS.forEach((event) => video.removeEventListener(event, this.onMediaEvent));
  }
}
