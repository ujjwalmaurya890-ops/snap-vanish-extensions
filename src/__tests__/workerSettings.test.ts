// @vitest-environment node
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../lib/settings";

const code = fs.readFileSync(path.resolve("extension/background.js"), "utf8");
const KEY = "snap_vanish_settings_v2";
const clone = <T>(value: T): T => structuredClone(value);

function event() {
  const listeners: Array<(...args: any[]) => any> = [];
  return {
    addListener: (fn: (...args: any[]) => any) => listeners.push(fn),
    emit: (...args: any[]) => listeners.map((fn) => fn(...args)),
    listeners,
  };
}

function worker(initial: Record<string, any> = {}) {
  const syncData = clone(initial);
  const sessionData: Record<string, any> = {};
  const changed = event(), installed = event(), startup = event(), messages = event(), commands = event();
  const removed = event(), updated = event();
  let writes = 0;
  let rejectWrites = false;
  const sync = {
    get: vi.fn(async () => clone(syncData)),
    set: vi.fn(async (items: Record<string, any>) => {
      if (rejectWrites) throw new Error("quota exceeded");
      writes += 1;
      const changes: Record<string, any> = {};
      for (const [key, value] of Object.entries(items)) {
        changes[key] = { oldValue: clone(syncData[key]), newValue: clone(value) };
        syncData[key] = clone(value);
      }
      changed.emit(changes, "sync");
    }),
  };
  const area = {
    get: vi.fn(async (key: string) => ({ [key]: clone(sessionData[key]) })),
    set: vi.fn(async (items: Record<string, any>) => { Object.assign(sessionData, clone(items)); }),
    clear: vi.fn(async () => {}),
  };
  const chrome = {
    runtime: { id: "test-extension", onInstalled: installed, onStartup: startup, onMessage: messages,
      openOptionsPage: vi.fn(async () => {}), getContexts: vi.fn(async () => []), getURL: (value: string) => value },
    storage: { sync, session: area, local: area, onChanged: changed },
    tabs: { onRemoved: removed, onUpdated: updated, query: vi.fn(async () => []), get: vi.fn(), sendMessage: vi.fn() },
    action: { setBadgeText: vi.fn(async () => {}), setBadgeBackgroundColor: vi.fn(async () => {}) },
    commands: { onCommand: commands },
    offscreen: { createDocument: vi.fn(async () => {}) },
  };
  vm.runInNewContext(code, { chrome, URL, console, setTimeout, clearTimeout, Promise });
  const send = (type: string, payload?: Record<string, any>) => new Promise<Record<string, any>>((resolve) => {
    messages.emit({ type, payload }, { id: "test-extension" }, resolve);
  });
  return {
    syncData, sync, installed, commands, send,
    get writes() { return writes; },
    failWrites() { rejectWrites = true; },
  };
}

describe("canonical settings worker", () => {
  it("uses defaults identical to Studio and migrates valid legacy flat settings", async () => {
    const fresh = worker();
    await Promise.all(fresh.installed.emit({ reason: "update" }));
    expect(fresh.syncData[KEY]).toEqual(DEFAULT_SETTINGS);

    const legacy = worker({ enabled: false, sensitivity: 48, effect: "fade-out" });
    await Promise.all(legacy.installed.emit({ reason: "update" }));
    expect(legacy.syncData[KEY]).toMatchObject({ enabled: false, sensitivity: 48, effect: "fade-out", gesture: { sensitivity: 48 } });
  });

  it("prefers canonical settings over stale flat mirrors and toggles repeatedly", async () => {
    const h = worker({ enabled: false, [KEY]: { ...DEFAULT_SETTINGS, enabled: true } });
    h.commands.emit("toggle-snap");
    await vi.waitFor(() => expect(h.syncData[KEY].enabled).toBe(false));
    h.commands.emit("toggle-snap");
    await vi.waitFor(() => expect(h.syncData[KEY].enabled).toBe(true));
    expect(h.writes).toBe(2);
    expect(h.syncData.enabled).toBe(false); // legacy mirror is no longer written or read
  });

  it("serializes concurrent shortcut toggles instead of dropping one", async () => {
    const h = worker({ [KEY]: DEFAULT_SETTINGS });
    h.commands.emit("toggle-snap");
    h.commands.emit("toggle-snap");
    await vi.waitFor(() => expect(h.writes).toBe(2));
    expect(h.syncData[KEY].enabled).toBe(true);
  });

  it("coalesces a slider burst into one write while preserving other fields", async () => {
    const h = worker({ [KEY]: { ...DEFAULT_SETTINGS, effect: "fade-out" } });
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => h.send("SETTINGS_CHANGED", { sensitivity: i + 40 })));
    expect(results.every((r) => r.ok)).toBe(true);
    expect(h.writes).toBe(1);
    expect(h.syncData[KEY]).toMatchObject({ effect: "fade-out", sensitivity: 59, gesture: { sensitivity: 59 } });
    expect(h.sync.set.mock.calls[0][0]).toHaveProperty(KEY);
    expect(Object.keys(h.sync.set.mock.calls[0][0])).toEqual([KEY]);
  });

  it("merges concurrent nested patches and retains validated Studio fields", async () => {
    const h = worker({ [KEY]: DEFAULT_SETTINGS });
    const results = await Promise.all([
      h.send("SETTINGS_CHANGED", { gesture: { actionMapping: "restore-only" }, meetingMode: "professional" }),
      h.send("SETTINGS_CHANGED", { audio: { enabled: false }, shortcuts: { toggleSnap: "Ctrl+Shift+S" } }),
    ]);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(h.writes).toBe(1);
    expect(h.syncData[KEY]).toMatchObject({ meetingMode: "professional", gesture: { actionMapping: "restore-only" }, audio: { enabled: false }, shortcuts: { toggleSnap: "Ctrl+Shift+S" } });
  });

  it("flushes a pending UI edit before applying a shortcut toggle", async () => {
    const h = worker({ [KEY]: DEFAULT_SETTINGS });
    const edit = h.send("SETTINGS_CHANGED", { enabled: false, density: 40 });
    h.commands.emit("toggle-snap");
    expect((await edit).ok).toBe(true);
    await vi.waitFor(() => expect(h.writes).toBe(2));
    expect(h.syncData[KEY]).toMatchObject({ enabled: true, density: 40 });
  });

  it("re-reads canonical data after a worker restart", async () => {
    const first = worker({ [KEY]: DEFAULT_SETTINGS });
    expect((await first.send("SETTINGS_CHANGED", { enabled: false })).ok).toBe(true);
    const restarted = worker(first.syncData);
    restarted.commands.emit("toggle-snap");
    await vi.waitFor(() => expect(restarted.syncData[KEY].enabled).toBe(true));
  });

  it("reports storage failures instead of claiming settings were saved", async () => {
    const h = worker({ [KEY]: DEFAULT_SETTINGS });
    h.failWrites();
    const response = await h.send("SETTINGS_CHANGED", { enabled: false });
    expect(response).toMatchObject({ ok: false, reason: "handler-error" });
    expect(h.syncData[KEY].enabled).toBe(true);
  });

  it("clamps numeric values and rejects malformed or unknown fields", async () => {
    const h = worker({ [KEY]: DEFAULT_SETTINGS });
    const response = await h.send("SETTINGS_CHANGED", { sensitivity: 101, duration: null, injected: "bad", gesture: { actionMapping: "invented" } });
    expect(response.ok).toBe(true);
    expect(h.syncData[KEY]).toMatchObject({ sensitivity: 100, duration: DEFAULT_SETTINGS.duration, gesture: { sensitivity: 100, actionMapping: DEFAULT_SETTINGS.gesture.actionMapping } });
    expect(h.syncData[KEY].injected).toBeUndefined();
  });
});
