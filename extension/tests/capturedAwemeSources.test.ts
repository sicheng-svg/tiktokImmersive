import { describe, expect, it, vi } from "vitest";
import {
  CapturedAwemeSourceRegistry,
  getCapturedAwemeSourceRegistry,
  installCapturedAwemeSourceBridge,
} from "../src/content/capturedAwemeSources";
import {
  MAX_CAPTURED_MAPPINGS,
  MAX_CAPTURED_URLS_PER_AWEME,
  MEDIA_CAPTURE_MESSAGE_SOURCE,
  MEDIA_CAPTURE_MESSAGE_TYPE,
  MEDIA_CAPTURE_MESSAGE_VERSION,
  type MediaCaptureMessage,
} from "../src/shared/awemeMediaCapture";

const FIRST_AWEME_ID = "7382738211234567890";
const SECOND_AWEME_ID = "7382738211234567891";
const THIRD_AWEME_ID = "7382738211234567892";

function message(
  mappings: MediaCaptureMessage["mappings"],
  overrides: Partial<MediaCaptureMessage> = {},
): MediaCaptureMessage {
  return {
    source: MEDIA_CAPTURE_MESSAGE_SOURCE,
    type: MEDIA_CAPTURE_MESSAGE_TYPE,
    version: MEDIA_CAPTURE_MESSAGE_VERSION,
    mappings,
    ...overrides,
  };
}

function mapping(awemeId: string, url: string): MediaCaptureMessage["mappings"][number] {
  return { awemeId, urls: [url] };
}

describe("CapturedAwemeSourceRegistry", () => {
  it("accepts only the current capture message source, type, and version", () => {
    const registry = new CapturedAwemeSourceRegistry();
    const validMapping = mapping(FIRST_AWEME_ID, "https://v1.douyinvod.com/video/first.mp4");

    expect(registry.ingest(message([validMapping], { source: "other" as MediaCaptureMessage["source"] }))).toEqual(
      new Set(),
    );
    expect(registry.ingest(message([validMapping], { type: "OTHER" as MediaCaptureMessage["type"] }))).toEqual(
      new Set(),
    );
    expect(registry.ingest(message([validMapping], { version: 2 as MediaCaptureMessage["version"] }))).toEqual(
      new Set(),
    );
    expect(registry.get(FIRST_AWEME_ID)).toBeNull();

    expect(registry.ingest(message([validMapping]))).toEqual(new Set([FIRST_AWEME_ID]));
  });

  it("rejects a non-string aweme id without coercing the value", () => {
    const registry = new CapturedAwemeSourceRegistry();
    const maliciousId = { toString: vi.fn(() => FIRST_AWEME_ID) };
    const maliciousMapping = {
      awemeId: maliciousId,
      urls: ["https://v1.douyinvod.com/video/first.mp4"],
    } as unknown as MediaCaptureMessage["mappings"][number];

    expect(registry.ingest(message([maliciousMapping]))).toEqual(new Set());
    expect(maliciousId.toString).not.toHaveBeenCalled();
  });

  it("rejects foreign and lookalike domains while accepting an allowlisted media host", () => {
    const registry = new CapturedAwemeSourceRegistry();
    registry.ingest(
      message([
        mapping(FIRST_AWEME_ID, "https://media.example.com/video/foreign.mp4"),
        mapping(SECOND_AWEME_ID, "https://evil-douyinvod.com/video/lookalike.mp4"),
        mapping(THIRD_AWEME_ID, "https://v3.douyinvod.com/video/allowed.mp4"),
      ]),
    );

    expect(registry.get(FIRST_AWEME_ID)).toBeNull();
    expect(registry.get(SECOND_AWEME_ID)).toBeNull();
    expect(registry.get(THIRD_AWEME_ID)).toBe("https://v3.douyinvod.com/video/allowed.mp4");
  });

  it("rejects an image URL even when a same-origin page message uses an allowlisted host", () => {
    const registry = new CapturedAwemeSourceRegistry();
    expect(
      registry.ingest(message([mapping(FIRST_AWEME_ID, "https://v1.douyinvod.com/cover.jpg?token=one")])),
    ).toEqual(new Set());
    expect(registry.get(FIRST_AWEME_ID)).toBeNull();
  });

  it("retains unique normalized backup media URLs in capture order", () => {
    const registry = new CapturedAwemeSourceRegistry();
    registry.ingest(
      message([
        {
          awemeId: FIRST_AWEME_ID,
          urls: [
            "https://v1.douyinvod.com/video/primary.mp4",
            "https://v2.douyinvod.com/video/backup.mp4",
            "https://v1.douyinvod.com/video/primary.mp4",
            "https://v3.douyinvod.com/cover.jpg",
          ],
        },
      ]),
    );

    expect(registry.getCandidates(FIRST_AWEME_ID)).toEqual([
      "https://v1.douyinvod.com/video/primary.mp4",
      "https://v2.douyinvod.com/video/backup.mp4",
    ]);
  });

  it("expires entries after the configured TTL", () => {
    let now = 1_000;
    const registry = new CapturedAwemeSourceRegistry(() => now, 100, 5);
    registry.ingest(message([mapping(FIRST_AWEME_ID, "https://v1.douyinvod.com/video/first.mp4")]));

    now = 1_100;
    expect(registry.get(FIRST_AWEME_ID)).not.toBeNull();
    now = 1_101;
    expect(registry.get(FIRST_AWEME_ID)).toBeNull();
  });

  it("rejects oversized messages and evicts the oldest retained entry at capacity", () => {
    const registry = new CapturedAwemeSourceRegistry(() => 1_000, 10_000, 2);
    const oversized = Array.from({ length: MAX_CAPTURED_MAPPINGS + 1 }, (_, index) =>
      mapping(
        `73827382112345${String(index).padStart(5, "0")}`,
        `https://v1.douyinvod.com/video/${index}.mp4`,
      ),
    );
    expect(registry.ingest(message(oversized))).toEqual(new Set());
    expect(
      registry.ingest(
        message([
          {
            awemeId: FIRST_AWEME_ID,
            urls: Array.from(
              { length: MAX_CAPTURED_URLS_PER_AWEME + 1 },
              (_, index) => `https://v1.douyinvod.com/video/oversized-${index}.mp4`,
            ),
          },
        ]),
      ),
    ).toEqual(new Set());

    registry.ingest(
      message([
        mapping(FIRST_AWEME_ID, "https://v1.douyinvod.com/video/first.mp4"),
        mapping(SECOND_AWEME_ID, "https://v1.douyinvod.com/video/second.mp4"),
        mapping(THIRD_AWEME_ID, "https://v1.douyinvod.com/video/third.mp4"),
      ]),
    );
    expect(registry.get(FIRST_AWEME_ID)).toBeNull();
    expect(registry.get(SECOND_AWEME_ID)).not.toBeNull();
    expect(registry.get(THIRD_AWEME_ID)).not.toBeNull();
  });

  it("deduplicates an aweme id, refreshes its TTL, and publishes a changed signed URL", () => {
    let now = 1_000;
    const registry = new CapturedAwemeSourceRegistry(() => now, 100, 5);
    const listener = vi.fn();
    registry.subscribe(listener);
    registry.ingest(message([mapping(FIRST_AWEME_ID, "https://v1.douyinvod.com/video/first.mp4")]));

    now = 1_090;
    expect(
      registry.ingest(message([mapping(FIRST_AWEME_ID, "https://v2.douyinvod.com/video/replacement.mp4")])),
    ).toEqual(new Set([FIRST_AWEME_ID]));
    expect(registry.get(FIRST_AWEME_ID)).toBe("https://v2.douyinvod.com/video/replacement.mp4");
    expect(listener).toHaveBeenCalledTimes(2);

    now = 1_150;
    expect(registry.get(FIRST_AWEME_ID)).not.toBeNull();
    now = 1_191;
    expect(registry.get(FIRST_AWEME_ID)).toBeNull();
  });

  it("evicts the least recently observed entry rather than the first inserted entry", () => {
    let now = 1_000;
    const registry = new CapturedAwemeSourceRegistry(() => now, 10_000, 2);
    registry.ingest(message([mapping(FIRST_AWEME_ID, "https://v1.douyinvod.com/video/first.mp4")]));
    now = 1_001;
    registry.ingest(message([mapping(SECOND_AWEME_ID, "https://v1.douyinvod.com/video/second.mp4")]));
    now = 1_002;
    registry.ingest(message([mapping(FIRST_AWEME_ID, "https://v1.douyinvod.com/video/first.mp4")]));
    now = 1_003;
    registry.ingest(message([mapping(THIRD_AWEME_ID, "https://v1.douyinvod.com/video/third.mp4")]));

    expect(registry.get(FIRST_AWEME_ID)).not.toBeNull();
    expect(registry.get(SECOND_AWEME_ID)).toBeNull();
    expect(registry.get(THIRD_AWEME_ID)).not.toBeNull();
  });
});

describe("installCapturedAwemeSourceBridge", () => {
  it("ignores capture messages from a foreign origin", () => {
    const bridgeAwemeId = "7382738211234567999";
    const bridgeMessage = message([
      mapping(bridgeAwemeId, "https://v1.douyinvod.com/video/bridge.mp4"),
    ]);
    const registry = getCapturedAwemeSourceRegistry();
    installCapturedAwemeSourceBridge();

    window.dispatchEvent(
      new MessageEvent("message", {
        data: bridgeMessage,
        origin: "https://attacker.example",
        source: window,
      }),
    );
    expect(registry.get(bridgeAwemeId)).toBeNull();

    window.dispatchEvent(
      new MessageEvent("message", {
        data: bridgeMessage,
        origin: window.location.origin,
        source: window,
      }),
    );
    expect(registry.get(bridgeAwemeId)).toBe("https://v1.douyinvod.com/video/bridge.mp4");
  });
});
