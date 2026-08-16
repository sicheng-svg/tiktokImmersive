import { describe, expect, it } from "vitest";
import {
  hasVideoProcessingType,
  isTrustedDouyinSender,
  isVideoProcessingMessage,
} from "../src/background/requestValidation";

describe("background proxy validation", () => {
  it("accepts only HTTPS Douyin content tabs", () => {
    expect(isTrustedDouyinSender({ tab: { url: "https://www.douyin.com/user/test" } })).toBe(true);
    expect(isTrustedDouyinSender({ tab: { url: "https://evil.example/?next=douyin.com" } })).toBe(false);
    expect(isTrustedDouyinSender({ tab: { url: "http://www.douyin.com/" } })).toBe(false);
    expect(isTrustedDouyinSender({})).toBe(false);
  });

  it("strictly validates processing messages and media URLs", () => {
    expect(
      isVideoProcessingMessage({
        type: "PROCESS_VIDEO_SOURCE",
        payload: { videoKey: "url:abc_123", videoUrl: "https://media.example/video.mp4" },
      }),
    ).toBe(true);
    expect(
      isVideoProcessingMessage({
        type: "PROCESS_VIDEO_SOURCE",
        payload: { videoKey: "../../bad", videoUrl: "file:///secret" },
      }),
    ).toBe(false);
    expect(isVideoProcessingMessage({ type: "GET_VIDEO_TASK", taskId: "task/../../bad" })).toBe(false);
    expect(hasVideoProcessingType({ type: "SETTINGS_UPDATED" })).toBe(false);
  });

  it("accepts only HTTPS port 443 media files and rejects stream manifests", () => {
    const message = (videoUrl: string) => ({
      type: "PROCESS_VIDEO_SOURCE",
      payload: { videoKey: "video-1", videoUrl },
    });

    expect(isVideoProcessingMessage(message("https://media.example/video.mp4"))).toBe(true);
    expect(isVideoProcessingMessage(message("https://media.example:443/video.mp4"))).toBe(true);
    expect(isVideoProcessingMessage(message("http://media.example/video.mp4"))).toBe(false);
    expect(isVideoProcessingMessage(message("https://media.example:8443/video.mp4"))).toBe(false);
    expect(isVideoProcessingMessage(message("https://media.example/master.m3u8?token=abc"))).toBe(false);
    expect(isVideoProcessingMessage(message("https://media.example/manifest.mpd"))).toBe(false);
    expect(isVideoProcessingMessage(message("https://media.example/live%2Em3u8"))).toBe(false);
  });
});
