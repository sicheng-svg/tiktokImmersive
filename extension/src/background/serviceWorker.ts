import { DEFAULT_SETTINGS, SETTINGS_KEY } from "../services/storage";
import { createLogger } from "../utils/logger";

const logger = createLogger("ServiceWorker");

chrome.runtime.onInstalled.addListener(async () => {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  if (!stored[SETTINGS_KEY]) {
    await chrome.storage.local.set({ [SETTINGS_KEY]: DEFAULT_SETTINGS });
  }
  logger.info("Extension initialized");
});
