import { DEFAULT_SETTINGS, getSettings, readSettingsChange } from "../services/storage";
import type { ContentStatus, ExtensionMessage, ExtensionSettings } from "../types";
import { createLogger } from "../utils/logger";
import { DebugPanel } from "./debugPanel";
import { DubPlayer } from "./dubPlayer";
import { VideoAudioController, type MockPlaybackStatus } from "./videoAudioController";
import { VideoDetector } from "./videoDetector";

const logger = createLogger("Content");
let settings: ExtensionSettings = DEFAULT_SETTINGS;
const detector = new VideoDetector();
const dubPlayer = new DubPlayer();
const debugPanel = new DebugPanel();
let status: ContentStatus = {
  enabled: false,
  state: "IDLE",
  message: "English Mode is off",
};

function publishStatus(nextStatus: ContentStatus): void {
  status = nextStatus;
  debugPanel.update(status, audioController.getDebugSnapshot());
  void chrome.runtime.sendMessage({ type: "CONTENT_STATUS_UPDATED", status } satisfies ExtensionMessage).catch(() => {
    // The popup is normally closed, so having no message receiver is expected.
  });
}

function handlePlaybackStatus(playbackStatus: MockPlaybackStatus): void {
  const debug = audioController.getDebugSnapshot();
  publishStatus({
    enabled: settings.enabled,
    state:
      playbackStatus.state === "PLAYING"
        ? "MOCK_PLAYING"
        : playbackStatus.state === "ERROR"
          ? "ERROR"
          : playbackStatus.state === "READY"
            ? "MOCK_READY"
            : settings.enabled
              ? "DETECTING"
              : "IDLE",
    message: playbackStatus.message,
    videoKey: playbackStatus.videoKey,
    debug: {
      videoUrl: debug.videoUrl,
      videoTime: debug.videoTime,
      dubTime: debug.dubTime,
      syncOffset: debug.syncOffset,
    },
  });
}

const audioController = new VideoAudioController(
  dubPlayer,
  chrome.runtime.getURL("audio/test.mp3"),
  DEFAULT_SETTINGS,
  handlePlaybackStatus,
);

function applySettings(nextSettings: ExtensionSettings): void {
  settings = nextSettings;
  document.documentElement.dataset.douyinEnglishMode = settings.enabled ? "on" : "off";
  debugPanel.setVisible(settings.debug);
  audioController.updateSettings(settings);
  logger.info(`English Mode ${settings.enabled ? "enabled" : "disabled"}`);
}

detector.onActiveVideoChanged((current) => {
  audioController.setActiveVideo(current);
});

let runtimeRunning = false;
let debugRefreshTimer: number | null = null;

function startRuntime(): void {
  if (runtimeRunning) return;
  runtimeRunning = true;
  detector.start();
  debugPanel.setVisible(settings.debug);
  debugRefreshTimer = window.setInterval(() => {
    if (settings.debug) debugPanel.update(status, audioController.getDebugSnapshot());
  }, 250);
  if (settings.enabled && !detector.getActiveVideo()) {
    publishStatus({ enabled: true, state: "DETECTING", message: "Waiting for the active video" });
  }
}

function stopRuntime(): void {
  if (!runtimeRunning) return;
  runtimeRunning = false;
  audioController.stop();
  detector.stop();
  debugPanel.destroy();
  if (debugRefreshTimer !== null) {
    window.clearInterval(debugRefreshTimer);
    debugRefreshTimer = null;
  }
}

startRuntime();

void getSettings()
  .then(applySettings)
  .catch((error: unknown) => logger.error("Failed to load settings", error));

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;
  const nextSettings = readSettingsChange(changes);
  if (nextSettings) applySettings(nextSettings);
});

chrome.runtime.onMessage.addListener((message: ExtensionMessage, _sender, sendResponse) => {
  if (message.type === "SETTINGS_UPDATED") {
    applySettings(message.settings);
  }
  if (message.type === "GET_CONTENT_STATUS") {
    sendResponse(status);
  }
});

window.addEventListener("pagehide", stopRuntime);
window.addEventListener("pageshow", (event) => {
  if (event.persisted) startRuntime();
});
