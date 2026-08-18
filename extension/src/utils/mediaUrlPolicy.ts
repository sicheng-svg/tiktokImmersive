const STREAM_MANIFEST_PATTERN = /\.(?:m3u8|mpd)$/i;
const NON_MEDIA_RESOURCE_PATTERN = /\.(?:avif|bmp|gif|ico|jpe?g|png|svg|webp)$/i;
const DOUYIN_MEDIA_HOST_SUFFIXES = [
  "douyin.com",
  "douyinvod.com",
  "bytevcloud.com",
  "bytecdn.cn",
  "zjcdn.com",
  "bytedance.com",
  "bytedance.net",
  "snssdk.com",
] as const;

function hasAllowedHostSuffix(hostname: string, suffix: string): boolean {
  return hostname === suffix || hostname.endsWith(`.${suffix}`);
}

export function normalizeSecureMediaUrl(
  value: string | null | undefined,
  baseUrl?: string,
): string | null {
  if (!value) return null;
  try {
    const url = baseUrl === undefined ? new URL(value) : new URL(value, baseUrl);
    if (
      url.protocol !== "https:" ||
      (url.port !== "" && url.port !== "443") ||
      url.username.length > 0 ||
      url.password.length > 0
    ) {
      return null;
    }
    const decodedPath = decodeURIComponent(url.pathname);
    return STREAM_MANIFEST_PATTERN.test(decodedPath) ? null : url.href;
  } catch {
    return null;
  }
}

export function normalizeDouyinMediaUrl(
  value: string | null | undefined,
  baseUrl?: string,
): string | null {
  const normalized = normalizeSecureMediaUrl(value, baseUrl);
  if (!normalized || normalized.length > 8_192) return null;

  const url = new URL(normalized);
  const decodedPath = decodeURIComponent(url.pathname);
  if (
    url.hash ||
    NON_MEDIA_RESOURCE_PATTERN.test(decodedPath) ||
    !DOUYIN_MEDIA_HOST_SUFFIXES.some((suffix) => hasAllowedHostSuffix(url.hostname, suffix))
  ) {
    return null;
  }
  return url.href;
}
