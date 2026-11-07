// @vitest-environment jsdom
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LiveAudioConfirmationEngine } from "../features/audio/audioConfirmationEngine";

const require = createRequire(import.meta.url);
const { JSDOM } = require("jsdom") as { JSDOM: new (...args: any[]) => any };
const contentSource = fs.readFileSync(path.resolve("extension/content/snap-vanish.js"), "utf8");
const marker = "  // Public diagnostics handle (isolated world only — not reachable from the page).";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

function audioStream() {
  const track = {
    kind: "audio", readyState: "live", label: "fixture microphone",
    stop: vi.fn(function (this: { readyState: string }) { this.readyState = "ended"; }),
    addEventListener: vi.fn(),
  };
  return { track, stream: { getTracks: () => [track], getAudioTracks: () => [track] } };
}

class FakeAudioContext {
  state: AudioContextState = "running";
  currentTime = 0;
  destination = {};
  close = vi.fn(async () => { this.state = "closed"; });
  resume = vi.fn(async () => { this.state = "running"; });
  createMediaStreamSource() { return { connect: (node: unknown) => node, disconnect: vi.fn() }; }
  createBiquadFilter() {
    return { type: "", frequency: { value: 0 }, Q: { value: 0 }, connect: (node: unknown) => node, disconnect: vi.fn() };
  }
  createAnalyser() {
    return { fftSize: 0, getFloatTimeDomainData: (buf: Float32Array) => buf.fill(0.2), disconnect: vi.fn() };
  }
}

function contentHarness(getUserMedia: (...args: any[]) => Promise<any>, withAudioContext = true) {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "https://meet.google.com/fixture", runScripts: "outside-only", pretendToBeVisual: true,
  });
  const win = dom.window as Window & typeof globalThis & Record<string, any>;
  win.structuredClone = structuredClone;
  win.requestAnimationFrame = () => 1;
  win.cancelAnimationFrame = () => {};
  win.HTMLCanvasElement.prototype.getContext = (() => ({ clearRect: vi.fn() })) as any;
  Object.defineProperty(win.navigator, "mediaDevices", { value: { getUserMedia }, configurable: true });
  if (withAudioContext) Object.defineProperty(win, "AudioContext", { value: FakeAudioContext, configurable: true });
  win.chrome = {
    storage: { sync: { get: async (_: unknown, cb: (data: unknown) => void) => { const data = { pauseWhenHidden: false }; cb(data); return data; } } },
    runtime: { onMessage: { addListener: () => {} } },
  };
  win.addEventListener("snap-vanish:bridge-cmd", (event: Event) => {
    const { requestId, action } = (event as CustomEvent).detail;
    if (action === "RESTORE_ORIGINAL_TRACK") {
      win.dispatchEvent(new win.CustomEvent("snap-vanish:bridge-ack", { detail: { requestId, action, ok: true, sendersCount: 0 } }));
    }
  });
  expect(contentSource).toContain(marker);
  const instrumented = contentSource.replace(marker, `${marker}
  window.__audioTest = { ensureAudioGate, releaseAudio, evaluateHandSnap, applySettings,
    mutePlatformForVanish, togglePlatformMicByRequest, triggerGestureAction, snapshotState, emergencyRestore, teardown, startTransition,
    setRestoreError: (value) => { state.restoreError = value; },
    setTestModel: (value) => { handLandmarker = value; handModelBackend = "in-page"; handModelReady = true; } };`);
  win.eval(instrumented);
  return { dom, win, api: win.__audioTest as Record<string, (...args: any[]) => any> };
}

const windows: ReturnType<typeof contentHarness>[] = [];
const originalMediaDevices = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
const originalAudioContext = Object.getOwnPropertyDescriptor(window, "AudioContext");
function setup(gum: (...args: any[]) => Promise<any>, audioContext = true) {
  const h = contentHarness(gum, audioContext);
  windows.push(h);
  return h;
}
afterEach(() => {
  for (const h of windows.splice(0)) h.dom.window.close();
  if (originalMediaDevices) Object.defineProperty(navigator, "mediaDevices", originalMediaDevices);
  else Reflect.deleteProperty(navigator, "mediaDevices");
  if (originalAudioContext) Object.defineProperty(window, "AudioContext", originalAudioContext);
  else Reflect.deleteProperty(window, "AudioContext");
  vi.restoreAllMocks();
});

function landmarks(distance: number) {
  const world = Array.from({ length: 21 }, () => ({ x: 0, y: 0, z: 0 }));
  world[12] = { x: distance, y: 0, z: 0 };
  return world;
}
function visualSnap(api: Record<string, (...args: any[]) => any>, at = 1000) {
  const far = landmarks(0.04), near = landmarks(0.006);
  api.evaluateHandSnap(far, far, at);
  return api.evaluateHandSnap(near, near, at + 100);
}

describe("in-call microphone and mute safety", () => {
  it("reports automatic detection inactive until a verified camera and successful inference exist", () => {
    const h = setup(async () => audioStream().stream);
    expect(h.api.snapshotState()).toMatchObject({ detectionEnabled: true, detectionActive: false, detectionStatus: "no-camera", muted: null });
    h.api.applySettings({ gesture: { detectionMode: "manual" } });
    expect(h.api.snapshotState()).toMatchObject({ detectionActive: false, detectionStatus: "manual" });
  });

  it("requires a successful camera restore before another vanish", async () => {
    const h = setup(async () => audioStream().stream);
    h.api.setRestoreError("replace-failed");
    expect(await h.api.startTransition("vanish")).toMatchObject({ ok: false, reason: "restore-required" });
    expect((await h.api.startTransition("restore")).ok).toBe(true);
    expect(h.api.snapshotState().restoreError).toBeNull();
  });

  it("does not turn an unconfirmed Smart gesture into a snap when the microphone is denied", async () => {
    const h = setup(async () => { throw new DOMException("denied", "NotAllowedError"); });
    expect(await h.api.ensureAudioGate()).toBe(false);
    expect(visualSnap(h.api)).toBe(false);
    expect(h.api.snapshotState().audioGateActive).toBe(false);
    expect(h.api.snapshotState().audioGateError).toBe("microphone-denied");
  });

  it("keeps Smart fail-closed when audio is disabled, but allows explicit gesture-only mode", () => {
    const h = setup(async () => audioStream().stream);
    h.api.applySettings({ audio: { enabled: false } });
    expect(visualSnap(h.api)).toBe(false);
    h.api.applySettings({ gesture: { detectionMode: "gesture-only" } });
    expect(visualSnap(h.api, 2000)).toBe(true);
  });

  it("requires an active acoustic onset for a Smart gesture", async () => {
    const fixture = audioStream();
    const h = setup(async () => fixture.stream);
    expect(await h.api.ensureAudioGate()).toBe(true);
    expect(visualSnap(h.api)).toBe(true);
    h.api.releaseAudio();
    expect(fixture.track.stop).toHaveBeenCalledOnce();
  });

  it("stops a late microphone stream after the user switches modes", async () => {
    const gate = deferred<ReturnType<typeof audioStream>["stream"]>();
    const fixture = audioStream();
    const gum = vi.fn(() => gate.promise);
    const h = setup(gum);
    const first = h.api.ensureAudioGate();
    const second = h.api.ensureAudioGate();
    expect(gum).toHaveBeenCalledOnce();
    h.api.applySettings({ gesture: { detectionMode: "manual" } });
    gate.resolve(fixture.stream);
    expect(await first).toBe(false);
    expect(await second).toBe(false);
    expect(fixture.track.stop).toHaveBeenCalledOnce();
    expect(h.api.snapshotState().audioGateActive).toBe(false);
  });

  it("stops an acquired stream when AudioContext creation is unavailable", async () => {
    const fixture = audioStream();
    const h = setup(async () => fixture.stream, false);
    expect(await h.api.ensureAudioGate()).toBe(false);
    expect(fixture.track.stop).toHaveBeenCalledOnce();
  });

  it("invalidates a pending microphone request before waiting for teardown", async () => {
    const gate = deferred<ReturnType<typeof audioStream>["stream"]>();
    const fixture = audioStream();
    const h = setup(() => gate.promise);
    const starting = h.api.ensureAudioGate();
    const teardown = h.api.teardown();
    gate.resolve(fixture.stream);
    expect(await starting).toBe(false);
    await teardown;
    expect(fixture.track.stop).toHaveBeenCalledOnce();
  });

  it("never automatically unmutes after a user re-mutes during vanish", async () => {
    const h = setup(async () => audioStream().stream);
    const button = h.win.document.createElement("button");
    button.setAttribute("aria-label", "Turn off microphone");
    let clicks = 0;
    button.addEventListener("click", () => {
      clicks += 1;
      button.setAttribute("aria-label", button.getAttribute("aria-label") === "Turn off microphone" ? "Turn on microphone" : "Turn off microphone");
    });
    h.win.document.body.append(button);
    expect(h.api.mutePlatformForVanish()).toBe(true);
    button.click(); // user unmutes
    button.click(); // user mutes again
    expect(h.api.snapshotState().mutedByExtension).toBe(false);
    expect((await h.api.emergencyRestore()).ok).toBe(true);
    expect(button.getAttribute("aria-label")).toBe("Turn on microphone");
    expect(clicks).toBe(3);
    expect(h.api.togglePlatformMicByRequest()).toMatchObject({ ok: true, muted: false });
    expect(clicks).toBe(4);
  });

  it("releases the current model when the hand confidence setting changes", () => {
    const h = setup(async () => audioStream().stream);
    const model = { close: vi.fn() };
    h.api.setTestModel(model);
    h.api.applySettings({ gesture: { minHandConfidence: 0.8 } });
    expect(model.close).toHaveBeenCalledOnce();
    expect(h.api.snapshotState().handModelReady).toBe(false);
  });

  it("honors mute-only gestures without vanishing or ever unmuting an already-muted microphone", async () => {
    const h = setup(async () => audioStream().stream);
    const button = h.win.document.createElement("button");
    button.setAttribute("aria-label", "Turn off microphone");
    let clicks = 0;
    button.addEventListener("click", () => {
      clicks += 1;
      button.setAttribute("aria-label", button.getAttribute("aria-label") === "Turn off microphone" ? "Turn on microphone" : "Turn off microphone");
    });
    h.win.document.body.append(button);
    h.api.applySettings({ gesture: { actionMapping: "mute-only" } });
    expect(h.api.triggerGestureAction()).toMatchObject({ ok: true, muted: true });
    expect(h.api.triggerGestureAction()).toMatchObject({ ok: true, muted: true });
    expect(clicks).toBe(1);
    expect(h.api.snapshotState().engineState).toBe("live");
    h.api.applySettings({ gesture: { actionMapping: "restore-only" } });
    expect(await h.api.triggerGestureAction()).toMatchObject({ ok: true, engineState: "live" });
    expect(clicks).toBe(1);
    h.api.applySettings({ gesture: { actionMapping: "vanish-only" } });
    expect(await h.api.triggerGestureAction()).toMatchObject({ ok: false, reason: "no-verified-camera-preview" });
  });

  it("does not click ambiguous or unrelated microphone controls", () => {
    const h = setup(async () => audioStream().stream);
    const button = h.win.document.createElement("button");
    button.setAttribute("aria-label", "Mute participant microphone");
    const click = vi.fn();
    button.addEventListener("click", click);
    h.win.document.body.append(button);
    expect(h.api.mutePlatformForVanish()).toBe(false);
    expect(h.api.togglePlatformMicByRequest()).toMatchObject({ ok: false, reason: "microphone-state-unknown" });
    expect(click).not.toHaveBeenCalled();
  });
});

describe("Studio audio monitor lifecycle", () => {
  it("stops a permission result that arrives after the monitor was stopped", async () => {
    const gate = deferred<ReturnType<typeof audioStream>["stream"]>();
    const fixture = audioStream();
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: () => gate.promise } });
    Object.defineProperty(window, "AudioContext", { configurable: true, value: FakeAudioContext });
    const engine = new LiveAudioConfirmationEngine();
    const starting = engine.start();
    engine.stop();
    gate.resolve(fixture.stream);
    expect(await starting).toMatchObject({ ok: false, cancelled: true });
    expect(fixture.track.stop).toHaveBeenCalledOnce();
    expect(engine.getSnapshot().active).toBe(false);
  });

  it("stops the microphone when audio initialization fails", async () => {
    const fixture = audioStream();
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: async () => fixture.stream } });
    Object.defineProperty(window, "AudioContext", { configurable: true, value: undefined });
    const engine = new LiveAudioConfirmationEngine();
    expect((await engine.start()).ok).toBe(false);
    expect(fixture.track.stop).toHaveBeenCalledOnce();
    expect(engine.getSnapshot().active).toBe(false);
  });

  it("discards an older acquisition when another monitor start supersedes it", async () => {
    const firstGate = deferred<ReturnType<typeof audioStream>["stream"]>();
    const secondGate = deferred<ReturnType<typeof audioStream>["stream"]>();
    const first = audioStream(), second = audioStream();
    const gum = vi.fn().mockReturnValueOnce(firstGate.promise).mockReturnValueOnce(secondGate.promise);
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: gum } });
    Object.defineProperty(window, "AudioContext", { configurable: true, value: FakeAudioContext });
    const engine = new LiveAudioConfirmationEngine();
    const oldStart = engine.start(), newStart = engine.start();
    secondGate.resolve(second.stream);
    expect((await newStart).ok).toBe(true);
    firstGate.resolve(first.stream);
    expect(await oldStart).toMatchObject({ ok: false, cancelled: true });
    expect(first.track.stop).toHaveBeenCalledOnce();
    expect(second.track.stop).not.toHaveBeenCalled();
    engine.stop();
    expect(second.track.stop).toHaveBeenCalledOnce();
  });
});
