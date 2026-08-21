import { DEFAULT_SETTINGS, getSettings, readSettingsChange } from "../services/storage";
import type { ContentStatus, ExtensionMessage, ExtensionSettings, VideoProcessingStatus } from "../types";
import { createLogger } from "../utils/logger";
import { AudioSourceResolver, BoundAwemeSourceProvider, DirectVideoSourceProvider } from "./audioSourceProvider";
import { getCapturedAwemeSourceRegistry } from "./capturedAwemeSources";
import { DebugPanel } from "./debugPanel";
import { SubtitleOverlay } from "./subtitleOverlay";
import { VideoDetector } from "./videoDetector";
import { ChromeVideoTaskTransport, VideoProcessingCoordinator } from "./videoProcessingCoordinator";

const logger = createLogger("Content");
let settings: ExtensionSettings = DEFAULT_SETTINGS;
const detector = new VideoDetector();
const capturedAwemeSources = getCapturedAwemeSourceRegistry();
const debugPanel = new DebugPanel();
const subtitleOverlay = new SubtitleOverlay();
let status: ContentStatus = {
  enabled: false,
  state: "IDLE",
  message: "智能字幕已关闭",
};
let processingStatus: VideoProcessingStatus = { state: "IDLE", message: "智能字幕已关闭" };

function getContentState(): ContentStatus["state"] {
  if (!settings.enabled) return "IDLE";
  if (processingStatus.state === "READY") {
    return processingStatus.legacyMediaReady ? "LEGACY_BACKEND" : "SUBTITLES_READY";
  }
  if (processingStatus.state === "DEGRADED") return "DEGRADED";
  if (processingStatus.state === "ERROR" || processingStatus.state === "SOURCE_UNAVAILABLE") return "ERROR";
  if (processingStatus.state === "PROCESSING" || processingStatus.state === "SUBMITTING") return "PROCESSING";
  return "DETECTING";
}

function publishStatus(): void {
  const active = detector.getActiveVideo();
  status = {
    enabled: settings.enabled,
    state: getContentState(),
    message: settings.enabled ? processingStatus.message : "智能字幕已关闭",
    videoKey: processingStatus.videoKey ?? active?.videoKey,
    debug: {
      videoTime: active?.element.currentTime ?? 0,
      playing: Boolean(active && !active.element.paused && !active.element.ended),
      processingState: processingStatus.state,
      stage: processingStatus.stage,
      taskId: processingStatus.taskId,
      progress: processingStatus.progress,
      transcriptCount: processingStatus.transcript?.length ?? 0,
      subtitleCount: processingStatus.subtitles?.length ?? 0,
      taskReused: processingStatus.taskReused,
      asrCacheHit: processingStatus.steps?.asr.cacheHit,
      translationCacheHit: processingStatus.steps?.translation.cacheHit,
      backendError: processingStatus.error,
    },
  };
  debugPanel.update(status);
  void chrome.runtime.sendMessage({ type: "CONTENT_STATUS_UPDATED", status } satisfies ExtensionMessage).catch(() => {
    // The popup is normally closed, so having no message receiver is expected.
  });
}

function applyOverlayStatus(nextStatus: VideoProcessingStatus): void {
  if (!settings.enabled) {
    subtitleOverlay.clearCues();
    return;
  }
  if (nextStatus.state === "READY" && !nextStatus.legacyMediaReady && nextStatus.subtitles?.length) {
    subtitleOverlay.showSubtitles(nextStatus.subtitles);
    return;
  }
  if (
    (nextStatus.state === "DEGRADED" ||
      (nextStatus.state === "PROCESSING" && nextStatus.stage === "TRANSLATING")) &&
    nextStatus.transcript?.length
  ) {
    subtitleOverlay.showTranscript(nextStatus.transcript);
    return;
  }
  subtitleOverlay.clearCues();
}

const processingCoordinator = new VideoProcessingCoordinator(
  new AudioSourceResolver([
    new DirectVideoSourceProvider(),
    new BoundAwemeSourceProvider(capturedAwemeSources),
  ]),
  new ChromeVideoTaskTransport(),
  (nextStatus) => {
    processingStatus = nextStatus;
    applyOverlayStatus(nextStatus);
    publishStatus();
  },
);

capturedAwemeSources.subscribe((updatedAwemeIds) => {
  const mayRetry =
    processingStatus.state === "SOURCE_UNAVAILABLE" ||
    (processingStatus.state === "ERROR" &&
      (processingStatus.stage === undefined || processingStatus.stage === "FETCHING"));
  if (!mayRetry) return;
  const active = detector.getActiveVideo();
  const awemeId = active?.boundAwemeId ?? null;
  if (!active || !awemeId || !updatedAwemeIds.has(awemeId)) return;
  const activeElement = active.element;
  const activeVideoKey = active.videoKey;
  void detector
    .evaluateNow()
    .then(() => {
      const refreshed = detector.getActiveVideo();
      const stillMayRetry =
        processingStatus.state === "SOURCE_UNAVAILABLE" ||
        (processingStatus.state === "ERROR" &&
          (processingStatus.stage === undefined || processingStatus.stage === "FETCHING"));
      if (
        refreshed?.element === activeElement &&
        refreshed.videoKey === activeVideoKey &&
        refreshed.boundAwemeId === awemeId &&
        stillMayRetry
      ) {
        processingCoordinator.retry();
      }
    })
    .catch((error: unknown) => logger.error("Failed to refresh captured media identity", error));
});

function applySettings(nextSettings: ExtensionSettings): void {
  const wasEnabled = settings.enabled;
  settings = nextSettings;
  document.documentElement.dataset.douyinEnglishMode = settings.enabled ? "on" : "off";
  debugPanel.setVisible(settings.debug);
  subtitleOverlay.setMode(settings.enabled ? settings.subtitleMode : "off");
  if (!settings.enabled && wasEnabled) subtitleOverlay.clearCues();
  processingCoordinator.setEnabled(settings.enabled);
  publishStatus();
  logger.info(`Smart subtitles ${settings.enabled ? "enabled" : "disabled"}`);
}

detector.onActiveVideoChanged((current) => {
  subtitleOverlay.setActiveVideo(current);
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
    if (settings.debug) publishStatus();
  }, 250);
  if (settings.enabled && !detector.getActiveVideo()) {
    processingStatus = { state: "IDLE", message: "正在等待可处理的视频" };
    publishStatus();
  }
}

function stopRuntime(): void {
  if (!runtimeRunning) return;
  runtimeRunning = false;
  processingCoordinator.stop();
  subtitleOverlay.stop();
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
