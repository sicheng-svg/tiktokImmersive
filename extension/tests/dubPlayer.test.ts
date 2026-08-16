import { describe, expect, it, vi } from "vitest";
import { DubPlayer } from "../src/content/dubPlayer";

type FakeAudio = HTMLAudioElement & {
  setReadyState(value: number): void;
  setDuration(value: number): void;
  emit(type: string): void;
};

function createFakeAudio(): FakeAudio {
  const listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
  let readyState: number = HTMLMediaElement.HAVE_NOTHING;
  let duration = Number.NaN;
  let currentTime = 0;
  const audio = {
    preload: "",
    loop: false,
    playbackRate: 1,
    get readyState() {
      return readyState;
    },
    get duration() {
      return duration;
    },
    get currentTime() {
      return currentTime;
    },
    set currentTime(value: number) {
      if (readyState === HTMLMediaElement.HAVE_NOTHING) throw new DOMException("not ready", "InvalidStateError");
      currentTime = value;
    },
    load: vi.fn(),
    play: vi.fn(() => Promise.resolve()),
    pause: vi.fn(),
    removeAttribute: vi.fn(),
    addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
      const entries = listeners.get(type) ?? new Set<EventListenerOrEventListenerObject>();
      entries.add(listener);
      listeners.set(type, entries);
    },
    removeEventListener(type: string, listener: EventListenerOrEventListenerObject) {
      listeners.get(type)?.delete(listener);
    },
    setReadyState(value: number) {
      readyState = value;
    },
    setDuration(value: number) {
      duration = value;
    },
    emit(type: string) {
      const event = new Event(type);
      Object.defineProperty(event, "currentTarget", { configurable: true, value: audio });
      listeners.get(type)?.forEach((listener) => {
        if (typeof listener === "function") listener(event);
        else listener.handleEvent(event);
      });
    },
  };
  return audio as unknown as FakeAudio;
}

describe("DubPlayer", () => {
  it("defers seeking until audio metadata is available", () => {
    const audio = createFakeAudio();
    const player = new DubPlayer(() => audio);
    player.load("mock.mp3");

    expect(() => player.seek(8, true)).not.toThrow();
    expect(audio.currentTime).toBe(0);

    audio.setDuration(5);
    audio.setReadyState(HTMLMediaElement.HAVE_METADATA);
    audio.emit("loadedmetadata");
    expect(audio.currentTime).toBe(3);
  });
});
