import type { ExtensionSettings } from "../types";

export const SETTINGS_KEY = "douyinEnglishSettings";

export const DEFAULT_SETTINGS: ExtensionSettings = {
  enabled: false,
  subtitleMode: "bilingual",
  playbackRate: 1,
  debug: false,
};

function sanitizeSettings(value: unknown): ExtensionSettings {
  if (!value || typeof value !== "object") {
    return { ...DEFAULT_SETTINGS };
  }

  const stored = value as Partial<ExtensionSettings>;
  return {
    enabled: typeof stored.enabled === "boolean" ? stored.enabled : DEFAULT_SETTINGS.enabled,
    subtitleMode:
      stored.subtitleMode === "bilingual" || stored.subtitleMode === "english" || stored.subtitleMode === "off"
        ? stored.subtitleMode
        : DEFAULT_SETTINGS.subtitleMode,
    playbackRate:
      typeof stored.playbackRate === "number" && stored.playbackRate >= 0.85 && stored.playbackRate <= 1.35
        ? stored.playbackRate
        : DEFAULT_SETTINGS.playbackRate,
    debug: typeof stored.debug === "boolean" ? stored.debug : DEFAULT_SETTINGS.debug,
  };
}

export async function getSettings(): Promise<ExtensionSettings> {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  return sanitizeSettings(stored[SETTINGS_KEY]);
}

export async function saveSettings(settings: ExtensionSettings): Promise<void> {
  await chrome.storage.local.set({ [SETTINGS_KEY]: sanitizeSettings(settings) });
}

export function readSettingsChange(changes: Record<string, chrome.storage.StorageChange>): ExtensionSettings | null {
  const change = changes[SETTINGS_KEY];
  return change ? sanitizeSettings(change.newValue) : null;
}
