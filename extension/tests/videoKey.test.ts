import { beforeEach, describe, expect, it } from "vitest";
import { findActiveFeedAwemeId, findAwemeId, VideoKeyFactory } from "../src/content/videoKey";

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

  it("binds an active marker and data-e2e-vid on adjacent nested ancestors", () => {
    const outerMarker = document.createElement("div");
    outerMarker.dataset.e2e = "feed-active-video";
    const innerId = document.createElement("div");
    innerId.dataset.e2eVid = "7382738211234567890";
    const firstVideo = document.createElement("video");
    innerId.append(firstVideo);
    outerMarker.append(innerId);
    document.body.append(outerMarker);

    const outerId = document.createElement("div");
    outerId.dataset.e2eVid = "7382738211234567891";
    const innerMarker = document.createElement("div");
    innerMarker.dataset.e2e = "feed-active-video";
    const secondVideo = document.createElement("video");
    innerMarker.append(secondVideo);
    outerId.append(innerMarker);
    document.body.append(outerId);

    expect(findActiveFeedAwemeId(firstVideo)).toBe("7382738211234567890");
    expect(findActiveFeedAwemeId(secondVideo)).toBe("7382738211234567891");
  });

  it("rejects conflicting ids and active scopes shared by multiple videos", () => {
    const conflictingOuter = document.createElement("div");
    conflictingOuter.dataset.e2e = "feed-active-video";
    conflictingOuter.dataset.e2eVid = "7382738211234567890";
    const conflictingInner = document.createElement("div");
    conflictingInner.dataset.e2eVid = "7382738211234567891";
    const conflictingVideo = document.createElement("video");
    conflictingInner.append(conflictingVideo);
    conflictingOuter.append(conflictingInner);
    document.body.append(conflictingOuter);
    expect(findActiveFeedAwemeId(conflictingVideo)).toBeNull();

    const shared = document.createElement("div");
    shared.dataset.e2e = "feed-active-video";
    shared.dataset.e2eVid = "7382738211234567892";
    const first = document.createElement("video");
    const second = document.createElement("video");
    shared.append(first, second);
    document.body.append(shared);
    expect(findActiveFeedAwemeId(first)).toBeNull();
    expect(findActiveFeedAwemeId(second)).toBeNull();
  });
});
