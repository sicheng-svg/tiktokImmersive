import { describe, expect, it } from "vitest";
import {
  MAX_CAPTURED_MAPPINGS,
  MAX_CAPTURED_URLS_PER_AWEME,
  createMediaCaptureMessage,
  extractAwemeMediaMappings,
} from "../src/shared/awemeMediaCapture";

const FIRST_AWEME_ID = "7382738211234567890";
const SECOND_AWEME_ID = "7382738211234567891";

function playbackAddress(...urls: string[]): Record<string, unknown> {
  return { url_list: urls };
}

describe("extractAwemeMediaMappings", () => {
  it("binds a play address only to the aweme id in the same object", () => {
    const firstUrl = "https://v1.douyinvod.com/video/first.mp4?token=one";
    const secondUrl = "https://v2.douyinvod.com/video/second.mp4?token=two";
    const payload = {
      aweme_list: [
        {
          aweme_id: FIRST_AWEME_ID,
          video: { play_addr: playbackAddress(firstUrl) },
        },
        {
          aweme_id: SECOND_AWEME_ID,
          video: { play_addr: playbackAddress(secondUrl) },
        },
      ],
    };

    expect(extractAwemeMediaMappings(payload)).toEqual([
      { awemeId: FIRST_AWEME_ID, urls: [firstUrl] },
      { awemeId: SECOND_AWEME_ID, urls: [secondUrl] },
    ]);
  });

  it("does not borrow a nested or adjacent aweme's play address", () => {
    const nestedUrl = "https://v3.douyinvod.com/video/nested.mp4";
    const payload = {
      aweme_id: FIRST_AWEME_ID,
      video: { cover: { url_list: ["https://www.douyin.com/cover"] } },
      related_aweme: {
        aweme_id: SECOND_AWEME_ID,
        video: { play_addr: playbackAddress(nestedUrl) },
      },
    };

    expect(extractAwemeMediaMappings(payload)).toEqual([
      { awemeId: SECOND_AWEME_ID, urls: [nestedUrl] },
    ]);
  });

  it("ignores download addresses when no playback address exists", () => {
    const payload = {
      aweme_id: FIRST_AWEME_ID,
      video: {
        download_addr: playbackAddress("https://v1.douyinvod.com/video/download.mp4"),
      },
    };

    expect(extractAwemeMediaMappings(payload)).toEqual([]);
  });

  it("rejects image, HTTP, streaming manifest, and non-Douyin media URLs", () => {
    const validUrl = "https://v1.douyinvod.com/video/accepted.mp4";
    const payload = {
      aweme_id: FIRST_AWEME_ID,
      video: {
        play_addr: playbackAddress(
          "https://v1.douyinvod.com/cover.jpg",
          "http://v1.douyinvod.com/video/insecure.mp4",
          "https://v1.douyinvod.com/video/master.m3u8?token=one",
          "https://v1.douyinvod.com/video/manifest.mpd",
          "https://media.example.com/video/foreign.mp4",
          "https://evil-douyinvod.com/video/lookalike.mp4",
          validUrl,
        ),
      },
    };

    expect(extractAwemeMediaMappings(payload)).toEqual([
      { awemeId: FIRST_AWEME_ID, urls: [validUrl] },
    ]);
  });

  it("caps URLs per aweme and mappings per message", () => {
    const urls = Array.from(
      { length: MAX_CAPTURED_URLS_PER_AWEME + 3 },
      (_, index) => `https://v1.douyinvod.com/video/${index}.mp4`,
    );
    const perAweme = extractAwemeMediaMappings({
      aweme_id: FIRST_AWEME_ID,
      video: { play_addr: playbackAddress(...urls) },
    });
    expect(perAweme).toHaveLength(1);
    expect(perAweme[0].urls).toEqual(urls.slice(0, MAX_CAPTURED_URLS_PER_AWEME));

    const tooManyMappings = Array.from({ length: MAX_CAPTURED_MAPPINGS + 5 }, (_, index) => ({
      awemeId: `73827382112345${String(index).padStart(5, "0")}`,
      urls: [`https://v1.douyinvod.com/video/${index}.mp4`],
    }));
    expect(createMediaCaptureMessage(tooManyMappings).mappings).toEqual(
      tooManyMappings.slice(0, MAX_CAPTURED_MAPPINGS),
    );
  });
});
