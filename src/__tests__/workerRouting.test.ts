// @vitest-environment node
import fs from "node:fs";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";

const source = fs.readFileSync("extension/background.js", "utf8");
type Tab = { id: number; url: string };
function event() {
  const listeners: Array<(...args: any[]) => any> = [];
  return { addListener: (fn: (...args: any[]) => any) => listeners.push(fn), emit: (...args: any[]) => listeners.map((fn) => fn(...args)) };
}
function harness(tabs: Tab[], activeId: number, replies: Record<number, any> = {}) {
  const messages = event();
  const session: Record<string, any> = { sv_target_tab: 1, sv_tabs_v2: { 1: { engineState: "vanished", interceptionMode: "webrtc-sender" } } };
  const area = {
    get: async (key: string) => ({ [key]: session[key] }),
    set: async (data: any) => { Object.assign(session, data); },
    clear: async () => {},
  };
  const sendMessage = vi.fn(async (id: number, _message: unknown): Promise<any> => {
    const reply = replies[id];
    if (reply instanceof Error) throw reply;
    return reply === undefined ? { ok: true, engineState: "live", host: new URL(tabs.find((t) => t.id === id)!.url).hostname } : reply;
  });
  let offscreenOpen = false;
  const offscreenMessages = vi.fn(async (message: any) => {
    if (message.type === "OFFSCREEN_HAND_INFER") return { ok: true, landmarks: [], worldLandmarks: [] };
    return { ok: true };
  });
  const onRemoved = event();
  const onUpdated = event();
  const chrome = {
    runtime: { id: "ext", onInstalled: event(), onStartup: event(), onMessage: messages,
      getURL: (path: string) => `chrome-extension://ext/${path}`,
      getContexts: async () => offscreenOpen ? [{}] : [], sendMessage: offscreenMessages },
    offscreen: { createDocument: vi.fn(async () => { offscreenOpen = true; }) },
    storage: { sync: { get: async () => ({}) }, session: area, local: area, onChanged: event() },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
    tabs: { onRemoved, onUpdated, query: async (q: any) => q.active ? tabs.filter((t) => t.id === activeId) : tabs,
      get: async (id: number) => tabs.find((t) => t.id === id), sendMessage },
    commands: { onCommand: event() },
  };
  vm.runInNewContext(source, { chrome, URL, console, setTimeout, clearTimeout, Promise });
  const send = (type: string, sender: any = { id: "ext" }, payload?: unknown) => new Promise<Record<string, any>>((resolve) => messages.emit({ type, payload }, sender, resolve));
  return { send, sendMessage, session, offscreenMessages, onRemoved, onUpdated, createOffscreen: chrome.offscreen.createDocument };
}
const meet = { id: 1, url: "https://meet.google.com/abc" };
const teams = { id: 2, url: "https://teams.microsoft.com/call" };

describe("meeting target routing and truthful responses", () => {
  it("prefers the active meeting over a remembered background meeting", async () => {
    const h = harness([meet, teams], 2);
    expect(await h.send("SNAP_VANISH_NOW")).toMatchObject({ ok: true, tabId: 2 });
    expect(h.sendMessage.mock.calls.map((call) => call[0])).toEqual([2]);
  });

  it("refuses arbitrary targeting when multiple meetings are open and none is active", async () => {
    const h = harness([meet, teams, { id: 3, url: "https://example.com" }], 3);
    expect(await h.send("MUTE_TOGGLE")).toMatchObject({ ok: false, reason: "multiple-meeting-tabs" });
    expect(h.sendMessage).not.toHaveBeenCalled();
  });

  it("routes from the Studio extension tab to the only meeting, not back to itself", async () => {
    const studio = { id: 99, url: "chrome-extension://ext/studio/index.html" };
    const h = harness([meet, studio], 99);
    expect(await h.send("GET_STATE", { id: "ext", tab: studio })).toMatchObject({ ok: true, tabId: 1 });
    expect(await h.send("SNAP_VANISH_NOW", { id: "ext", tab: studio })).toMatchObject({ ok: true, tabId: 1 });
    expect(h.sendMessage.mock.calls.map((call) => call[0])).toEqual([1, 1]);
  });

  it("keeps content-originated actions on their own supported tab", async () => {
    const h = harness([meet, teams], 2);
    expect(await h.send("SNAP_VANISH_NOW", { id: "ext", tab: meet })).toMatchObject({ ok: true, tabId: 1 });
  });

  it("excludes lookalike hosts and Zoom pages outside the injected path", async () => {
    const h = harness([{ id: 3, url: "https://meet.google.com.evil.test/x" }, { id: 4, url: "https://foo.zoom.us/not-a-call" }], 4);
    expect(await h.send("GET_STATE")).toMatchObject({ ok: false, reason: "no-supported-meeting-tab" });
    expect(h.sendMessage).not.toHaveBeenCalled();
  });

  it("never promotes an unreachable tab's stale cached state to a live success", async () => {
    const h = harness([meet], 1, { 1: new Error("receiving end missing") });
    expect(await h.send("GET_STATE")).toMatchObject({ ok: false, reason: "content-script-unreachable" });
    expect(h.session.sv_tabs_v2[1]).toBeUndefined();
  });

  it("reports empty responses and partial emergency restores as failures", async () => {
    const h = harness([meet, teams], 1, { 1: { ok: true }, 2: new Error("unreachable") });
    expect(await h.send("EMERGENCY_RESTORE")).toMatchObject({ ok: false, reason: "restore-incomplete", attempted: 2, delivered: 1 });
    h.sendMessage.mockResolvedValueOnce(null);
    expect(await h.send("SNAP_VANISH_NOW")).toMatchObject({ ok: false, reason: "empty-response" });
    const empty = harness([], 0);
    expect(await empty.send("EMERGENCY_RESTORE")).toMatchObject({ ok: false, attempted: 0 });
  });
});


describe("CSP fallback routing", () => {
  it("permits only supported meeting senders and keys inference to the sender tab", async () => {
    const h = harness([meet, teams], 2);
    expect(await h.send("HAND_MODEL_START", { id: "ext" }, { minConfidence: 0.8 })).toMatchObject({ ok: false, reason: "unexpected-sender" });
    expect(await h.send("HAND_MODEL_START", { id: "ext", tab: { id: 9, url: "https://example.com" } })).toMatchObject({ ok: false, reason: "unexpected-sender" });
    expect(await h.send("HAND_MODEL_START", { id: "ext", tab: meet, frameId: 3 })).toMatchObject({ ok: false, reason: "unexpected-sender" });
    expect(h.createOffscreen).not.toHaveBeenCalled();
    expect(await h.send("HAND_MODEL_START", { id: "ext", tab: meet }, { tabId: 2, minConfidence: 2 })).toMatchObject({ ok: true });
    expect(h.createOffscreen).toHaveBeenCalledOnce();
    expect(h.offscreenMessages).toHaveBeenCalledWith({ type: "OFFSCREEN_HAND_START", payload: { tabId: 1, minConfidence: 0.95 } });
    const frame = "data:image/jpeg;base64,AAAA";
    expect(await h.send("HAND_MODEL_INFER", { id: "ext", tab: teams }, { tabId: 1, frame, timestamp: 42 })).toMatchObject({ ok: true });
    expect(h.offscreenMessages).toHaveBeenCalledWith({ type: "OFFSCREEN_HAND_INFER", payload: { tabId: 2, frame, timestamp: 42 } });
  });

  it("rejects invalid or oversized frames and releases models on navigation/removal", async () => {
    const h = harness([meet], 1);
    const sender = { id: "ext", tab: meet };
    expect(await h.send("HAND_MODEL_INFER", sender, { frame: "not-an-image" })).toMatchObject({ ok: false, reason: "invalid-frame" });
    expect(await h.send("HAND_MODEL_INFER", sender, { frame: `data:image/jpeg;base64,${"A".repeat(250000)}` })).toMatchObject({ ok: false, reason: "invalid-frame" });
    await h.send("HAND_MODEL_START", sender);
    await h.send("HAND_MODEL_RELEASE", sender);
    expect(h.offscreenMessages).toHaveBeenCalledWith({ type: "OFFSCREEN_HAND_RELEASE", payload: { tabId: 1 } });
    h.offscreenMessages.mockClear();
    h.onUpdated.emit(1, { status: "loading" });
    h.onRemoved.emit(2);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.offscreenMessages).toHaveBeenCalledWith({ type: "OFFSCREEN_HAND_RELEASE", payload: { tabId: 1 } });
    expect(h.offscreenMessages).toHaveBeenCalledWith({ type: "OFFSCREEN_HAND_RELEASE", payload: { tabId: 2 } });
  });
});
