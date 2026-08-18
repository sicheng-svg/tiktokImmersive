import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const INSTALL_KEY = "__douyinEnglishMediaCaptureHookV1__";
const RESPONSE_URL = "https://www.douyin.com/aweme/v1/web/aweme/post/?device_platform=webapp";
const AWEME_ID = "7382738211234567890";

type HookWindow = Window & typeof globalThis & { [INSTALL_KEY]?: boolean };

function fakeResponse(textValue: string | Promise<string>): Response {
  const text = vi.fn(() => Promise.resolve(textValue));
  return {
    url: RESPONSE_URL,
    headers: new Headers({ "content-type": "application/json" }),
    clone: vi.fn(() => ({ text })),
  } as unknown as Response;
}

async function flushCaptureInspection(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function setXhrResponse(
  xhr: XMLHttpRequest,
  options: {
    url: string;
    responseType: XMLHttpRequestResponseType;
    response?: unknown;
    responseText?: string;
    contentType?: string | null;
  },
): void {
  Object.defineProperties(xhr, {
    responseURL: { configurable: true, value: options.url },
    responseType: { configurable: true, value: options.responseType },
    response: { configurable: true, value: options.response },
    responseText: { configurable: true, value: options.responseText ?? "" },
  });
  vi.spyOn(xhr, "getResponseHeader").mockImplementation((name) =>
    name.toLowerCase() === "content-type" ? (options.contentType ?? "application/json") : null,
  );
}

describe("mediaCaptureHook", () => {
  let originalFetch: typeof window.fetch;
  let originalXhrSend: typeof XMLHttpRequest.prototype.send;

  beforeEach(() => {
    vi.resetModules();
    originalFetch = window.fetch;
    originalXhrSend = XMLHttpRequest.prototype.send;
    delete (window as HookWindow)[INSTALL_KEY];
  });

  afterEach(() => {
    Object.defineProperty(window, "fetch", {
      configurable: true,
      writable: true,
      value: originalFetch,
    });
    XMLHttpRequest.prototype.send = originalXhrSend;
    delete (window as HookWindow)[INSTALL_KEY];
    vi.restoreAllMocks();
  });

  it("returns the native fetch promise and original response unchanged", async () => {
    const response = fakeResponse(
      JSON.stringify({
        aweme_id: AWEME_ID,
        video: {
          play_addr: { url_list: ["https://v1.douyinvod.com/video/original.mp4"] },
        },
      }),
    );
    const originalPromise = Promise.resolve(response);
    const nativeFetch = vi.fn(() => originalPromise) as unknown as typeof fetch;
    Object.defineProperty(window, "fetch", {
      configurable: true,
      writable: true,
      value: nativeFetch,
    });
    const postMessage = vi.spyOn(window, "postMessage").mockImplementation(() => undefined);

    await import("../src/page/mediaCaptureHook");
    const returnedPromise = window.fetch(RESPONSE_URL);

    expect(returnedPromise).toBe(originalPromise);
    await expect(returnedPromise).resolves.toBe(response);
    expect(nativeFetch).toHaveBeenCalledWith(RESPONSE_URL);
    await flushCaptureInspection();
    expect(response.clone).toHaveBeenCalledOnce();
    expect(postMessage).toHaveBeenCalledOnce();
  });

  it("swallows metadata parsing failures without changing the page fetch result", async () => {
    const response = fakeResponse("{not-valid-json");
    const originalPromise = Promise.resolve(response);
    const nativeFetch = vi.fn(() => originalPromise) as unknown as typeof fetch;
    Object.defineProperty(window, "fetch", {
      configurable: true,
      writable: true,
      value: nativeFetch,
    });
    const postMessage = vi.spyOn(window, "postMessage").mockImplementation(() => undefined);

    await import("../src/page/mediaCaptureHook");
    const returnedPromise = window.fetch(RESPONSE_URL);

    expect(returnedPromise).toBe(originalPromise);
    await expect(returnedPromise).resolves.toBe(response);
    await flushCaptureInspection();
    expect(response.clone).toHaveBeenCalledOnce();
    expect(postMessage).not.toHaveBeenCalled();
  });

  it("publishes target XHR JSON while preserving native send behavior", async () => {
    const nativeResult = Symbol("native-send-result");
    const nativeSend = vi.fn(function (this: XMLHttpRequest, _body?: unknown) {
      return nativeResult;
    });
    XMLHttpRequest.prototype.send = nativeSend as unknown as typeof XMLHttpRequest.prototype.send;
    const postMessage = vi.spyOn(window, "postMessage").mockImplementation(() => undefined);

    await import("../src/page/mediaCaptureHook");
    const xhr = new XMLHttpRequest();
    setXhrResponse(xhr, {
      url: RESPONSE_URL,
      responseType: "json",
      response: {
        aweme_id: AWEME_ID,
        video: {
          play_addr: { url_list: ["https://v1.douyinvod.com/video/xhr.mp4"] },
        },
      },
    });
    const pageLoadendListener = vi.fn();
    xhr.addEventListener("loadend", pageLoadendListener);

    const returned = Reflect.apply(xhr.send, xhr, ["request-body"]);
    xhr.dispatchEvent(new Event("loadend"));

    expect(returned).toBe(nativeResult);
    expect(nativeSend).toHaveBeenCalledOnce();
    expect(nativeSend).toHaveBeenCalledWith("request-body");
    expect(nativeSend.mock.contexts[0]).toBe(xhr);
    expect(pageLoadendListener).toHaveBeenCalledOnce();
    expect(postMessage).toHaveBeenCalledOnce();
  });

  it("silently ignores invalid JSON and non-target XHR responses", async () => {
    const nativeSend = vi.fn();
    XMLHttpRequest.prototype.send = nativeSend as unknown as typeof XMLHttpRequest.prototype.send;
    const postMessage = vi.spyOn(window, "postMessage").mockImplementation(() => undefined);

    await import("../src/page/mediaCaptureHook");
    const invalidJson = new XMLHttpRequest();
    setXhrResponse(invalidJson, {
      url: RESPONSE_URL,
      responseType: "",
      responseText: "{not-valid-json",
    });
    invalidJson.send();
    expect(() => invalidJson.dispatchEvent(new Event("loadend"))).not.toThrow();

    const nonTarget = new XMLHttpRequest();
    setXhrResponse(nonTarget, {
      url: "https://www.douyin.com/user/profile/",
      responseType: "json",
      response: {
        aweme_id: AWEME_ID,
        video: {
          play_addr: { url_list: ["https://v1.douyinvod.com/video/ignored.mp4"] },
        },
      },
    });
    nonTarget.send();
    expect(() => nonTarget.dispatchEvent(new Event("loadend"))).not.toThrow();

    expect(nativeSend).toHaveBeenCalledTimes(2);
    expect(postMessage).not.toHaveBeenCalled();
  });
});
