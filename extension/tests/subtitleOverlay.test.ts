import { afterEach, describe, expect, it, vi } from "vitest";
import { findActiveCue, SubtitleOverlay } from "../src/content/subtitleOverlay";
import type { ActiveVideo } from "../src/content/videoDetector";

function activeVideo(video: HTMLVideoElement, videoKey = "video-1", boundAwemeId: string | null = null): ActiveVideo {
  return { element: video, videoKey, boundAwemeId, currentTime: video.currentTime, playing: false };
}

function createVisibleVideo(left = 100): HTMLVideoElement {
  const video = document.createElement("video");
  video.getBoundingClientRect = () =>
    ({ left, top: 50, right: left + 600, bottom: 450, width: 600, height: 400, x: left, y: 50, toJSON() {} }) as DOMRect;
  document.body.append(video);
  return video;
}

function overlayElements(): {
  host: HTMLDivElement;
  panel: HTMLDivElement;
  primary: HTMLDivElement;
  secondary: HTMLDivElement;
} {
  const host = document.querySelector<HTMLDivElement>("#douyin-english-subtitle-overlay");
  const panel = host?.shadowRoot?.querySelector<HTMLDivElement>(".panel");
  const primary = host?.shadowRoot?.querySelector<HTMLDivElement>(".primary");
  const secondary = host?.shadowRoot?.querySelector<HTMLDivElement>(".secondary");
  if (!host || !panel || !primary || !secondary) throw new Error("Overlay was not mounted");
  return { host, panel, primary, secondary };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  Object.defineProperty(document, "fullscreenElement", { configurable: true, value: null });
  document.body.replaceChildren();
  document.querySelector("#douyin-english-subtitle-overlay")?.remove();
});

describe("findActiveCue", () => {
  it("uses start <= t < end and chooses the active cue with the latest start", () => {
    const cues = [
      { start: 0, end: 10, text: "long" },
      { start: 5, end: 6, text: "latest" },
    ];

    expect(findActiveCue(cues, 0)?.text).toBe("long");
    expect(findActiveCue(cues, 5.5)?.text).toBe("latest");
    expect(findActiveCue(cues, 6)?.text).toBe("long");
    expect(findActiveCue(cues, 10)).toBeUndefined();
  });
});

describe("SubtitleOverlay", () => {
  it("renders provider strings only as text and supports bilingual, English, and off modes", () => {
    const overlay = new SubtitleOverlay();
    const video = createVisibleVideo();
    video.currentTime = 0.5;
    overlay.setActiveVideo(activeVideo(video));
    overlay.setMode("bilingual");
    overlay.showSubtitles([
      {
        segmentId: "s000001",
        start: 0,
        end: 1,
        zh: "<img src=x onerror=alert(1)>中文",
        en: "<script>unsafe()</script>",
      },
    ]);

    const { host, panel, primary, secondary } = overlayElements();
    expect(primary.textContent).toBe("<script>unsafe()</script>");
    expect(secondary.textContent).toBe("<img src=x onerror=alert(1)>中文");
    expect(host.shadowRoot?.querySelector("script")).toBeNull();
    expect(host.shadowRoot?.querySelector("img")).toBeNull();
    expect(host.style.pointerEvents).toBe("none");
    expect(panel.style.display).toBe("block");

    overlay.setMode("english");
    expect(primary.textContent).toBe("<script>unsafe()</script>");
    expect(secondary.textContent).toBe("");

    overlay.setMode("off");
    expect(panel.style.display).toBe("none");
    overlay.stop();
  });

  it("shows a Chinese fallback only in bilingual mode", () => {
    const overlay = new SubtitleOverlay();
    const video = createVisibleVideo();
    video.currentTime = 0.5;
    overlay.setActiveVideo(activeVideo(video));
    overlay.setMode("bilingual");
    overlay.showTranscript([{ segmentId: "s000001", start: 0, end: 1, text: "翻译失败但中文可用" }]);

    const { panel, primary, secondary } = overlayElements();
    expect(panel.style.display).toBe("block");
    expect(primary.textContent).toBe("翻译失败但中文可用");
    expect(secondary.textContent).toBe("");

    overlay.setMode("english");
    expect(panel.style.display).toBe("none");
    overlay.setMode("off");
    expect(panel.style.display).toBe("none");
    overlay.stop();
  });

  it("never loads audio or changes the original video's playback properties", () => {
    const overlay = new SubtitleOverlay();
    const video = createVisibleVideo();
    const load = vi.fn();
    const play = vi.fn().mockResolvedValue(undefined);
    video.load = load;
    video.play = play;
    video.muted = false;
    video.volume = 0.37;
    video.playbackRate = 1.25;
    video.currentTime = 0.5;

    overlay.setActiveVideo(activeVideo(video));
    overlay.setMode("bilingual");
    overlay.showSubtitles([{ segmentId: "s000001", start: 0, end: 1, zh: "原声", en: "Original audio" }]);
    video.dispatchEvent(new Event("play"));
    video.dispatchEvent(new Event("pause"));

    expect(load).not.toHaveBeenCalled();
    expect(play).not.toHaveBeenCalled();
    expect(video.muted).toBe(false);
    expect(video.volume).toBe(0.37);
    expect(video.playbackRate).toBe(1.25);
    overlay.stop();
  });

  it("refreshes continuously, responds to seek, and clears immediately on emptied", () => {
    vi.useFakeTimers();
    const overlay = new SubtitleOverlay();
    const video = createVisibleVideo();
    video.currentTime = 0.5;
    overlay.setActiveVideo(activeVideo(video));
    overlay.setMode("english");
    overlay.showSubtitles([
      { segmentId: "s000001", start: 0, end: 1, zh: "一", en: "One" },
      { segmentId: "s000002", start: 1, end: 2, zh: "二", en: "Two" },
    ]);
    const { panel, primary } = overlayElements();
    expect(primary.textContent).toBe("One");

    video.currentTime = 1.25;
    vi.advanceTimersByTime(200);
    expect(primary.textContent).toBe("Two");
    video.currentTime = 0.25;
    video.dispatchEvent(new Event("seeked"));
    expect(primary.textContent).toBe("One");

    video.dispatchEvent(new Event("emptied"));
    expect(panel.style.display).toBe("none");
    video.dispatchEvent(new Event("play"));
    expect(panel.style.display).toBe("none");
    overlay.stop();
  });

  it("clears on a reused-video identity change and cancels frame callbacks", () => {
    const overlay = new SubtitleOverlay();
    const video = createVisibleVideo();
    const cancelFrame = vi.fn();
    Object.assign(video, {
      requestVideoFrameCallback: vi.fn(() => 42),
      cancelVideoFrameCallback: cancelFrame,
    });
    video.currentTime = 0.5;
    overlay.setActiveVideo(activeVideo(video, "same-key", "old-binding"));
    overlay.setMode("english");
    overlay.showSubtitles([{ segmentId: "s000001", start: 0, end: 1, zh: "旧", en: "Old" }]);
    expect(overlayElements().panel.style.display).toBe("block");

    overlay.setActiveVideo(activeVideo(video, "same-key", "new-binding"));
    expect(overlayElements().panel.style.display).toBe("none");
    expect(cancelFrame).toHaveBeenCalledWith(42);
    overlay.stop();
  });

  it("runs frame callbacks only while visible cues are enabled and cancels stale callbacks", () => {
    const overlay = new SubtitleOverlay();
    const video = createVisibleVideo();
    const callbacks: Array<(now: number, metadata: unknown) => void> = [];
    const requestFrame = vi.fn((callback: (now: number, metadata: unknown) => void) => {
      callbacks.push(callback);
      return callbacks.length;
    });
    const cancelFrame = vi.fn();
    Object.assign(video, {
      requestVideoFrameCallback: requestFrame,
      cancelVideoFrameCallback: cancelFrame,
    });
    overlay.setActiveVideo(activeVideo(video));
    expect(requestFrame).not.toHaveBeenCalled();

    overlay.showSubtitles([{ segmentId: "s000001", start: 0, end: 1, zh: "中", en: "English" }]);
    expect(requestFrame).not.toHaveBeenCalled();
    overlay.setMode("english");
    expect(requestFrame).toHaveBeenCalledTimes(1);

    overlay.setMode("off");
    expect(cancelFrame).toHaveBeenCalledWith(1);
    callbacks[0](0, {});
    expect(requestFrame).toHaveBeenCalledTimes(1);

    overlay.setMode("bilingual");
    expect(requestFrame).toHaveBeenCalledTimes(2);
    overlay.clearCues();
    expect(cancelFrame).toHaveBeenCalledWith(2);

    overlay.showSubtitles([{ segmentId: "s000001", start: 0, end: 1, zh: "再", en: "Again" }]);
    expect(requestFrame).toHaveBeenCalledTimes(3);
    overlay.stop();
    expect(cancelFrame).toHaveBeenCalledWith(3);
  });

  it("creates and clears the fallback interval only when cues can be shown", () => {
    vi.useFakeTimers();
    const setIntervalSpy = vi.spyOn(window, "setInterval");
    const clearIntervalSpy = vi.spyOn(window, "clearInterval");
    const overlay = new SubtitleOverlay();
    const video = createVisibleVideo();
    overlay.setActiveVideo(activeVideo(video));
    overlay.setMode("bilingual");
    expect(setIntervalSpy).not.toHaveBeenCalled();

    overlay.showTranscript([{ segmentId: "s000001", start: 0, end: 1, text: "中文" }]);
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    overlay.setMode("off");
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);

    overlay.setMode("bilingual");
    expect(setIntervalSpy).toHaveBeenCalledTimes(2);
    overlay.clearCues();
    expect(clearIntervalSpy).toHaveBeenCalledTimes(2);
    overlay.stop();
  });

  it("uses a native TextTrack when the video element itself is fullscreen", () => {
    class FakeCue {
      id = "";

      constructor(
        readonly startTime: number,
        readonly endTime: number,
        readonly text: string,
      ) {}
    }
    const nativeCues: FakeCue[] = [];
    const track = {
      mode: "disabled",
      get cues() {
        return nativeCues;
      },
      addCue: vi.fn((cue: FakeCue) => nativeCues.push(cue)),
      removeCue: vi.fn((cue: FakeCue) => {
        const index = nativeCues.indexOf(cue);
        if (index >= 0) nativeCues.splice(index, 1);
      }),
    } as unknown as TextTrack;
    vi.stubGlobal("VTTCue", FakeCue);

    const overlay = new SubtitleOverlay();
    const video = createVisibleVideo();
    video.currentTime = 0.5;
    const addTextTrack = vi.fn(() => track);
    Object.defineProperty(video, "addTextTrack", { configurable: true, value: addTextTrack });
    Object.defineProperty(document, "fullscreenElement", { configurable: true, value: video });
    overlay.setActiveVideo(activeVideo(video));
    overlay.setMode("bilingual");
    overlay.showSubtitles([
      { segmentId: "s000001", start: 0, end: 10, zh: "<b>中文</b>", en: "<i>English</i>" },
      { segmentId: "s000002", start: 5, end: 6, zh: "乙", en: "Latest" },
    ]);

    const { host, panel } = overlayElements();
    expect(host.parentElement).toBe(document.documentElement);
    expect(panel.style.display).toBe("none");
    expect(addTextTrack).toHaveBeenCalledTimes(1);
    expect(track.mode).toBe("showing");
    expect(nativeCues.map((cue) => [cue.startTime, cue.endTime, cue.text])).toEqual([
      [0, 5, "&lt;i&gt;English&lt;/i&gt;\n&lt;b&gt;中文&lt;/b&gt;"],
      [5, 6, "Latest\n乙"],
      [6, 10, "&lt;i&gt;English&lt;/i&gt;\n&lt;b&gt;中文&lt;/b&gt;"],
    ]);

    overlay.setMode("english");
    expect(nativeCues.map((cue) => cue.text)).toEqual([
      "&lt;i&gt;English&lt;/i&gt;",
      "Latest",
      "&lt;i&gt;English&lt;/i&gt;",
    ]);
    overlay.showTranscript([{ segmentId: "s000001", start: 0, end: 10, text: "中文降级" }]);
    expect(track.mode).toBe("disabled");
    expect(nativeCues).toEqual([]);
    overlay.setMode("bilingual");
    expect(track.mode).toBe("showing");
    expect(nativeCues.map((cue) => cue.text)).toEqual(["中文降级"]);

    Object.defineProperty(document, "fullscreenElement", { configurable: true, value: null });
    document.dispatchEvent(new Event("fullscreenchange"));
    expect(track.mode).toBe("disabled");
    expect(nativeCues).toEqual([]);
    expect(panel.style.display).toBe("block");
    overlay.stop();
  });

  it("follows resize/fullscreen changes and never re-shows an offscreen video", () => {
    const overlay = new SubtitleOverlay();
    const fullscreenContainer = document.createElement("div");
    const video = createVisibleVideo(80);
    fullscreenContainer.append(video);
    document.body.append(fullscreenContainer);
    video.currentTime = 0.5;
    overlay.setActiveVideo(activeVideo(video));
    overlay.setMode("english");
    overlay.showSubtitles([{ segmentId: "s000001", start: 0, end: 1, zh: "中", en: "Visible" }]);
    const { host, panel } = overlayElements();
    expect(panel.style.left).toBe("380px");

    video.getBoundingClientRect = () =>
      ({ left: 200, top: 50, right: 800, bottom: 450, width: 600, height: 400, x: 200, y: 50, toJSON() {} }) as DOMRect;
    window.dispatchEvent(new Event("resize"));
    expect(panel.style.left).toBe("500px");

    Object.defineProperty(document, "fullscreenElement", { configurable: true, value: fullscreenContainer });
    document.dispatchEvent(new Event("fullscreenchange"));
    expect(host.parentElement).toBe(fullscreenContainer);

    video.getBoundingClientRect = () =>
      ({ left: 0, top: 900, right: 600, bottom: 1300, width: 600, height: 400, x: 0, y: 900, toJSON() {} }) as DOMRect;
    window.dispatchEvent(new Event("scroll"));
    video.dispatchEvent(new Event("pause"));
    expect(panel.style.display).toBe("none");

    video.getBoundingClientRect = () =>
      ({ left: 240, top: 40, right: 840, bottom: 440, width: 600, height: 400, x: 240, y: 40, toJSON() {} }) as DOMRect;
    window.dispatchEvent(new Event("scroll"));
    expect(panel.style.display).toBe("block");
    expect(panel.style.left).toBe("540px");
    overlay.stop();
  });
});
