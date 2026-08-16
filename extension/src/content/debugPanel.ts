import type { ContentStatus } from "../types";
import type { PlaybackDebugSnapshot } from "./videoAudioController";

function formatSeconds(value: number): string {
  return `${value.toFixed(2)}s`;
}

export class DebugPanel {
  private element: HTMLDivElement | null = null;

  setVisible(visible: boolean): void {
    if (!visible) {
      this.element?.remove();
      this.element = null;
      return;
    }
    this.ensureElement();
  }

  update(status: ContentStatus, snapshot: PlaybackDebugSnapshot): void {
    if (!this.element) return;
    const lines = [
      `Video: ${snapshot.videoKey ?? "none"}`,
      `Status: ${status.state}`,
      `Video time: ${formatSeconds(snapshot.videoTime)}`,
      `Dub time: ${formatSeconds(snapshot.dubTime)}`,
      `Offset: ${snapshot.syncOffset >= 0 ? "+" : ""}${formatSeconds(snapshot.syncOffset)}`,
      `Playing: ${snapshot.playing ? "yes" : "no"}`,
      `URL: ${snapshot.videoUrl ?? "unavailable"}`,
      `Extraction: ${status.debug?.processingState ?? "IDLE"}`,
      `Source provider: ${status.debug?.sourceProvider ?? "unavailable"}`,
      `Source confidence: ${status.debug?.sourceConfidence ?? "unavailable"}`,
      `Source URL: ${status.debug?.sourceUrl ?? "unavailable"}`,
      `Task: ${status.debug?.taskId ?? "none"}`,
      `Progress: ${status.debug?.progress ?? "unknown"}`,
      `Backend audio: ${status.debug?.backendAudioUrl ?? "not ready"}`,
      `Backend error: ${status.debug?.backendError ?? "none"}`,
    ];
    this.element.textContent = lines.join("\n");
  }

  destroy(): void {
    this.setVisible(false);
  }

  private ensureElement(): void {
    if (this.element?.isConnected) return;
    const element = document.createElement("div");
    element.id = "douyin-english-debug";
    Object.assign(element.style, {
      position: "fixed",
      top: "16px",
      right: "16px",
      zIndex: "2147483647",
      maxWidth: "420px",
      padding: "10px 12px",
      border: "1px solid rgba(37, 244, 238, 0.55)",
      borderRadius: "8px",
      color: "#f8f8fb",
      background: "rgba(12, 12, 16, 0.88)",
      boxShadow: "0 8px 30px rgba(0, 0, 0, 0.35)",
      font: "11px/1.5 ui-monospace, SFMono-Regular, Consolas, monospace",
      whiteSpace: "pre-wrap",
      overflowWrap: "anywhere",
      pointerEvents: "none",
    });
    document.documentElement.append(element);
    this.element = element;
  }
}
