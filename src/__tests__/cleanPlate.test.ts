// @vitest-environment node
import fs from "node:fs";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";

const { JSDOM } = createRequire(import.meta.url)("jsdom") as { JSDOM: new (...args: any[]) => any };
const source = fs.readFileSync("extension/content/snap-vanish.js", "utf8");
const marker = "  // Public diagnostics handle (isolated world only — not reachable from the page).";
const windows: Array<{ window: { close: () => void } }> = [];
function harness() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://meet.google.com/test", runScripts: "outside-only", pretendToBeVisual: true });
  windows.push(dom);
  const win = dom.window as any;
  let now = 1000;
  win.Date.now = () => now;
  win.structuredClone = structuredClone;
  win.requestAnimationFrame = () => 1;
  win.cancelAnimationFrame = () => {};
  const contexts = new Map<any, any>();
  win.HTMLCanvasElement.prototype.getContext = function () {
    if (!contexts.has(this)) contexts.set(this, {
      drawImage: vi.fn(), clearRect: vi.fn(), fillRect: vi.fn(), save: vi.fn(), restore: vi.fn(), setTransform: vi.fn(),
      getImageData: vi.fn((_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h })),
    });
    return contexts.get(this);
  };
  const video = win.document.createElement("video");
  let track = { id: "camera-a", readyState: "live" };
  Object.defineProperties(video, {
    readyState: { get: () => 4 }, videoWidth: { get: () => 640 }, videoHeight: { get: () => 360 },
    srcObject: { get: () => ({ getVideoTracks: () => [track] }) },
  });
  video.getBoundingClientRect = () => ({ left: 20, top: 30, width: 960, height: 540, right: 980, bottom: 570 });
  win.document.body.append(video);
  Object.defineProperty(win, "devicePixelRatio", { configurable: true, value: 2 });
  const attachSnapshots: Array<{ width: number; height: number; drawCalls: number }> = [];
  win.addEventListener("snap-vanish:bridge-cmd", (event: any) => {
    const { action, requestId } = event.detail;
    if (action === "CHECK_CAMERA_PREVIEW") win.dispatchEvent(new win.CustomEvent("snap-vanish:bridge-ack", { detail: { requestId, ok: event.target === video } }));
    if (action === "HELLO") win.dispatchEvent(new win.CustomEvent("snap-vanish:bridge-ack", { detail: { requestId, ok: true, token: "fixture", sendersCount: 1 } }));
    if (action === "ATTACH_PROCESSED_STREAM") {
      const canvas = win.document.getElementById("snap-vanish-rtc-canvas");
      attachSnapshots.push({ width: canvas.width, height: canvas.height, drawCalls: contexts.get(canvas).drawImage.mock.calls.length });
      win.dispatchEvent(new win.CustomEvent("snap-vanish:bridge-ack", { detail: { requestId, ok: true, mode: "webrtc-sender", sendersCount: 1 } }));
    }
    if (action === "RESTORE_ORIGINAL_TRACK") win.dispatchEvent(new win.CustomEvent("snap-vanish:bridge-ack", { detail: { requestId, ok: true, sendersCount: 0 } }));
  });
  win.chrome = { storage: { sync: { get: async (_: unknown, cb: (data: unknown) => void) => { cb({}); return {}; } } }, runtime: { onMessage: { addListener: () => {} } } };
  expect(source).toContain(marker);
  win.eval(source.replace(marker, `${marker}
    window.__plateTest = { beginCleanPlateCapture, capturePlateTick, cancelCleanPlateCapture, clearCleanPlate,
      approveCleanPlate, showCleanPlatePreview, buildParticles, snapshotState, startTransition, applySettings, teardown,
      captureSizeFor, syncOverlayRect, renderFrame, renderTick, finishTransition,
      getSurfaces: () => ({ tileCanvas, tileCtx, captureCanvas, captureCtx }),
      getPlate: () => cleanPlateCanvas, getPlateContext: () => plateCtx, getPreviewVisible: () => platePreviewVisible };`));
  return {
    win, video, api: win.__plateTest as Record<string, (...args: any[]) => any>, contexts, attachSnapshots,
    advance: (milliseconds: number) => { now += milliseconds; },
    changeCamera: () => { track = { id: "camera-b", readyState: "live" }; },
    endCamera: () => { track.readyState = "ended"; },
    setHidden: (hidden: boolean) => Object.defineProperty(win.document, "hidden", { configurable: true, value: hidden }),
  };
}
afterEach(() => { for (const dom of windows.splice(0)) dom.window.close(); vi.restoreAllMocks(); });

describe("explicit in-call clean plate", () => {
  it("never captures automatically and uses a solid fallback rather than a blurred person", () => {
    const h = harness();
    expect(h.api.snapshotState()).toMatchObject({ cleanPlateStatus: "none", backgroundMethod: "solid-fallback" });
    expect(h.api.getPlate()).toBeNull();
    h.api.buildParticles(h.video);
    const plate = h.api.getPlateContext();
    expect(plate.fillRect).toHaveBeenCalled();
    expect(plate.drawImage).not.toHaveBeenCalled();
  });

  it("captures only after the user-requested countdown and uses it only after review", async () => {
    const h = harness();
    expect(h.api.beginCleanPlateCapture()).toMatchObject({ ok: true, cleanPlateStatus: "countdown" });
    expect(h.api.getPlate()).toBeNull();
    expect(await h.api.startTransition("vanish")).toMatchObject({ ok: false, reason: "capture-pending" });
    h.advance(5000);
    h.api.capturePlateTick();
    expect(h.api.snapshotState()).toMatchObject({ cleanPlateStatus: "review" });
    expect(h.api.getPreviewVisible()).toBe(true);
    h.api.buildParticles(h.video);
    expect(h.api.getPlateContext().drawImage).not.toHaveBeenCalled();
    expect(h.api.approveCleanPlate()).toMatchObject({ ok: true });
    h.api.buildParticles(h.video);
    expect(h.api.getPlateContext().drawImage).toHaveBeenCalledWith(h.api.getPlate(), 0, 0, 640, 360);
    expect(h.api.snapshotState()).toMatchObject({ cleanPlateStatus: "captured", backgroundMethod: "captured-plate" });
    const stored = h.api.getPlate();
    expect(h.api.clearCleanPlate().ok).toBe(true);
    expect(stored.width).toBe(0);
    expect(h.api.snapshotState()).toMatchObject({ cleanPlateStatus: "none", backgroundMethod: "solid-fallback" });
  });

  it("cancels without capturing if the user cancels or the tab becomes hidden", () => {
    const cancelled = harness();
    cancelled.api.beginCleanPlateCapture();
    cancelled.api.cancelCleanPlateCapture();
    cancelled.advance(6000);
    cancelled.api.capturePlateTick();
    expect(cancelled.api.getPlate()).toBeNull();
    const hidden = harness();
    hidden.api.beginCleanPlateCapture();
    hidden.setHidden(true);
    hidden.win.document.dispatchEvent(new hidden.win.Event("visibilitychange"));
    hidden.advance(6000);
    hidden.api.capturePlateTick();
    expect(hidden.api.getPlate()).toBeNull();
    expect(hidden.api.snapshotState()).toMatchObject({ cleanPlateStatus: "none", cleanPlateError: "capture-interrupted" });
  });

  it("rejects hidden or unverified capture and invalidates a plate on camera change", () => {
    const h = harness();
    h.setHidden(true);
    expect(h.api.beginCleanPlateCapture()).toMatchObject({ ok: false, reason: "focus-meeting-tab" });
    h.setHidden(false);
    const unavailable = harness();
    unavailable.endCamera();
    expect(unavailable.api.beginCleanPlateCapture()).toMatchObject({ ok: false, reason: "no-verified-camera-preview" });
    h.api.beginCleanPlateCapture();
    h.advance(5000); h.api.capturePlateTick(); h.api.approveCleanPlate();
    const old = h.api.getPlate();
    h.changeCamera();
    h.api.buildParticles(h.video);
    expect(old.width).toBe(0);
    expect(h.api.snapshotState()).toMatchObject({ cleanPlateStatus: "none", cleanPlateError: "camera-changed", backgroundMethod: "solid-fallback" });
  });

  it("clears the frame on disable and teardown", async () => {
    const h = harness();
    h.api.beginCleanPlateCapture(); h.advance(5000); h.api.capturePlateTick();
    const stored = h.api.getPlate();
    h.api.applySettings({ enabled: false });
    expect(stored.width).toBe(0);
    expect(h.api.getPlate()).toBeNull();
    await h.api.teardown();
  });
});


describe("renderer surfaces and sender priming", () => {
  it("initializes and paints the local overlay at a capped proportional DPR size", () => {
    const h = harness();
    expect(h.api.syncOverlayRect()).toBe(true);
    const { tileCanvas, tileCtx } = h.api.getSurfaces();
    expect(tileCtx).toBeTruthy();
    expect([tileCanvas.width, tileCanvas.height]).toEqual([1280, 720]);
    expect(tileCanvas.style.width).toBe("960px");
    h.api.buildParticles(h.video);
    expect(h.api.renderFrame(0, "dom-overlay")).toBe(true);
    expect(tileCtx.drawImage).toHaveBeenCalledWith(h.video, 0, 0, 640, 360);
    tileCtx.drawImage.mockImplementationOnce(() => { throw new Error("canvas failed"); });
    expect(h.api.renderTick(0)).toBe(false);
    expect(h.api.snapshotState().renderError).toBe("overlay-render-failed");
    expect(h.api.renderTick(0)).toBe(true);
    expect(h.api.snapshotState().renderError).toBeNull();
  });

  it("caps wide and portrait source dimensions without forcing a 16:9 crop", () => {
    const h = harness();
    expect(h.api.captureSizeFor({ videoWidth: 3840, videoHeight: 1080 })).toEqual({ w: 1280, h: 360 });
    expect(h.api.captureSizeFor({ videoWidth: 1080, videoHeight: 1920 })).toEqual({ w: 404, h: 720 });
  });

  it("paints the correctly sized outgoing canvas before sender attach and does not resize it on restore", async () => {
    const h = harness();
    h.api.applySettings({ sound: false, muteOnVanish: false });
    expect((await h.api.startTransition("vanish")).ok).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.attachSnapshots).toHaveLength(1);
    expect(h.attachSnapshots[0]).toMatchObject({ width: 640, height: 360 });
    expect(h.attachSnapshots[0].drawCalls).toBeGreaterThan(0);
    const canvas = h.api.getSurfaces().captureCanvas;
    h.api.finishTransition();
    expect((await h.api.startTransition("restore")).ok).toBe(true);
    expect([canvas.width, canvas.height]).toEqual([640, 360]);
    await h.api.teardown();
  });
});
