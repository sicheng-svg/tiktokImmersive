import type { ContentStatus } from "../types";

function formatSeconds(value: number): string {
  return `${value.toFixed(2)}s`;
}

function formatCacheHit(value: boolean | null | undefined): string {
  return value === true ? "hit" : value === false ? "miss" : "unknown";
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

  update(status: ContentStatus): void {
    if (!this.element) return;
    const debug = status.debug;
    const lines = [
      `Video: ${status.videoKey ?? "none"}`,
      `Status: ${status.state}`,
      `Video time: ${formatSeconds(debug?.videoTime ?? 0)}`,
      `Playing: ${debug?.playing ? "yes" : "no"}`,
      `Processing: ${debug?.processingState ?? "IDLE"}`,
      `Stage: ${debug?.stage ?? "none"}`,
      `Task: ${debug?.taskId ?? "none"}`,
      `Progress: ${debug?.progress ?? "unknown"}`,
      `Transcript segments: ${debug?.transcriptCount ?? 0}`,
      `Subtitle segments: ${debug?.subtitleCount ?? 0}`,
      `Task reused: ${debug?.taskReused === undefined ? "unknown" : debug.taskReused ? "yes" : "no"}`,
      `ASR cache: ${formatCacheHit(debug?.asrCacheHit)}`,
      `Translation cache: ${formatCacheHit(debug?.translationCacheHit)}`,
      `Backend error: ${debug?.backendError ?? "none"}`,
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
