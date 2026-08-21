import { DEFAULT_SETTINGS, getSettings, saveSettings } from "../services/storage";
import type { ContentStatus, ExtensionMessage, ExtensionSettings, SubtitleMode } from "../types";
import { createLogger } from "../utils/logger";
import "./styles.css";

const logger = createLogger("Popup");
const app = document.querySelector<HTMLDivElement>("#app");

if (!app) throw new Error("Popup root element is missing");
const popupRoot = app;

popupRoot.innerHTML = `
  <main class="popup-shell">
    <header>
      <p class="eyebrow">DOUYIN SUBTITLES</p>
      <h1>双语字幕</h1>
    </header>
    <label class="switch-row">
      <span>智能字幕</span>
      <input id="enabled" type="checkbox" role="switch" aria-label="智能字幕总开关" />
      <span class="switch" aria-hidden="true"></span>
    </label>
    <fieldset>
      <legend>字幕</legend>
      <label><input name="subtitle" type="radio" value="bilingual" /> 中英双语</label>
      <label><input name="subtitle" type="radio" value="english" /> 仅英文</label>
      <label><input name="subtitle" type="radio" value="off" /> 关闭</label>
    </fieldset>
    <label class="debug-row"><input id="debug" type="checkbox" /> Debug Mode</label>
    <section class="status-card" aria-live="polite">
      <span class="status-dot"></span>
      <div>
        <p>当前状态</p>
        <strong id="status">正在连接抖音页面…</strong>
        <small id="backend-status">后端：正在检测本地服务…</small>
      </div>
    </section>
  </main>
`;

const enabledInput = popupRoot.querySelector<HTMLInputElement>("#enabled")!;
const debugInput = popupRoot.querySelector<HTMLInputElement>("#debug")!;
const statusText = popupRoot.querySelector<HTMLElement>("#status")!;
const backendStatusText = popupRoot.querySelector<HTMLElement>("#backend-status")!;

let settings: ExtensionSettings = DEFAULT_SETTINGS;

async function checkBackendHealth(): Promise<void> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 30_000);
  try {
    // A foreground popup fetch can surface Chrome's Local Network Access prompt.
    const response = await fetch("http://127.0.0.1:8000/health", {
      method: "GET",
      cache: "no-store",
      signal: controller.signal,
    });
    const payload = (await response.json()) as { status?: unknown };
    if (!response.ok || payload.status !== "ok") throw new Error(`Health check failed (${response.status})`);
    backendStatusText.textContent = "后端：已连接";
    backendStatusText.dataset.state = "connected";
    await sendToContent({ type: "RETRY_VIDEO_PROCESSING" });
  } catch (error) {
    logger.warn("Local backend health check failed", error);
    backendStatusText.textContent = "后端：未连接（请启动服务并允许本地网络访问）";
    backendStatusText.dataset.state = "disconnected";
  } finally {
    window.clearTimeout(timeout);
  }
}

function render(nextSettings: ExtensionSettings): void {
  enabledInput.checked = nextSettings.enabled;
  debugInput.checked = nextSettings.debug;
  const subtitle = popupRoot.querySelector<HTMLInputElement>(
    `input[name="subtitle"][value="${nextSettings.subtitleMode}"]`,
  );
  if (subtitle) subtitle.checked = true;
}

async function getActiveDouyinTab(): Promise<chrome.tabs.Tab | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url) return undefined;
  try {
    const hostname = new URL(tab.url).hostname;
    return hostname === "douyin.com" || hostname.endsWith(".douyin.com") ? tab : undefined;
  } catch {
    return undefined;
  }
}

async function sendToContent(message: ExtensionMessage): Promise<unknown> {
  const tab = await getActiveDouyinTab();
  if (!tab?.id) return undefined;
  try {
    return await chrome.tabs.sendMessage(tab.id, message);
  } catch (error) {
    logger.warn("Douyin content script is not available", error);
    return undefined;
  }
}

async function persistAndNotify(nextSettings: ExtensionSettings): Promise<void> {
  settings = nextSettings;
  render(settings);
  await saveSettings(settings);
  await sendToContent({ type: "SETTINGS_UPDATED", settings });
  await refreshStatus();
}

async function refreshStatus(): Promise<void> {
  const tab = await getActiveDouyinTab();
  if (!tab) {
    statusText.textContent = "请先打开 douyin.com";
    return;
  }
  const contentStatus = (await sendToContent({ type: "GET_CONTENT_STATUS" })) as ContentStatus | undefined;
  statusText.textContent = contentStatus?.message ?? "请刷新抖音页面以启动插件";
}

enabledInput.addEventListener("change", () => {
  void persistAndNotify({ ...settings, enabled: enabledInput.checked });
});

popupRoot.querySelectorAll<HTMLInputElement>('input[name="subtitle"]').forEach((input) => {
  input.addEventListener("change", () => {
    void persistAndNotify({ ...settings, subtitleMode: input.value as SubtitleMode });
  });
});

debugInput.addEventListener("change", () => {
  void persistAndNotify({ ...settings, debug: debugInput.checked });
});

chrome.runtime.onMessage.addListener((message: ExtensionMessage) => {
  if (message.type === "CONTENT_STATUS_UPDATED") {
    statusText.textContent = message.status.message;
  }
});

void getSettings()
  .then(async (storedSettings) => {
    settings = storedSettings;
    render(settings);
    await refreshStatus();
  })
  .catch((error: unknown) => {
    logger.error("Failed to initialize popup", error);
    statusText.textContent = "插件初始化失败";
  });

void checkBackendHealth();
