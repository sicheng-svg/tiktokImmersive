import { DEFAULT_SETTINGS, getSettings, readSettingsChange } from "../services/storage";
import type { ContentStatus, ExtensionMessage, ExtensionSettings, VideoProcessingStatus } from "../types";
import { createLogger } from "../utils/logger";
import { AudioSourceResolver } from "./audioSourceProvider";
import { DebugPanel } from "./debugPanel";
import { DubPlayer } from "./dubPlayer";
import { VideoAudioController, type MockPlaybackStatus } from "./videoAudioController";
import { VideoDetector } from "./videoDetector";
import { ChromeVideoTaskTransport, VideoProcessingCoordinator } from "./videoProcessingCoordinator";

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
let playbackStatus: MockPlaybackStatus = { state: "IDLE", message: "English Mode is off" };
let processingStatus: VideoProcessingStatus = { state: "IDLE", message: "Media extraction is off" };

function publishStatus(): void {
  const debug = audioController.getDebugSnapshot();
  const processingMessage = processingStatus.state === "IDLE" ? "" : ` · ${processingStatus.message}`;
  status = {
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
    message: `${playbackStatus.message}${processingMessage}`,
    videoKey: playbackStatus.videoKey ?? processingStatus.videoKey,
    debug: {
      videoUrl: debug.videoUrl,
      videoTime: debug.videoTime,
      dubTime: debug.dubTime,
      syncOffset: debug.syncOffset,
      processingState: processingStatus.state,
      sourceUrl: processingStatus.sourceUrl,
      sourceProvider: processingStatus.sourceProvider,
      sourceConfidence: processingStatus.sourceConfidence,
      taskId: processingStatus.taskId,
      progress: processingStatus.progress,
      backendAudioUrl: processingStatus.audioUrl,
      backendError: processingStatus.error,
    },
  };
  debugPanel.update(status, audioController.getDebugSnapshot());
  void chrome.runtime.sendMessage({ type: "CONTENT_STATUS_UPDATED", status } satisfies ExtensionMessage).catch(() => {
    // The popup is normally closed, so having no message receiver is expected.
  });
}

function handlePlaybackStatus(nextPlaybackStatus: MockPlaybackStatus): void {
  // Keep Phase 3 mock playback authoritative; extraction only augments its status.
  playbackStatus = nextPlaybackStatus;
  publishStatus();
}

const audioController = new VideoAudioController(
  dubPlayer,
  chrome.runtime.getURL("audio/test.mp3"),
  DEFAULT_SETTINGS,
  handlePlaybackStatus,
);
const processingCoordinator = new VideoProcessingCoordinator(
  new AudioSourceResolver(),
  new ChromeVideoTaskTransport(),
  (nextStatus) => {
    processingStatus = nextStatus;
    publishStatus();
  },
);

function applySettings(nextSettings: ExtensionSettings): void {
  settings = nextSettings;
  document.documentElement.dataset.douyinEnglishMode = settings.enabled ? "on" : "off";
  debugPanel.setVisible(settings.debug);
  audioController.updateSettings(settings);
  processingCoordinator.setEnabled(settings.enabled);
  logger.info(`English Mode ${settings.enabled ? "enabled" : "disabled"}`);
}

detector.onActiveVideoChanged((current) => {
  audioController.setActiveVideo(current);
  processingCoordinator.setActiveVideo(current);
});

let runtimeRunning = false;
let debugRefreshTimer: number | null = null;

function startRuntime(): void {
  if (runtimeRunning) return;
  runtimeRunning = true;
  detector.start();
  processingCoordinator.setEnabled(settings.enabled);
  debugPanel.setVisible(settings.debug);
  debugRefreshTimer = window.setInterval(() => {
    if (settings.debug) debugPanel.update(status, audioController.getDebugSnapshot());
  }, 250);
  if (settings.enabled && !detector.getActiveVideo()) {
    playbackStatus = { state: "IDLE", message: "Waiting for the active video" };
    publishStatus();
  }
}

function stopRuntime(): void {
  if (!runtimeRunning) return;
  runtimeRunning = false;
  processingCoordinator.stop();
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
  if (message.type === "RETRY_VIDEO_PROCESSING") {
    processingCoordinator.retry();
  }
});

window.addEventListener("pagehide", stopRuntime);
window.addEventListener("pageshow", (event) => {
  if (event.persisted) startRuntime();
});
