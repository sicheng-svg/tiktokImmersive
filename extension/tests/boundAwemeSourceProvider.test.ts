import { beforeEach, describe, expect, it } from "vitest";
import { BoundAwemeSourceProvider } from "../src/content/audioSourceProvider";
import { CapturedAwemeSourceRegistry } from "../src/content/capturedAwemeSources";
import { createMediaCaptureMessage } from "../src/shared/awemeMediaCapture";

const FIRST_AWEME_ID = "7382738211234567890";
const SECOND_AWEME_ID = "7382738211234567891";
const FIRST_URL = "https://v1.douyinvod.com/video/first.mp4";

function registryWith(awemeId: string, url: string): CapturedAwemeSourceRegistry {
  const registry = new CapturedAwemeSourceRegistry();
  registry.ingest(createMediaCaptureMessage([{ awemeId, urls: [url] }]));
  return registry;
}

function videoInside(attributes: Record<string, string>): HTMLVideoElement {
  const container = document.createElement("div");
  for (const [name, value] of Object.entries(attributes)) container.setAttribute(name, value);
  const video = document.createElement("video");
  container.append(video);
  document.body.append(container);
  return video;
}

describe("BoundAwemeSourceProvider", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    window.history.replaceState({}, "", "/");
  });

  it("returns a bound source only when DOM id, video key, and registry id are identical", () => {
    const video = videoInside({
      "data-e2e": "feed-active-video",
      "data-e2e-vid": FIRST_AWEME_ID,
    });
    const provider = new BoundAwemeSourceProvider(registryWith(FIRST_AWEME_ID, FIRST_URL));

    expect(provider.resolve(video, FIRST_AWEME_ID)).toEqual({
      url: FIRST_URL,
      provider: "aweme-response",
      confidence: "bound",
    });
  });

  it("rejects every mismatch between the DOM id, video key, and registry", () => {
    const video = videoInside({
      "data-e2e": "feed-active-video",
      "data-e2e-vid": FIRST_AWEME_ID,
    });

    expect(
      new BoundAwemeSourceProvider(registryWith(FIRST_AWEME_ID, FIRST_URL)).resolve(video, SECOND_AWEME_ID),
    ).toBeNull();
    expect(
      new BoundAwemeSourceProvider(registryWith(SECOND_AWEME_ID, FIRST_URL)).resolve(video, FIRST_AWEME_ID),
    ).toBeNull();
    expect(new BoundAwemeSourceProvider(new CapturedAwemeSourceRegistry()).resolve(video, FIRST_AWEME_ID)).toBeNull();
  });

  it("does not upgrade a fallback DOM identity to bound confidence without data-e2e-vid", () => {
    const video = videoInside({ "data-aweme-id": FIRST_AWEME_ID });
    const provider = new BoundAwemeSourceProvider(registryWith(FIRST_AWEME_ID, FIRST_URL));

    expect(provider.resolve(video, FIRST_AWEME_ID)).toBeNull();
  });

  it("does not bind an adjacent video's registry entry", () => {
    const firstVideo = videoInside({
      "data-e2e": "feed-active-video",
      "data-e2e-vid": FIRST_AWEME_ID,
    });
    const secondVideo = videoInside({ "data-e2e-vid": SECOND_AWEME_ID });
    const provider = new BoundAwemeSourceProvider(registryWith(FIRST_AWEME_ID, FIRST_URL));

    expect(provider.resolve(firstVideo, FIRST_AWEME_ID)).not.toBeNull();
    expect(provider.resolve(secondVideo, SECOND_AWEME_ID)).toBeNull();
  });

  it("returns retained alternate CDN URLs for a certified nested binding", () => {
    const outer = document.createElement("div");
    outer.dataset.e2e = "feed-active-video";
    const inner = document.createElement("div");
    inner.dataset.e2eVid = FIRST_AWEME_ID;
    const video = document.createElement("video");
    inner.append(video);
    outer.append(inner);
    document.body.append(outer);

    const registry = new CapturedAwemeSourceRegistry();
    registry.ingest(
      createMediaCaptureMessage([
        {
          awemeId: FIRST_AWEME_ID,
          urls: [FIRST_URL, "https://v2.douyinvod.com/video/backup.mp4"],
        },
      ]),
    );

    expect(new BoundAwemeSourceProvider(registry).resolve(video, FIRST_AWEME_ID)).toEqual({
      url: FIRST_URL,
      fallbackUrls: ["https://v2.douyinvod.com/video/backup.mp4"],
      provider: "aweme-response",
      confidence: "bound",
    });
  });
});
