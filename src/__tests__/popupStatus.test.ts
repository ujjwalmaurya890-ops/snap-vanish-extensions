// @vitest-environment node
import fs from "node:fs";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";

const { JSDOM } = createRequire(import.meta.url)("jsdom") as { JSDOM: new (...args: any[]) => any };
const html = fs.readFileSync("extension/popup/popup.html", "utf8");
const script = fs.readFileSync("extension/popup/popup.js", "utf8");
const windows: Array<{ window: { close: () => void } }> = [];
const baseState = { ok: true, host: "meet.google.com", engineState: "live", interceptionMode: "dom-overlay", cameraPresent: true, muted: null, handModelReady: false, detectionActive: false, detectionStatus: "model-not-ready", audioGateActive: false };
function popup(state: Record<string, any>, actionResponse: Record<string, any> = { ok: true }) {
  const dom = new JSDOM(html, { url: "https://extension.test/popup.html", runScripts: "outside-only", pretendToBeVisual: true });
  windows.push(dom);
  const win = dom.window as any;
  const messages: any[] = [];
  win.chrome = {
    runtime: { getManifest: () => ({ version: "2.1.0" }), sendMessage: (msg: any, cb?: (value: any) => void) => {
      messages.push(msg);
      cb?.(msg.type === "GET_STATE" ? state : msg.type === "SETTINGS_CHANGED" ? { ok: true } : actionResponse);
    } },
    storage: { sync: { get: (_: unknown, cb: (value: unknown) => void) => cb({ snap_vanish_settings_v2: { enabled: true, sensitivity: 0, gesture: { detectionMode: "smart", requireAudioConfirm: true }, audio: { enabled: true } } }) },
      local: { get: (_: unknown, cb: (value: unknown) => void) => cb({}), set: () => {} }, onChanged: { addListener: () => {} } },
    commands: { getAll: (cb: (value: unknown) => void) => cb([]) }, tabs: { create: () => {} },
  };
  win.eval(script);
  const element = (id: string) => win.document.getElementById(id) as HTMLElement;
  return { win, element, messages };
}
afterEach(() => { for (const dom of windows.splice(0)) dom.window.close(); vi.restoreAllMocks(); });

describe("popup status and keyboard controls", () => {
  it("does not claim detection, microphone or outgoing effects that are not confirmed", () => {
    const h = popup(baseState);
    expect(h.element("status-text").textContent).toBe("SUPPORTED TAB");
    expect(h.element("stat-detection").textContent).toBe("Model not ready");
    expect(h.element("stat-mic").textContent).toBe("Unknown");
    expect((h.element("mic-toggle") as HTMLButtonElement).disabled).toBe(true);
    expect(h.element("stat-stream").textContent).toBe("No effect");
    expect((h.element("sens-range") as HTMLInputElement).value).toBe("0");
  });

  it("distinguishes local-only overlays from confirmed outgoing effects", () => {
    const local = popup({ ...baseState, engineState: "vanished" });
    expect(local.element("status-text").textContent).toBe("LOCAL TILE ONLY");
    expect(local.element("stat-stream").textContent).toBe("Local tile only");
    const sender = popup({ ...baseState, engineState: "vanished", interceptionMode: "webrtc-sender" });
    expect(sender.element("status-text").textContent).toBe("EFFECT ON CAMERA");
    expect(sender.element("stat-stream").textContent).toBe("Effect sent");
  });

  it("warns about a restore failure even if the local state says live", () => {
    const h = popup({ ...baseState, restoreError: "replace-failed", interceptionMode: "webrtc-sender" });
    expect(h.element("status-text").textContent).toBe("CAMERA RESTORE FAILED");
    expect(h.element("stat-stream").textContent).toBe("Restore failed");
  });

  it("does not render stale cached successes as live when no target can be chosen", () => {
    const h = popup({ ok: false, reason: "multiple-meeting-tabs", cached: true, engineState: "vanished", host: "meet.google.com" });
    expect(h.element("status-text").textContent).toBe("SELECT A MEETING TAB");
    expect(h.element("stat-stream").textContent).toBe("Unknown");
    expect((h.element("btn-vanish") as HTMLButtonElement).disabled).toBe(true);
  });

  it("supports arrow-key radio selection and exposes pressed state", () => {
    const h = popup(baseState);
    const smart = h.win.document.querySelector('[data-mode="smart"]') as HTMLButtonElement;
    const gesture = h.win.document.querySelector('[data-mode="gesture-only"]') as HTMLButtonElement;
    smart.focus();
    smart.dispatchEvent(new h.win.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(h.win.document.activeElement).toBe(gesture);
    expect(gesture.getAttribute("aria-checked")).toBe("true");
    expect(gesture.tabIndex).toBe(0);
    expect(smart.tabIndex).toBe(-1);
    expect(h.messages).toContainEqual(expect.objectContaining({ type: "SETTINGS_CHANGED", payload: expect.objectContaining({ gesture: expect.objectContaining({ detectionMode: "gesture-only" }) }) }));
    h.element("lowpower-toggle").click();
    expect(h.element("lowpower-toggle").getAttribute("aria-pressed")).toBe("true");
  });

  it("offers review and clearing without approving a captured frame from the popup", () => {
    const h = popup({ ...baseState, cleanPlateStatus: "review" });
    expect(h.element("btn-capture-plate").textContent).toBe("Review plate");
    expect(h.element("plate-state").textContent).toContain("solid background");
    h.element("btn-capture-plate").click();
    h.element("btn-clear-plate").click();
    expect(h.messages.map((m) => m.type)).toContain("REVIEW_CLEAN_PLATE");
    expect(h.messages.map((m) => m.type)).toContain("CLEAR_CLEAN_PLATE");
    expect(h.messages.map((m) => m.type)).not.toContain("APPROVE_CLEAN_PLATE");
  });

  it("surfaces a partial emergency-restore failure", () => {
    const h = popup(baseState, { ok: false, reason: "restore-incomplete" });
    h.element("btn-restore").click();
    expect(h.element("action-error").hidden).toBe(false);
    expect(h.element("action-error").textContent).toContain("Check your meeting camera");
  });
});
