import {
  MAX_CAPTURE_RESPONSE_CHARS,
  createMediaCaptureMessage,
  extractAwemeMediaMappings,
  shouldInspectMediaMetadataResponse,
} from "../shared/awemeMediaCapture";

const INSTALL_KEY = "__douyinEnglishMediaCaptureHookV1__";

type HookWindow = Window & typeof globalThis & { [INSTALL_KEY]?: boolean };

function publishPayload(payload: unknown): void {
  const mappings = extractAwemeMediaMappings(payload);
  if (mappings.length === 0) return;
  window.postMessage(createMediaCaptureMessage(mappings), window.location.origin);
}

async function inspectFetchResponse(response: Response): Promise<void> {
  const contentType = response.headers.get("content-type");
  if (!shouldInspectMediaMetadataResponse(response.url, contentType)) return;
  const contentLength = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_CAPTURE_RESPONSE_CHARS) return;

  const text = await response.clone().text();
  if (text.length === 0 || text.length > MAX_CAPTURE_RESPONSE_CHARS) return;
  publishPayload(JSON.parse(text) as unknown);
}

function inspectXhrResponse(xhr: XMLHttpRequest): void {
  const contentType = xhr.getResponseHeader("content-type");
  if (!shouldInspectMediaMetadataResponse(xhr.responseURL, contentType)) return;
  if (xhr.responseType === "json") {
    publishPayload(xhr.response);
    return;
  }
  if (xhr.responseType !== "" && xhr.responseType !== "text") return;
  const text = xhr.responseText;
  if (text.length === 0 || text.length > MAX_CAPTURE_RESPONSE_CHARS) return;
  publishPayload(JSON.parse(text) as unknown);
}

function installFetchHook(): void {
  const nativeFetch = window.fetch;
  if (typeof nativeFetch !== "function") return;
  window.fetch = new Proxy(nativeFetch, {
    apply(target, thisArg, argumentsList: Parameters<typeof fetch>) {
      const result = Reflect.apply(target, thisArg, argumentsList) as ReturnType<typeof fetch>;
      void result.then((response) => inspectFetchResponse(response).catch(() => undefined), () => undefined);
      return result;
    },
  });
}

function installXhrHook(): void {
  const nativeSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = new Proxy(nativeSend, {
    apply(target, thisArg: XMLHttpRequest, argumentsList: Parameters<XMLHttpRequest["send"]>) {
      thisArg.addEventListener(
        "loadend",
        () => {
          try {
            inspectXhrResponse(thisArg);
          } catch {
            // Capturing metadata must never change the host page's request behavior.
          }
        },
        { once: true },
      );
      return Reflect.apply(target, thisArg, argumentsList);
    },
  });
}

const hookWindow = window as HookWindow;
if (!hookWindow[INSTALL_KEY]) {
  hookWindow[INSTALL_KEY] = true;
  installFetchHook();
  installXhrHook();
}
