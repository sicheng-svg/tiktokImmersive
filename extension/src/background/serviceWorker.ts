import { DEFAULT_SETTINGS, SETTINGS_KEY } from "../services/storage";
import type { VideoProcessingResponse } from "../types/videoProcessing";
import { createLogger } from "../utils/logger";
import { hasVideoProcessingType, isTrustedDouyinSender, isVideoProcessingMessage } from "./requestValidation";
import { VideoTaskGateway } from "./videoTaskGateway";

const logger = createLogger("ServiceWorker");
const videoTasks = new VideoTaskGateway();

chrome.runtime.onInstalled.addListener(async () => {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  if (!stored[SETTINGS_KEY]) {
    await chrome.storage.local.set({ [SETTINGS_KEY]: DEFAULT_SETTINGS });
  }
  logger.info("Extension initialized");
});

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (!hasVideoProcessingType(message)) return undefined;
  if (!isTrustedDouyinSender(sender) || !isVideoProcessingMessage(message)) {
    logger.warn("Rejected an untrusted or invalid backend proxy request", { tabUrl: sender.tab?.url });
    sendResponse({ ok: false, error: "Backend request was rejected" } satisfies VideoProcessingResponse);
    return false;
  }

  const task =
    message.type === "PROCESS_VIDEO_SOURCE" ? videoTasks.start(message.payload) : videoTasks.get(message.taskId);
  void task
    .then((result) => {
      logger.info("Backend task updated", { taskId: result.taskId, status: result.status });
      sendResponse({ ok: true, task: result } satisfies VideoProcessingResponse);
    })
    .catch((error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error);
      logger.error("Backend task request failed", error);
      sendResponse({ ok: false, error: detail } satisfies VideoProcessingResponse);
    });
  return true;
});
