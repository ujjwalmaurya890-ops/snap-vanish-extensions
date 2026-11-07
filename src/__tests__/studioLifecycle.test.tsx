// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../lib/settings";

const mocks = vi.hoisted(() => ({ initialize: vi.fn(async () => ({ ok: true })), dispose: vi.fn(), stopAudio: vi.fn() }));
vi.mock("../features/detection/handTracker", () => ({
  HandLandmarkService: class {
    currentStatus = "ready";
    initialize = mocks.initialize;
    dispose = mocks.dispose;
    detectVideoFrame() { return { handDetected: false }; }
  },
  drawHandLandmarksOverlay: vi.fn(),
}));
vi.mock("../features/audio/audioConfirmationEngine", () => ({
  LiveAudioConfirmationEngine: class { stop = mocks.stopAudio; start = vi.fn(async () => ({ ok: true })); },
}));
vi.mock("../features/camera/backgroundReconstructor", () => ({
  BackgroundReconstructor: class { reset = vi.fn(); clearCapturedPlate = vi.fn(); ingestLiveFrame = vi.fn(); },
}));
vi.mock("../lib/dust", () => ({
  DustScene: class { particleCount = 0; build() {} render() {} },
  createRenderOptions: () => ({}), playSnap: vi.fn(),
}));
import SnapStage from "../components/SnapStage";
import CalibrationModal from "../features/calibration/CalibrationModal";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}
function camera() {
  const track = { kind: "video", readyState: "live", stop: vi.fn(), getSettings: () => ({ width: 640, height: 360 }), addEventListener: vi.fn() };
  return { track, stream: { getTracks: () => [track], getVideoTracks: () => [track] } as unknown as MediaStream };
}
function Host() {
  const [requested, setRequested] = useState(false);
  const [automatic, setAutomatic] = useState(false);
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.gesture.detectionMode = automatic ? "gesture-only" : "manual";
  return <>
    <button onClick={() => setAutomatic(true)}>Switch automatic</button>
    <SnapStage enabled duration={1} direction="right" sensitivity={60} snapSignal={0} sound={false}
      fullSettings={settings} liveCameraRequested={requested} onLiveCameraChange={setRequested} onStatus={() => {}} />
  </>;
}
let root: Root;
let container: HTMLDivElement;
const mediaDescriptor = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  vi.spyOn(window, "requestAnimationFrame").mockReturnValue(1);
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  if (mediaDescriptor) Object.defineProperty(navigator, "mediaDevices", mediaDescriptor);
  else Reflect.deleteProperty(navigator, "mediaDevices");
  vi.restoreAllMocks();
});
function button(label: string) {
  const found = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes(label));
  if (!found) throw new Error(`Button not found: ${label}`);
  return found;
}

describe("Studio camera lifecycle", () => {
  it("keeps an internally started camera on, then initializes when Manual switches to automatic", async () => {
    const { track, stream } = camera();
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: vi.fn(async () => stream) } });
    await act(async () => root.render(<Host />));
    expect(container.textContent).toContain("STUDIO PREVIEW · CAMERA OFF");
    await act(async () => button("Enable Live Webcam").click());
    expect(container.textContent).toContain("Stop Live Webcam");
    expect(track.stop).not.toHaveBeenCalled();
    expect(mocks.initialize).not.toHaveBeenCalled();
    await act(async () => button("Switch automatic").click());
    expect(mocks.initialize).toHaveBeenCalledOnce();
    await act(async () => button("Stop Live Webcam").click());
    expect(track.stop).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("STUDIO PREVIEW · CAMERA OFF");
  });

  it("stops a stream whose permission request resolves after cancellation", async () => {
    const pending = deferred<MediaStream>();
    const { track, stream } = camera();
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: vi.fn(() => pending.promise) } });
    await act(async () => root.render(<Host />));
    await act(async () => button("Enable Live Webcam").click());
    await act(async () => button("Cancel Camera Request").click());
    await act(async () => { pending.resolve(stream); await pending.promise; });
    expect(track.stop).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("Enable Live Webcam");
    expect(container.textContent).not.toContain("LIVE CAM ·");
  });

  it("stops a late stream after unmount", async () => {
    const pending = deferred<MediaStream>();
    const { track, stream } = camera();
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: vi.fn(() => pending.promise) } });
    await act(async () => root.render(<Host />));
    await act(async () => button("Enable Live Webcam").click());
    await act(async () => root.unmount());
    await act(async () => { pending.resolve(stream); await pending.promise; });
    expect(track.stop).toHaveBeenCalledOnce();
    // Create a fresh root for afterEach's normal cleanup.
    root = createRoot(container);
  });

  it("cancels a pending calibration camera when the modal closes", async () => {
    const pending = deferred<MediaStream>();
    const { track, stream } = camera();
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: vi.fn(() => pending.promise) } });
    const render = (open: boolean) => <CalibrationModal open={open} settings={DEFAULT_SETTINGS} onClose={() => {}} onSaveCalibration={() => {}} />;
    await act(async () => root.render(render(true)));
    await act(async () => button("Start Live Camera Preview").click());
    await act(async () => root.render(render(false)));
    await act(async () => { pending.resolve(stream); await pending.promise; });
    expect(track.stop).toHaveBeenCalledOnce();
    expect(mocks.initialize).not.toHaveBeenCalled();
  });
});
