import { beforeEach, describe, expect, it } from "vitest";
import { findAwemeId, VideoKeyFactory } from "../src/content/videoKey";

describe("VideoKeyFactory", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    window.history.replaceState({}, "", "/");
  });

  it("uses the Douyin work id from a nearby link", async () => {
    const anchor = document.createElement("a");
    anchor.href = "https://www.douyin.com/video/7382738211234567890";
    const video = document.createElement("video");
    anchor.append(video);
    document.body.append(anchor);

    await expect(new VideoKeyFactory().getKey(video)).resolves.toBe("7382738211234567890");
  });

  it("keeps a session key stable for the same anonymous element", async () => {
    const video = document.createElement("video");
    document.body.append(video);
    const factory = new VideoKeyFactory();

    const first = await factory.getKey(video);
    const second = await factory.getKey(video);
    expect(first).toMatch(/^element:/);
    expect(second).toBe(first);
  });

  it("does not borrow a work id from a shared ancestor", () => {
    window.history.replaceState({}, "", "/video/9999999999999999999");
    const firstLink = document.createElement("a");
    firstLink.href = "https://www.douyin.com/video/7382738211234567890";
    const first = document.createElement("video");
    const second = document.createElement("video");
    firstLink.append(first);
    document.body.append(firstLink, second);

    expect(findAwemeId(first)).toBe("7382738211234567890");
    expect(findAwemeId(second)).toBeNull();
  });

  it("uses the page work id only when it unambiguously describes one video", () => {
    window.history.replaceState({}, "", "/video/8888888888888888888");
    const onlyVideo = document.createElement("video");
    document.body.append(onlyVideo);
    expect(findAwemeId(onlyVideo)).toBe("8888888888888888888");

    document.body.append(document.createElement("video"));
    expect(findAwemeId(onlyVideo)).toBeNull();
  });
});
