import { describe, expect, it } from "vitest";
import {
  getCandidateScore,
  getVisibleAreaRatio,
  selectActiveCandidate,
  type VisibilityViewport,
} from "../src/content/videoDetector";
import type { VideoCandidate } from "../src/content/videoObserver";

const viewport: VisibilityViewport = { width: 1000, height: 800 };

function createVideo(
  rect: Pick<DOMRect, "left" | "top" | "right" | "bottom" | "width" | "height">,
  playing: boolean,
): HTMLVideoElement {
  const video = document.createElement("video");
  Object.defineProperty(video, "paused", { configurable: true, value: !playing });
  Object.defineProperty(video, "ended", { configurable: true, value: false });
  video.getBoundingClientRect = () =>
    ({ ...rect, x: rect.left, y: rect.top, toJSON: () => ({}) }) as DOMRect;
  return video;
}

describe("getVisibleAreaRatio", () => {
  it("returns the visible fraction of a partially clipped video", () => {
    const video = createVideo(
      { left: -500, top: 0, right: 500, bottom: 800, width: 1000, height: 800 },
      false,
    );
    expect(getVisibleAreaRatio(video, viewport)).toBe(0.5);
  });

  it("returns zero for off-screen or zero-sized videos", () => {
    const offscreen = createVideo(
      { left: 1200, top: 0, right: 1600, bottom: 400, width: 400, height: 400 },
      false,
    );
    const zeroSized = createVideo({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }, false);
    expect(getVisibleAreaRatio(offscreen, viewport)).toBe(0);
    expect(getVisibleAreaRatio(zeroSized, viewport)).toBe(0);
  });
});

describe("selectActiveCandidate", () => {
  it("prefers a visible playing video over a paused video", () => {
    const playing = createVideo(
      { left: 0, top: 0, right: 500, bottom: 400, width: 500, height: 400 },
      true,
    );
    const paused = createVideo(
      { left: 0, top: 0, right: 1000, bottom: 800, width: 1000, height: 800 },
      false,
    );
    const candidates: VideoCandidate[] = [
      { element: paused, intersectionRatio: 1 },
      { element: playing, intersectionRatio: 0.5 },
    ];

    expect(selectActiveCandidate(candidates)?.element).toBe(playing);
    expect(getCandidateScore(candidates[1])).toBeGreaterThan(getCandidateScore(candidates[0]));
  });

  it("chooses the most visible video when playback state is equal", () => {
    const first = createVideo(
      { left: -300, top: 0, right: 200, bottom: 400, width: 500, height: 400 },
      true,
    );
    const second = createVideo(
      { left: 0, top: 0, right: 900, bottom: 700, width: 900, height: 700 },
      true,
    );
    expect(
      selectActiveCandidate([
        { element: first, intersectionRatio: 0.4 },
        { element: second, intersectionRatio: 0.9 },
      ])?.element,
    ).toBe(second);
  });
});
