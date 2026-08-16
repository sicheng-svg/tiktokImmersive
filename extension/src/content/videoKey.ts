const AWEME_ATTRIBUTE_NAMES = ["data-aweme-id", "data-video-id", "data-item-id"];
const AWEME_URL_PATTERN = /\/(?:video|note)\/(\d{8,})/;

function findAwemeIdInUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  return value.match(AWEME_URL_PATTERN)?.[1] ?? null;
}

export function findAwemeId(video: HTMLVideoElement): string | null {
  let element: Element | null = video;
  for (let depth = 0; element && depth < 8; depth += 1, element = element.parentElement) {
    for (const attribute of AWEME_ATTRIBUTE_NAMES) {
      const value = element.getAttribute(attribute);
      if (value && /^\d{8,}$/.test(value)) return value;
    }

    if (element instanceof HTMLAnchorElement) {
      const id = findAwemeIdInUrl(element.href);
      if (id) return id;
    }

    const linkedVideos = element.querySelectorAll<HTMLAnchorElement>('a[href*="/video/"], a[href*="/note/"]');
    const scopedVideos = element.querySelectorAll<HTMLVideoElement>("video");
    if (linkedVideos.length === 1 && scopedVideos.length === 1 && scopedVideos[0] === video) {
      const linkedId = findAwemeIdInUrl(linkedVideos[0].href);
      if (linkedId) return linkedId;
    }
  }

  const pageId = findAwemeIdInUrl(window.location.href);
  if (!pageId) return null;
  const pageVideos = Array.from(document.querySelectorAll<HTMLVideoElement>("video")).filter(
    (candidate) => candidate.isConnected,
  );
  return pageVideos.length === 1 && pageVideos[0] === video ? pageId : null;
}

function normalizeMediaUrl(value: string): string | null {
  if (!value || value.startsWith("blob:")) return null;
  try {
    const url = new URL(value, window.location.href);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

export function getUsableMediaUrl(video: HTMLVideoElement): string | null {
  return normalizeMediaUrl(video.currentSrc) ?? normalizeMediaUrl(video.src);
}

export async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function getDomMetadata(video: HTMLVideoElement): string | null {
  const closestLink = video.closest<HTMLAnchorElement>('a[href*="/video/"], a[href*="/note/"]');
  const metadata = {
    poster: video.poster || null,
    duration: Number.isFinite(video.duration) ? Math.round(video.duration * 1000) : null,
    label: video.getAttribute("aria-label"),
    title: video.getAttribute("title"),
    link: closestLink?.href ?? null,
  };
  return Object.values(metadata).some((value) => value !== null) ? JSON.stringify(metadata) : null;
}

interface CachedVideoKey {
  signature: string;
  key: string;
}

export class VideoKeyFactory {
  private readonly cache = new WeakMap<HTMLVideoElement, CachedVideoKey>();

  async getKey(video: HTMLVideoElement): Promise<string> {
    const awemeId = findAwemeId(video);
    if (awemeId) return awemeId;

    const mediaUrl = getUsableMediaUrl(video);
    const metadata = getDomMetadata(video);
    const signature = mediaUrl ? `url:${mediaUrl}` : metadata ? `dom:${metadata}` : "element";
    const cached = this.cache.get(video);
    if (cached?.signature === signature) return cached.key;

    let key: string;
    if (mediaUrl) {
      key = `url:${await sha256(mediaUrl)}`;
    } else if (metadata) {
      key = `dom:${await sha256(metadata)}`;
    } else {
      key = cached?.signature === signature ? cached.key : `element:${crypto.randomUUID()}`;
    }

    this.cache.set(video, { signature, key });
    return key;
  }
}
