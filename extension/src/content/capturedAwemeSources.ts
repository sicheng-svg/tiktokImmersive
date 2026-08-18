import {
  MAX_CAPTURED_MAPPINGS,
  MAX_CAPTURED_URLS_PER_AWEME,
  MEDIA_CAPTURE_MESSAGE_SOURCE,
  MEDIA_CAPTURE_MESSAGE_TYPE,
  MEDIA_CAPTURE_MESSAGE_VERSION,
  type MediaCaptureMessage,
} from "../shared/awemeMediaCapture";
import { normalizeDouyinMediaUrl } from "../utils/mediaUrlPolicy";

const GLOBAL_REGISTRY_KEY = "__douyinEnglishCapturedAwemeSourcesV1__";
const AWEME_ID_PATTERN = /^\d{8,32}$/;
const DEFAULT_TTL_MS = 10 * 60 * 1_000;

interface CapturedSource {
  urls: readonly string[];
  observedAt: number;
}

type SourceUpdateListener = (awemeIds: ReadonlySet<string>) => void;

export class CapturedAwemeSourceRegistry {
  private readonly sources = new Map<string, CapturedSource>();
  private readonly listeners = new Set<SourceUpdateListener>();

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly ttlMs = DEFAULT_TTL_MS,
    private readonly maxEntries = MAX_CAPTURED_MAPPINGS,
  ) {}

  ingest(value: unknown): ReadonlySet<string> {
    const message = value as Partial<MediaCaptureMessage> | null;
    if (
      !message ||
      message.source !== MEDIA_CAPTURE_MESSAGE_SOURCE ||
      message.type !== MEDIA_CAPTURE_MESSAGE_TYPE ||
      message.version !== MEDIA_CAPTURE_MESSAGE_VERSION ||
      !Array.isArray(message.mappings) ||
      message.mappings.length > MAX_CAPTURED_MAPPINGS
    ) {
      return new Set();
    }

    this.evictExpired();
    const updated = new Set<string>();
    for (const mapping of message.mappings) {
      if (
        !mapping ||
        typeof mapping.awemeId !== "string" ||
        !AWEME_ID_PATTERN.test(mapping.awemeId) ||
        !Array.isArray(mapping.urls) ||
        mapping.urls.length === 0 ||
        mapping.urls.length > MAX_CAPTURED_URLS_PER_AWEME
      ) {
        continue;
      }

      const urls: string[] = [];
      for (const candidate of mapping.urls) {
        if (typeof candidate !== "string" || candidate.length > 8_192) continue;
        const url = normalizeDouyinMediaUrl(candidate);
        if (url && !urls.includes(url)) urls.push(url);
      }
      if (urls.length === 0) continue;

      const existing = this.sources.get(mapping.awemeId);
      if (existing && sameUrls(existing.urls, urls)) {
        existing.observedAt = this.now();
        continue;
      }
      this.sources.set(mapping.awemeId, { urls, observedAt: this.now() });
      updated.add(mapping.awemeId);
    }
    this.evictOverflow();
    if (updated.size > 0) this.listeners.forEach((listener) => listener(updated));
    return updated;
  }

  get(awemeId: string): string | null {
    return this.getCandidates(awemeId)[0] ?? null;
  }

  getCandidates(awemeId: string): readonly string[] {
    this.evictExpired();
    return [...(this.sources.get(awemeId)?.urls ?? [])];
  }

  subscribe(listener: SourceUpdateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private evictExpired(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [awemeId, source] of this.sources) {
      if (source.observedAt < cutoff) this.sources.delete(awemeId);
    }
  }

  private evictOverflow(): void {
    while (this.sources.size > this.maxEntries) {
      let oldestAwemeId: string | null = null;
      let oldestObservedAt = Number.POSITIVE_INFINITY;
      for (const [awemeId, source] of this.sources) {
        if (source.observedAt < oldestObservedAt) {
          oldestAwemeId = awemeId;
          oldestObservedAt = source.observedAt;
        }
      }
      if (!oldestAwemeId) break;
      this.sources.delete(oldestAwemeId);
    }
  }
}

function sameUrls(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

interface RegistryGlobal {
  registry: CapturedAwemeSourceRegistry;
  installed: boolean;
}

function getRegistryGlobal(): RegistryGlobal {
  const shared = globalThis as typeof globalThis & { [GLOBAL_REGISTRY_KEY]?: RegistryGlobal };
  shared[GLOBAL_REGISTRY_KEY] ??= { registry: new CapturedAwemeSourceRegistry(), installed: false };
  return shared[GLOBAL_REGISTRY_KEY];
}

export function installCapturedAwemeSourceBridge(): void {
  const state = getRegistryGlobal();
  if (state.installed) return;
  state.installed = true;
  window.addEventListener("message", (event: MessageEvent<unknown>) => {
    if (event.source !== window || event.origin !== window.location.origin) return;
    state.registry.ingest(event.data);
  });
}

export function getCapturedAwemeSourceRegistry(): CapturedAwemeSourceRegistry {
  return getRegistryGlobal().registry;
}
