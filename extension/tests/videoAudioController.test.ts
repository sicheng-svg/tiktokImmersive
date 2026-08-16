import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../src/services/storage";
import type { DubPlayback } from "../src/content/dubPlayer";
import { VideoAudioController, type MockPlaybackStatus } from "../src/content/videoAudioController";
import type { ActiveVideo } from "../src/content/videoDetector";

class FakeDub implements DubPlayback {
  calls: string[] = [];
  currentTime = 0;
  duration = 10;
  playQueue: Array<Promise<void>> = [];

  load(sourceUrl: string): void {
    this.calls.push(`load:${sourceUrl}`);
  }

  play(videoTime: number, playbackRate: number): Promise<void> {
    this.currentTime = videoTime % this.duration;
    this.calls.push(`play:${videoTime}:${playbackRate}`);
    return this.playQueue.shift() ?? Promise.resolve();
  }

  pause(): void {
    this.calls.push("pause");
  }

  seek(videoTime: number, force = false): void {
    this.currentTime = videoTime % this.duration;
    this.calls.push(`seek:${videoTime}:${force}`);
  }

  setPlaybackRate(playbackRate: number): void {
    this.calls.push(`rate:${playbackRate}`);
  }

  stop(): void {
    this.calls.push("stop");
  }

  getCurrentTime(): number {
    return this.currentTime;
  }

  getDuration(): number {
    return this.duration;
  }
}

function createActiveVideo(videoKey: string, initialPaused = false): ActiveVideo & { setPaused(value: boolean): void } {
  const element = document.createElement("video");
  let paused = initialPaused;
  Object.defineProperty(element, "paused", { configurable: true, get: () => paused });
  Object.defineProperty(element, "ended", { configurable: true, value: false });
  element.currentTime = 4;
  element.playbackRate = 1;
  return {
    element,
    videoKey,
    currentTime: element.currentTime,
    playing: !paused,
    setPaused: (value: boolean) => {
      paused = value;
    },
  };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("VideoAudioController", () => {
  it("restores the old video before attaching the next video", async () => {
    const dub = new FakeDub();
    const statuses: MockPlaybackStatus[] = [];
    const controller = new VideoAudioController(
      dub,
      "chrome-extension://test/audio/test.mp3",
      { ...DEFAULT_SETTINGS, enabled: true },
      (status) => statuses.push(status),
    );
    const first = createActiveVideo("A");
    first.element.muted = false;
    first.element.volume = 0.6;
    const second = createActiveVideo("B");
    second.element.muted = true;
    second.element.volume = 0.25;

    controller.setActiveVideo(first);
    await flushPromises();
    expect(first.element.muted).toBe(true);

    controller.setActiveVideo(second);
    await flushPromises();
    expect(first.element.muted).toBe(false);
    expect(first.element.volume).toBe(0.6);
    expect(second.element.muted).toBe(true);

    controller.updateSettings({ ...DEFAULT_SETTINGS, enabled: false });
    expect(second.element.muted).toBe(true);
    expect(second.element.volume).toBe(0.25);
    expect(statuses.at(-1)?.state).toBe("IDLE");
  });

  it("mirrors pause, resume, seek and playback-rate events", async () => {
    const dub = new FakeDub();
    const controller = new VideoAudioController(
      dub,
      "mock.mp3",
      { ...DEFAULT_SETTINGS, enabled: true, playbackRate: 1.15 },
      vi.fn(),
    );
    const active = createActiveVideo("A");
    controller.setActiveVideo(active);
    await flushPromises();

    active.setPaused(true);
    active.element.dispatchEvent(new Event("pause"));
    active.element.currentTime = 18;
    active.element.dispatchEvent(new Event("seeked"));
    active.element.playbackRate = 1.5;
    active.element.dispatchEvent(new Event("ratechange"));
    active.setPaused(false);
    active.element.dispatchEvent(new Event("play"));
    await flushPromises();

    expect(dub.calls).toContain("pause");
    expect(dub.calls).toContain("seek:18:true");
    expect(dub.calls).toContain("rate:1.7249999999999999");
    expect(dub.calls.filter((call) => call.startsWith("play:"))).toHaveLength(2);
  });

  it("restores original audio when mock playback is rejected", async () => {
    const dub = new FakeDub();
    dub.playQueue.push(Promise.reject(new Error("autoplay blocked")));
    const statuses: MockPlaybackStatus[] = [];
    const controller = new VideoAudioController(
      dub,
      "mock.mp3",
      { ...DEFAULT_SETTINGS, enabled: true },
      (status) => statuses.push(status),
    );
    const active = createActiveVideo("A");
    active.element.muted = false;
    active.element.volume = 0.7;

    controller.setActiveVideo(active);
    await flushPromises();

    expect(active.element.muted).toBe(false);
    expect(active.element.volume).toBe(0.7);
    expect(statuses.at(-1)).toMatchObject({ state: "ERROR", message: "English audio unavailable" });
  });

  it("does not stop the new dub when an old play promise resolves late", async () => {
    let resolveOld!: () => void;
    const oldPlay = new Promise<void>((resolve) => {
      resolveOld = resolve;
    });
    const dub = new FakeDub();
    dub.playQueue.push(oldPlay, Promise.resolve());
    const controller = new VideoAudioController(
      dub,
      "mock.mp3",
      { ...DEFAULT_SETTINGS, enabled: true },
      vi.fn(),
    );

    controller.setActiveVideo(createActiveVideo("A"));
    controller.setActiveVideo(createActiveVideo("B"));
    await flushPromises();
    const stopsBeforeOldResolution = dub.calls.filter((call) => call === "stop").length;

    resolveOld();
    await flushPromises();
    expect(dub.calls.filter((call) => call === "stop")).toHaveLength(stopsBeforeOldResolution);
  });

  it("does not publish PLAYING when a pending play finishes after pause", async () => {
    let resolvePlay!: () => void;
    const pendingPlay = new Promise<void>((resolve) => {
      resolvePlay = resolve;
    });
    const dub = new FakeDub();
    dub.playQueue.push(pendingPlay);
    const statuses: MockPlaybackStatus[] = [];
    const controller = new VideoAudioController(
      dub,
      "mock.mp3",
      { ...DEFAULT_SETTINGS, enabled: true },
      (status) => statuses.push(status),
    );
    const active = createActiveVideo("A");

    controller.setActiveVideo(active);
    active.setPaused(true);
    active.element.dispatchEvent(new Event("pause"));
    resolvePlay();
    await flushPromises();

    expect(statuses.at(-1)).toMatchObject({ state: "READY", message: "Mock English audio paused" });
    expect(statuses.some((status) => status.state === "ERROR")).toBe(false);
  });

  it("accepts resume while the previous play attempt is still pending", async () => {
    let rejectOld!: (reason: Error) => void;
    const oldPlay = new Promise<void>((_resolve, reject) => {
      rejectOld = reject;
    });
    const dub = new FakeDub();
    dub.playQueue.push(oldPlay, Promise.resolve());
    const statuses: MockPlaybackStatus[] = [];
    const controller = new VideoAudioController(
      dub,
      "mock.mp3",
      { ...DEFAULT_SETTINGS, enabled: true },
      (status) => statuses.push(status),
    );
    const active = createActiveVideo("A");

    controller.setActiveVideo(active);
    active.setPaused(true);
    active.element.dispatchEvent(new Event("pause"));
    active.setPaused(false);
    active.element.dispatchEvent(new Event("play"));
    await flushPromises();
    rejectOld(new Error("old attempt aborted"));
    await flushPromises();

    expect(dub.calls.filter((call) => call.startsWith("play:"))).toHaveLength(2);
    expect(statuses.at(-1)?.state).toBe("PLAYING");
    expect(statuses.some((status) => status.state === "ERROR")).toBe(false);
  });
});
