const STREAM_MANIFEST_PATTERN = /\.(?:m3u8|mpd)$/i;

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
