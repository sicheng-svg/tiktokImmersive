import type { VideoProcessingRequest } from "../types/videoProcessing";
import { normalizeDouyinMediaUrl } from "../utils/mediaUrlPolicy";

interface MessageSenderLike {
  tab?: { url?: string };
}

const VIDEO_KEY_PATTERN = /^[A-Za-z0-9:_-]{1,256}$/;
const TASK_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export function isTrustedDouyinSender(sender: MessageSenderLike): boolean {
  if (!sender.tab?.url) return false;
  try {
    const url = new URL(sender.tab.url);
    return url.protocol === "https:" && (url.hostname === "douyin.com" || url.hostname.endsWith(".douyin.com"));
  } catch {
    return false;
  }
}

function isSafeMediaUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 8_192) return false;
  return normalizeDouyinMediaUrl(value) !== null;
}

export function isVideoProcessingMessage(value: unknown): value is VideoProcessingRequest {
  if (!value || typeof value !== "object") return false;
  const message = value as Record<string, unknown>;
  if (message.type === "GET_VIDEO_TASK") {
    return typeof message.taskId === "string" && TASK_ID_PATTERN.test(message.taskId);
  }
  if (message.type !== "PROCESS_VIDEO_SOURCE" || !message.payload || typeof message.payload !== "object") {
    return false;
  }
  const payload = message.payload as Record<string, unknown>;
  return (
    typeof payload.videoKey === "string" &&
    VIDEO_KEY_PATTERN.test(payload.videoKey) &&
    isSafeMediaUrl(payload.videoUrl)
  );
}

export function hasVideoProcessingType(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const type = (value as Record<string, unknown>).type;
  return type === "PROCESS_VIDEO_SOURCE" || type === "GET_VIDEO_TASK";
}
