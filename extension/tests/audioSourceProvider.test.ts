import { beforeEach, describe, expect, it } from "vitest";
import {
  AudioSourceResolver,
  DirectVideoSourceProvider,
  PerformanceResourceSourceProvider,
  type ResourceCandidate,
} from "../src/content/audioSourceProvider";

function createVideo(currentSrc: string, src = ""): HTMLVideoElement {
  const video = document.createElement("video");
  Object.defineProperty(video, "currentSrc", { configurable: true, value: currentSrc });
  if (src) video.src = src;
  return video;
}

describe("AudioSourceResolver", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/feed");
  });

  it("prefers an HTTPS currentSrc over performance heuristics", () => {
    const candidates: ResourceCandidate[] = [
      {
        name: "https://v3-web.douyinvod.com/fallback.mp4",
        initiatorType: "video",
        startTime: 20,
        responseEnd: 30,
      },
    ];
    const resolver = new AudioSourceResolver([
      new DirectVideoSourceProvider(),
      new PerformanceResourceSourceProvider(() => candidates, () => 100),
    ]);

    expect(resolver.resolve(createVideo("https://v1.douyinvod.com/direct.mp4")).source).toEqual({
      url: "https://v1.douyinvod.com/direct.mp4",
      provider: "video-element",
      confidence: "direct",
    });
  });

  it("falls back from a blob URL to a likely media performance resource", () => {
    const candidates: ResourceCandidate[] = [
      {
        name: "https://www.douyin.com/app.js",
        initiatorType: "script",
        startTime: 90,
        responseEnd: 100,
      },
      {
        name: "https://v3-web.douyinvod.com/opaque-resource?video_id=123",
        initiatorType: "fetch",
        startTime: 50,
        responseEnd: 60,
      },
    ];
    const resolver = new AudioSourceResolver([
      new DirectVideoSourceProvider(),
      new PerformanceResourceSourceProvider(() => candidates, () => 65),
    ]);

    expect(resolver.resolve(createVideo("blob:https://www.douyin.com/123")).source).toEqual({
      url: "https://v3-web.douyinvod.com/opaque-resource?video_id=123",
      provider: "performance-resource",
      confidence: "heuristic",
    });
  });

  it("fails closed for blob video in the production resolver", () => {
    const resolver = new AudioSourceResolver();

    expect(resolver.resolve(createVideo("blob:https://www.douyin.com/123"))).toMatchObject({
      source: null,
      reason: expect.stringContaining("Blob"),
    });
  });

  it("does not guess from unrelated resources or without a blob source", () => {
    const candidates: ResourceCandidate[] = [
      {
        name: "https://www.douyin.com/api/feed",
        initiatorType: "fetch",
        startTime: 10,
        responseEnd: 20,
      },
    ];
    const provider = new PerformanceResourceSourceProvider(() => candidates, () => 25);
    const resolver = new AudioSourceResolver([new DirectVideoSourceProvider(), provider]);

    expect(resolver.resolve(createVideo("blob:https://www.douyin.com/123"))).toMatchObject({
      source: null,
      reason: expect.stringContaining("Blob"),
    });
    expect(provider.resolve(createVideo(""))).toBeNull();
  });

  it("rejects ambiguous or stale blob resource candidates", () => {
    const candidate = (name: string, responseEnd: number): ResourceCandidate => ({
      name,
      initiatorType: "fetch",
      startTime: responseEnd - 1,
      responseEnd,
    });
    const video = createVideo("blob:https://www.douyin.com/123");
    const ambiguous = new PerformanceResourceSourceProvider(
      () => [
        candidate("https://v1.douyinvod.com/first.mp4", 95),
        candidate("https://v2.douyinvod.com/second.mp4", 96),
      ],
      () => 100,
    );
    const stale = new PerformanceResourceSourceProvider(
      () => [candidate("https://v1.douyinvod.com/old.mp4", 8_400)],
      () => 10_000,
    );

    expect(ambiguous.resolve(video)).toBeNull();
    expect(stale.resolve(video)).toBeNull();
  });

  it("rejects HTTP, non-443, HLS, and DASH sources", () => {
    const provider = new DirectVideoSourceProvider();

    expect(provider.resolve(createVideo("http://v1.douyinvod.com/video.mp4"))).toBeNull();
    expect(provider.resolve(createVideo("https://v1.douyinvod.com:8443/video.mp4"))).toBeNull();
    expect(provider.resolve(createVideo("https://v1.douyinvod.com/master.m3u8?token=abc"))).toBeNull();
    expect(provider.resolve(createVideo("https://v1.douyinvod.com/manifest.mpd"))).toBeNull();
    expect(provider.resolve(createVideo("https://v1.douyinvod.com/live%2Em3u8"))).toBeNull();
    expect(provider.resolve(createVideo("https://v1.douyinvod.com:443/video.mp4"))).toMatchObject({
      url: "https://v1.douyinvod.com/video.mp4",
      confidence: "direct",
    });
  });

  it("rejects a unique recent performance candidate when it is a stream manifest", () => {
    const provider = new PerformanceResourceSourceProvider(
      () => [
        {
          name: "https://v1.douyinvod.com/master.m3u8",
          initiatorType: "video",
          startTime: 99,
          responseEnd: 100,
        },
      ],
      () => 100,
    );

    expect(provider.resolve(createVideo("blob:https://www.douyin.com/123"))).toBeNull();
  });
});
