import { normalizeDouyinMediaUrl } from "../utils/mediaUrlPolicy";

export const MEDIA_CAPTURE_MESSAGE_SOURCE = "douyin-english-page-media";
export const MEDIA_CAPTURE_MESSAGE_TYPE = "AWEME_MEDIA_CAPTURED";
export const MEDIA_CAPTURE_MESSAGE_VERSION = 1;
export const MAX_CAPTURED_MAPPINGS = 50;
export const MAX_CAPTURED_URLS_PER_AWEME = 8;
export const MAX_CAPTURE_RESPONSE_CHARS = 5 * 1024 * 1024;

const AWEME_ID_PATTERN = /^\d{8,32}$/;
const PLAY_ADDRESS_KEY_PATTERN = /play.*addr|play_url/i;
const RESPONSE_PATH_PATTERN = /\/(?:aweme|feed)\//i;
const MAX_TRAVERSED_NODES = 10_000;
const MAX_TRAVERSAL_DEPTH = 14;

export interface CapturedAwemeMediaMapping {
  awemeId: string;
  urls: string[];
}

export interface MediaCaptureMessage {
  source: typeof MEDIA_CAPTURE_MESSAGE_SOURCE;
  type: typeof MEDIA_CAPTURE_MESSAGE_TYPE;
  version: typeof MEDIA_CAPTURE_MESSAGE_VERSION;
  mappings: CapturedAwemeMediaMapping[];
}

function getRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function getAwemeId(record: Record<string, unknown>): string | null {
  for (const key of ["aweme_id", "awemeId"]) {
    const value = record[key];
    if (typeof value === "string" && AWEME_ID_PATTERN.test(value)) return value;
    if (typeof value === "number" && Number.isSafeInteger(value)) {
      const normalized = String(value);
      if (AWEME_ID_PATTERN.test(normalized)) return normalized;
    }
  }
  return null;
}

function collectUrlValues(value: unknown, results: string[], depth = 0): void {
  if (results.length >= MAX_CAPTURED_URLS_PER_AWEME || depth > 5) return;
  if (typeof value === "string") {
    const normalized = normalizeDouyinMediaUrl(value);
    if (normalized && !results.includes(normalized)) {
      results.push(normalized);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectUrlValues(item, results, depth + 1);
    return;
  }
  const record = getRecord(value);
  if (!record) return;
  for (const [key, item] of Object.entries(record)) {
    if (key === "url_list" || key === "urlList" || key === "url" || key === "src") {
      collectUrlValues(item, results, depth + 1);
    }
  }
}

function collectPlaybackAddresses(value: unknown, results: string[], depth = 0): void {
  if (results.length >= MAX_CAPTURED_URLS_PER_AWEME || depth > 8) return;
  if (Array.isArray(value)) {
    for (const item of value) collectPlaybackAddresses(item, results, depth + 1);
    return;
  }
  const record = getRecord(value);
  if (!record) return;
  for (const [key, item] of Object.entries(record)) {
    if (PLAY_ADDRESS_KEY_PATTERN.test(key)) collectUrlValues(item, results);
    if (key === "bit_rate" || key === "bitRate" || key === "video") {
      collectPlaybackAddresses(item, results, depth + 1);
    }
  }
}

function extractVideoUrls(record: Record<string, unknown>): string[] {
  const video = getRecord(record.video);
  if (!video) return [];

  const urls: string[] = [];
  for (const key of ["play_addr", "playAddr", "play_addr_h264", "play_addr_265", "play_addr_bytevc1"]) {
    collectUrlValues(video[key], urls);
  }
  collectPlaybackAddresses(video, urls);
  return urls.slice(0, MAX_CAPTURED_URLS_PER_AWEME);
}

export function extractAwemeMediaMappings(payload: unknown): CapturedAwemeMediaMapping[] {
  const mappings = new Map<string, string[]>();
  const seen = new WeakSet<object>();
  let traversedNodes = 0;

  const visit = (value: unknown, depth: number): void => {
    if (depth > MAX_TRAVERSAL_DEPTH || traversedNodes >= MAX_TRAVERSED_NODES || mappings.size >= MAX_CAPTURED_MAPPINGS) {
      return;
    }
    if (value === null || typeof value !== "object") return;
    if (seen.has(value)) return;
    seen.add(value);
    traversedNodes += 1;

    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }

    const record = value as Record<string, unknown>;
    const awemeId = getAwemeId(record);
    if (awemeId) {
      const urls = extractVideoUrls(record);
      if (urls.length > 0) {
        const existing = mappings.get(awemeId) ?? [];
        for (const url of urls) {
          if (!existing.includes(url) && existing.length < MAX_CAPTURED_URLS_PER_AWEME) existing.push(url);
        }
        mappings.set(awemeId, existing);
      }
    }

    for (const item of Object.values(record)) visit(item, depth + 1);
  };

  visit(payload, 0);
  return Array.from(mappings, ([awemeId, urls]) => ({ awemeId, urls }));
}

export function shouldInspectMediaMetadataResponse(urlValue: string, contentType: string | null): boolean {
  try {
    const url = new URL(urlValue, window.location.href);
    const isDouyin = url.hostname === "douyin.com" || url.hostname.endsWith(".douyin.com");
    const isJson = contentType === null || /(?:application|text)\/json/i.test(contentType);
    return isDouyin && isJson && RESPONSE_PATH_PATTERN.test(url.pathname);
  } catch {
    return false;
  }
}

export function createMediaCaptureMessage(mappings: CapturedAwemeMediaMapping[]): MediaCaptureMessage {
  return {
    source: MEDIA_CAPTURE_MESSAGE_SOURCE,
    type: MEDIA_CAPTURE_MESSAGE_TYPE,
    version: MEDIA_CAPTURE_MESSAGE_VERSION,
    mappings: mappings.slice(0, MAX_CAPTURED_MAPPINGS),
  };
}
