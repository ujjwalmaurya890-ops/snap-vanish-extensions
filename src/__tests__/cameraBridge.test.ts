// @vitest-environment node
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { JSDOM } = require("jsdom") as { JSDOM: new (...args: any[]) => any };
const bridgeCode = fs.readFileSync(
  path.resolve(process.cwd(), "extension/content/main-world-bridge.js"),
  "utf8",
);

class Track {
  kind = "video";
  readyState = "live";
  stop = vi.fn(() => { this.readyState = "ended"; });
  constructor(public id: string, private settings: Record<string, unknown> = {}) {}
  getSettings() { return { width: 640, height: 360, ...this.settings }; }
  clone() { return new Track(`${this.id}-clone`, this.settings); }
}
class Stream {
  constructor(private tracks: Track[]) {}
  getVideoTracks() { return this.tracks.filter((track) => track.kind === "video"); }
  getTracks() { return this.tracks; }
}
class Sender {
  calls: (Track | null)[] = [];
  beforeReplace?: (track: Track | null) => Promise<void>;
  constructor(public track: Track | null) {}
  async replaceTrack(track: Track | null) {
    this.calls.push(track);
    await this.beforeReplace?.(track);
    this.track = track;
  }
}

function createHarness() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "https://meet.google.com/fixture",
    runScripts: "outside-only",
  });
  const win = dom.window as Window & typeof globalThis & Record<string, any>;
  const streams: Stream[] = [];
  const devices = {
    getUserMedia: vi.fn(async () => {
      const stream = streams.shift();
      if (!stream) throw new Error("no fixture stream");
      return stream;
    }),
    getDisplayMedia: vi.fn(async () => {
      const stream = streams.shift();
      if (!stream) throw new Error("no fixture stream");
      return stream;
    }),
  };
  class Peer extends win.EventTarget {
    connectionState = "connected";
    signalingState = "stable";
    senders: Sender[] = [];
    getSenders() { return this.senders; }
  }
  Object.defineProperty(win.navigator, "mediaDevices", { value: devices, configurable: true });
  Object.defineProperty(win, "MediaStreamTrack", { value: Track, configurable: true });
  Object.defineProperty(win, "RTCRtpSender", { value: Sender, configurable: true });
  Object.defineProperty(win, "RTCPeerConnection", { value: Peer, configurable: true, writable: true });
  win.eval(bridgeCode);
  const pc = new win.RTCPeerConnection() as unknown as Peer;
  const processed = new Track("processed");
  const canvas = win.document.createElement("canvas");
  canvas.id = "snap-vanish-rtc-canvas";
  Object.defineProperty(canvas, "captureStream", { value: () => new Stream([processed]) });
  win.document.body.appendChild(canvas);
  let seq = 0;
  function send(action: string, target: EventTarget = win, extra: Record<string, unknown> = {}) {
    return new Promise<Record<string, any>>((resolve, reject) => {
      const requestId = `test-${++seq}`;
      const timer = setTimeout(() => reject(new Error(`no acknowledgement for ${action}`)), 3000);
      const listener = (event: Event) => {
        const detail = (event as CustomEvent).detail;
        if (detail.requestId !== requestId) return;
        clearTimeout(timer);
        win.removeEventListener("snap-vanish:bridge-ack", listener);
        resolve(detail);
      };
      win.addEventListener("snap-vanish:bridge-ack", listener);
      target.dispatchEvent(new win.CustomEvent("snap-vanish:bridge-cmd", {
        bubbles: true,
        detail: { requestId, action, canvasId: canvas.id, ...extra },
      }));
    });
  }
  async function acquire(track: Track, constraints: MediaStreamConstraints = { video: true }) {
    streams.push(new Stream([track]));
    await win.navigator.mediaDevices.getUserMedia(constraints);
    return track;
  }
  function preview(track: Track) {
    const video = win.document.createElement("video");
    Object.defineProperty(video, "srcObject", { value: new Stream([track]), configurable: true });
    win.document.body.appendChild(video);
    return video;
  }
  return { dom, win, pc, processed, send, acquire, preview, streams, devices };
}

const nativeClone = Track.prototype.clone;
const nativeReplaceTrack = Sender.prototype.replaceTrack;
const harnesses: ReturnType<typeof createHarness>[] = [];
function setup() {
  const harness = createHarness();
  harnesses.push(harness);
  return harness;
}
afterEach(() => {
  for (const h of harnesses.splice(0)) h.dom.window.close();
  Track.prototype.clone = nativeClone;
  Sender.prototype.replaceTrack = nativeReplaceTrack;
  vi.restoreAllMocks();
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

describe("camera-only transactional WebRTC bridge", () => {
  it("replaces only the outgoing camera associated with the verified preview", async () => {
    const h = setup();
    const camera = await h.acquire(new Track("camera"));
    const otherCamera = await h.acquire(new Track("other-camera"));
    const screen = new Track("screen", { displaySurface: "monitor" });
    const remoteOrUnknown = new Track("remote");
    const senders = [camera, otherCamera, screen, remoteOrUnknown].map((track) => new Sender(track));
    h.pc.senders = senders;
    const video = h.preview(camera);
    expect((await h.send("CHECK_CAMERA_PREVIEW", video)).ok).toBe(true);
    const result = await h.send("ATTACH_PROCESSED_STREAM", video);
    expect(result).toMatchObject({ ok: true, mode: "webrtc-sender", sendersCount: 1 });
    expect(senders.map((sender) => sender.track)).toEqual([h.processed, otherCamera, screen, remoteOrUnknown]);
    expect((await h.send("RESTORE_ORIGINAL_TRACK")).ok).toBe(true);
    expect(senders.map((sender) => sender.track)).toEqual([camera, otherCamera, screen, remoteOrUnknown]);
    expect(h.processed.stop).toHaveBeenCalledOnce();
  });

  it("fails closed for remote previews, unknown sources, and legacy display capture", async () => {
    const h = setup();
    const legacyScreen = await h.acquire(new Track("legacy-screen"), {
      video: { mandatory: { chromeMediaSource: "desktop" } } as unknown as MediaTrackConstraints,
    });
    const remote = new Track("remote");
    h.pc.senders = [new Sender(legacyScreen), new Sender(remote)];
    for (const track of [legacyScreen, remote]) {
      const video = h.preview(track);
      expect((await h.send("CHECK_CAMERA_PREVIEW", video)).ok).toBe(false);
      expect((await h.send("ATTACH_PROCESSED_STREAM", video)).ok).toBe(false);
    }
    expect(h.pc.senders.map((sender) => sender.track)).toEqual([legacyScreen, remote]);
  });

  it("recognizes clones of the same camera without including other cameras", async () => {
    const h = setup();
    const camera = await h.acquire(new Track("camera"));
    const clone = camera.clone();
    const sender = new Sender(clone);
    h.pc.senders = [sender];
    expect((await h.send("ATTACH_PROCESSED_STREAM", h.preview(camera))).ok).toBe(true);
    expect(sender.track).toBe(h.processed);
    await h.send("RESTORE_ORIGINAL_TRACK");
    expect(sender.track).toBe(clone);
  });

  it("rolls back previously swapped senders if any camera replacement fails", async () => {
    const h = setup();
    const camera = await h.acquire(new Track("camera"));
    const first = new Sender(camera);
    const second = new Sender(camera.clone());
    second.beforeReplace = async (track) => { if (track === h.processed) throw new Error("rejected"); };
    h.pc.senders = [first, second];
    const result = await h.send("ATTACH_PROCESSED_STREAM", h.preview(camera));
    expect(result.ok).toBe(false);
    expect(first.track).toBe(camera);
    expect(second.track?.id).toBe("camera-clone");
    expect(h.processed.stop).toHaveBeenCalledOnce();
  });

  it("serializes emergency restore behind an in-flight attach and never leaves it attached", async () => {
    const h = setup();
    const camera = await h.acquire(new Track("camera"));
    const sender = new Sender(camera);
    const gate = deferred();
    sender.beforeReplace = async (track) => { if (track === h.processed) await gate.promise; };
    h.pc.senders = [sender];
    const attach = h.send("ATTACH_PROCESSED_STREAM", h.preview(camera));
    await vi.waitFor(() => expect(sender.calls).toContain(h.processed));
    const restore = h.send("RESTORE_ORIGINAL_TRACK");
    gate.resolve();
    await Promise.all([attach, restore]);
    expect(sender.track).toBe(camera);
    expect(h.processed.stop).toHaveBeenCalledOnce();
  });

  it.each(["camera-switch", "camera-off"])("does not undo a host %s while vanished", async (action) => {
    const h = setup();
    const camera = await h.acquire(new Track("camera"));
    const next = action === "camera-switch" ? await h.acquire(new Track("new-camera")) : null;
    const sender = new Sender(camera);
    h.pc.senders = [sender];
    expect((await h.send("ATTACH_PROCESSED_STREAM", h.preview(camera))).ok).toBe(true);
    await sender.replaceTrack(next);
    await h.send("RESTORE_ORIGINAL_TRACK");
    expect(sender.track).toBe(next);
  });

  it("honors a host camera switch racing a slow attach", async () => {
    const h = setup();
    const camera = await h.acquire(new Track("camera"));
    const next = await h.acquire(new Track("new-camera"));
    const sender = new Sender(camera);
    const gate = deferred();
    sender.beforeReplace = async (track) => { if (track === h.processed) await gate.promise; };
    h.pc.senders = [sender];
    const attach = h.send("ATTACH_PROCESSED_STREAM", h.preview(camera));
    await vi.waitFor(() => expect(sender.calls).toContain(h.processed));
    await sender.replaceTrack(next);
    gate.resolve();
    await attach;
    await h.send("RESTORE_ORIGINAL_TRACK");
    expect(sender.track).toBe(next);
  });

  it("reports restore failures, keeps the processed track alive, and allows retry", async () => {
    const h = setup();
    const camera = await h.acquire(new Track("camera"));
    const sender = new Sender(camera);
    h.pc.senders = [sender];
    expect((await h.send("ATTACH_PROCESSED_STREAM", h.preview(camera))).ok).toBe(true);
    sender.beforeReplace = async (track) => { if (track === camera) throw new Error("restore rejected"); };
    const result = await h.send("RESTORE_ORIGINAL_TRACK");
    expect(result.ok).toBe(false);
    expect(sender.track).toBe(h.processed);
    expect(h.processed.stop).not.toHaveBeenCalled();
    sender.beforeReplace = undefined;
    expect((await h.send("RESTORE_ORIGINAL_TRACK")).ok).toBe(true);
    expect(sender.track).toBe(camera);
    expect(h.processed.stop).toHaveBeenCalledOnce();
  });

  it("honors a host camera switch racing a slow restore", async () => {
    const h = setup();
    const camera = await h.acquire(new Track("camera"));
    const next = await h.acquire(new Track("new-camera"));
    const sender = new Sender(camera);
    h.pc.senders = [sender];
    expect((await h.send("ATTACH_PROCESSED_STREAM", h.preview(camera))).ok).toBe(true);
    const gate = deferred();
    sender.beforeReplace = async (track) => { if (track === camera) await gate.promise; };
    const restore = h.send("RESTORE_ORIGINAL_TRACK");
    await vi.waitFor(() => expect(sender.calls).toContain(camera));
    await sender.replaceTrack(next);
    gate.resolve();
    expect((await restore).ok).toBe(true);
    expect(sender.track).toBe(next);
  });

  it("refuses interception if sender changes cannot be observed", async () => {
    const h = setup();
    const camera = await h.acquire(new Track("camera"));
    const sender = new Sender(camera);
    sender.replaceTrack = vi.fn(async (track: Track | null) => { sender.track = track; });
    h.pc.senders = [sender];
    const result = await h.send("ATTACH_PROCESSED_STREAM", h.preview(camera));
    expect(result).toMatchObject({ ok: false, reason: "unobservable-sender" });
    expect(sender.track).toBe(camera);
    expect(sender.replaceTrack).not.toHaveBeenCalled();
  });
});
