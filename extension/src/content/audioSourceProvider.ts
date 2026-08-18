import { createLogger } from "../utils/logger";
import { normalizeDouyinMediaUrl } from "../utils/mediaUrlPolicy";
import type { CapturedAwemeSourceRegistry } from "./capturedAwemeSources";
import { findActiveFeedAwemeId } from "./videoKey";

export interface ResolvedAudioSource {
  url: string;
  fallbackUrls?: readonly string[];
  provider: string;
  confidence: "direct" | "bound" | "heuristic";
}

export interface AudioSourceProvider {
  readonly id: string;
  resolve(video: HTMLVideoElement, videoKey?: string): ResolvedAudioSource | null;
}

export interface ResourceCandidate {
  name: string;
  initiatorType: string;
  startTime: number;
  responseEnd: number;
}

export interface AudioSourceResolution {
  source: ResolvedAudioSource | null;
  reason?: string;
}

type ResourceEntries = () => ResourceCandidate[];

const logger = createLogger("AudioSource");
const BLOCKED_RESOURCE_PATTERN = /\.(?:avif|bmp|css|gif|ico|jpe?g|js|json|map|png|svg|webp|woff2?|ttf)(?:$|[?#])/i;
const MEDIA_URL_PATTERN =
  /(?:\.(?:flv|m4a|mp3|mp4|mpeg|mov|webm)(?:$|[?#])|douyinvod|bytecdn|byteoversea|ibytedtos|tos-cn|mime_type=video|video_id=|playwm|\/video\/tos\/|\/obj\/tos-cn)/i;
const MEDIA_INITIATORS = new Set(["audio", "media", "video"]);
const DEFAULT_RESOURCE_WINDOW_MS = 1_500;

export function normalizeMediaSourceUrl(value: string | null | undefined): string | null {
  return normalizeDouyinMediaUrl(value, window.location.href);
}

function hasBlobSource(video: HTMLVideoElement): boolean {
  return [video.currentSrc, video.src].some((value) => value?.startsWith("blob:"));
}

function getResourceScore(candidate: ResourceCandidate): number | null {
  const url = normalizeMediaSourceUrl(candidate.name);
  if (!url || BLOCKED_RESOURCE_PATTERN.test(url)) return null;

  const hasMediaInitiator = MEDIA_INITIATORS.has(candidate.initiatorType.toLowerCase());
  const hasMediaUrlHint = MEDIA_URL_PATTERN.test(url);
  if (!hasMediaInitiator && !hasMediaUrlHint) return null;

  let score = 0;
  if (hasMediaInitiator) score += 100;
  if (hasMediaUrlHint) score += 60;
  if (candidate.initiatorType === "fetch" || candidate.initiatorType === "xmlhttprequest") score += 5;
  return score;
}

function defaultResourceEntries(): ResourceCandidate[] {
  return performance.getEntriesByType("resource").map((entry) => {
    const resource = entry as PerformanceResourceTiming;
    return {
      name: resource.name,
      initiatorType: resource.initiatorType ?? "",
      startTime: resource.startTime,
      responseEnd: resource.responseEnd,
    };
  });
}

export class DirectVideoSourceProvider implements AudioSourceProvider {
  readonly id = "video-element";

  resolve(video: HTMLVideoElement): ResolvedAudioSource | null {
    for (const value of [video.currentSrc, video.src]) {
      const url = normalizeMediaSourceUrl(value);
      if (url) return { url, provider: this.id, confidence: "direct" };
    }
    return null;
  }
}

export class BoundAwemeSourceProvider implements AudioSourceProvider {
  readonly id = "aweme-response";

  constructor(private readonly sources: CapturedAwemeSourceRegistry) {}

  resolve(video: HTMLVideoElement, videoKey?: string): ResolvedAudioSource | null {
    const awemeId = findActiveFeedAwemeId(video);
    if (!awemeId || videoKey !== awemeId) return null;
    const [url, ...fallbackUrls] = this.sources.getCandidates(awemeId);
    if (!url) return null;
    return {
      url,
      ...(fallbackUrls.length > 0 ? { fallbackUrls } : {}),
      provider: this.id,
      confidence: "bound",
    };
  }
}

export class PerformanceResourceSourceProvider implements AudioSourceProvider {
  readonly id = "performance-resource";

  constructor(
    private readonly getEntries: ResourceEntries = defaultResourceEntries,
    private readonly now: () => number = () => performance.now(),
    private readonly resourceWindowMs = DEFAULT_RESOURCE_WINDOW_MS,
  ) {}

  resolve(video: HTMLVideoElement): ResolvedAudioSource | null {
    if (!hasBlobSource(video)) return null;

    const now = this.now();
    const candidates = this.getEntries()
      .map((candidate) => ({ candidate, score: getResourceScore(candidate) }))
      .filter((entry): entry is { candidate: ResourceCandidate; score: number } => entry.score !== null)
      .filter(({ candidate }) => {
        const observedAt = Math.max(candidate.responseEnd, candidate.startTime);
        const age = now - observedAt;
        return age >= 0 && age <= this.resourceWindowMs;
      });

    // A global resource timeline cannot reliably associate two plausible media URLs
    // with one DOM video. Ambiguity is safer to report than to submit the wrong clip.
    if (candidates.length !== 1) return null;
    const url = normalizeMediaSourceUrl(candidates[0].candidate.name);
    return url ? { url, provider: this.id, confidence: "heuristic" } : null;
  }
}

export class AudioSourceResolver {
  constructor(
    // Resource Timing is tab-global and cannot prove that a resource belongs to
    // the active blob-backed video. Keep that adapter injectable for experiments,
    // but fail closed in production until a causal binding is available.
    private readonly providers: AudioSourceProvider[] = [new DirectVideoSourceProvider()],
  ) {}

  resolve(video: HTMLVideoElement, videoKey?: string): AudioSourceResolution {
    for (const provider of this.providers) {
      try {
        const source = provider.resolve(video, videoKey);
        if (source) {
          logger.info("Resolved active video source", {
            provider: source.provider,
            confidence: source.confidence,
          });
          return { source };
        }
      } catch (error) {
        logger.warn(`Source provider ${provider.id} failed`, error);
      }
    }

    const reason = hasBlobSource(video)
      ? "Blob video source could not be mapped to a network resource"
      : "Active video has no HTTP media source";
    logger.warn(reason);
    return { source: null, reason };
  }
}
