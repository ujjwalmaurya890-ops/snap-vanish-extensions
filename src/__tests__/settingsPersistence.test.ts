// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, loadSettingsSync, saveSettingsPatch, STORAGE_KEYS } from "../lib/settings";

afterEach(() => {
  delete (globalThis as Record<string, unknown>).chrome;
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("Studio settings persistence", () => {
  it("sends only the patch through the worker and does not independently write sync storage", async () => {
    const set = vi.fn(async () => {});
    const sendMessage = vi.fn((message: unknown, callback: (value: unknown) => void) => {
      expect(message).toEqual({ type: "SETTINGS_CHANGED", payload: { enabled: false } });
      callback({ ok: true });
    });
    (globalThis as Record<string, unknown>).chrome = {
      runtime: { id: "extension", sendMessage }, storage: { sync: { set } },
    };
    const snapshot = { ...DEFAULT_SETTINGS, enabled: false };
    await saveSettingsPatch({ enabled: false }, snapshot);
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(set).not.toHaveBeenCalled();
    expect(loadSettingsSync().enabled).toBe(false);
  });

  it("reports a worker save error while retaining the local snapshot", async () => {
    (globalThis as Record<string, unknown>).chrome = {
      runtime: { id: "extension", sendMessage: (_message: unknown, callback: (value: unknown) => void) => callback({ ok: false, reason: "quota" }) },
    };
    await expect(saveSettingsPatch({ enabled: false }, { ...DEFAULT_SETTINGS, enabled: false })).rejects.toThrow("quota");
    expect(loadSettingsSync().enabled).toBe(false);
  });

  it("uses one canonical document with a storage-only shim", async () => {
    const set = vi.fn(async (_items: Record<string, unknown>) => {});
    (globalThis as Record<string, unknown>).chrome = { storage: { sync: { set } } };
    await saveSettingsPatch({ enabled: false }, { ...DEFAULT_SETTINGS, enabled: false });
    expect(Object.keys(set.mock.calls[0][0])).toEqual([STORAGE_KEYS.SETTINGS]);
  });
});
