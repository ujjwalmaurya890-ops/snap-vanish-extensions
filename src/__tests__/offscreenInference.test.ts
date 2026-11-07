// @vitest-environment node
import fs from "node:fs";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";

const original = fs.readFileSync("extension/offscreen/offscreen.js", "utf8");
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((r, j) => { resolve = r; reject = j; });
  return { promise, resolve, reject };
}
function model() {
  return {
    close: vi.fn(),
    detectForVideo: vi.fn(() => ({ landmarks: [[{ x: 0.1, y: 0.2, z: 0 }]], worldLandmarks: [] })),
  };
}
function harness(create = vi.fn(async () => model())) {
  let listener: (...args: any[]) => any = () => false;
  const bitmap = { width: 256, height: 144, close: vi.fn() };
  const decode = vi.fn(async () => bitmap);
  const factory = () => {};
  const sandbox: Record<string, any> = {
    console, Promise, Uint8Array, Blob, atob,
    createImageBitmap: decode,
    mockWasmImport: async () => ({ default: factory }),
    mockVisionImport: async () => ({ HandLandmarker: { createFromOptions: create } }),
    chrome: { runtime: { id: "ext", getURL: (path: string) => `chrome-extension://ext/${path}`, onMessage: { addListener: (fn: any) => { listener = fn; } } } },
  };
  const source = original
    .replace('await import(chrome.runtime.getURL("wasm/vision_wasm_module_internal.js"))', "await mockWasmImport()")
    .replace('await import(chrome.runtime.getURL("vendor/vision_bundle.mjs"))', "await mockVisionImport()");
  expect(source).not.toBe(original);
  vm.runInNewContext(`${source}\nglobalThis.testApi = { startHandModel, inferHandFrame, releaseHandModel, count: () => handModels.size };`, sandbox);
  return { api: sandbox.testApi, create, bitmap, decode, send: (...args: any[]) => listener(...args) };
}
const jpeg = "data:image/jpeg;base64,AAAA";

describe("extension-origin local inference", () => {
  it("isolates models by tab, caps capacity, and releases them", async () => {
    const h = harness();
    for (let id = 1; id <= 4; id += 1) expect((await h.api.startHandModel(id, 0.62)).ok).toBe(true);
    expect(h.create).toHaveBeenCalledTimes(4);
    expect(await h.api.startHandModel(5, 0.62)).toMatchObject({ ok: false, reason: "model-capacity" });
    const first = await h.create.mock.results[0].value;
    const second = await h.create.mock.results[1].value;
    await h.api.inferHandFrame(1, jpeg, 5);
    expect(first.detectForVideo).toHaveBeenCalledOnce();
    expect(second.detectForVideo).not.toHaveBeenCalled();
    h.api.releaseHandModel(1);
    expect(first.close).toHaveBeenCalledOnce();
    expect(h.api.count()).toBe(3);
    expect((await h.api.startHandModel(5, 0.62)).ok).toBe(true);
  });

  it("closes a model that finishes loading after its tab is released", async () => {
    const pending = deferred<ReturnType<typeof model>>();
    const create = vi.fn(() => pending.promise);
    const h = harness(create);
    const startup = h.api.startHandModel(1, 0.62);
    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
    h.api.releaseHandModel(1);
    const lateModel = model();
    pending.resolve(lateModel);
    expect(await startup).toMatchObject({ ok: false, reason: "cancelled" });
    expect(lateModel.close).toHaveBeenCalledOnce();
    expect(h.api.count()).toBe(0);
  });

  it("decodes only bounded JPEG frames, keeps timestamps monotonic, and closes failed models", async () => {
    const h = harness();
    await h.api.startHandModel(4, 0.62);
    const instance = await h.create.mock.results[0].value;
    expect(await h.api.inferHandFrame(4, "data:image/png;base64,AA", 1)).toMatchObject({ ok: false, reason: "invalid-frame" });
    expect(h.decode).not.toHaveBeenCalled();
    expect((await h.api.inferHandFrame(4, jpeg, 10)).ok).toBe(true);
    expect((await h.api.inferHandFrame(4, jpeg, 5)).ok).toBe(true);
    expect(instance.detectForVideo.mock.calls.map((call: any[]) => call[1])).toEqual([10, 11]);
    expect(h.bitmap.close).toHaveBeenCalledTimes(2);
    instance.detectForVideo.mockImplementationOnce(() => { throw new Error("broken model"); });
    expect(await h.api.inferHandFrame(4, jpeg, 20)).toMatchObject({ ok: false, reason: "inference-failed" });
    expect(instance.close).toHaveBeenCalledOnce();
    expect(h.api.count()).toBe(0);
  });

  it("does not let a stale decode failure release a newer tab model", async () => {
    const h = harness();
    await h.api.startHandModel(1, 0.62);
    const pending = deferred<typeof h.bitmap>();
    h.decode.mockReturnValueOnce(pending.promise);
    const oldInference = h.api.inferHandFrame(1, jpeg, 10);
    h.api.releaseHandModel(1);
    await h.api.startHandModel(1, 0.62);
    const replacement = await h.create.mock.results[1].value;
    pending.reject(new Error("old decode failed"));
    expect(await oldInference).toMatchObject({ ok: false, reason: "inference-failed" });
    expect(replacement.close).not.toHaveBeenCalled();
    expect(h.api.count()).toBe(1);
    h.api.releaseHandModel(1);
  });

  it("does not accept model commands directly from content scripts or other extension pages", () => {
    const h = harness();
    const response = vi.fn();
    expect(h.send({ type: "OFFSCREEN_HAND_START", payload: { tabId: 1 } }, { id: "ext", tab: { id: 1 } }, response)).toBe(false);
    expect(h.send({ type: "OFFSCREEN_HAND_START", payload: { tabId: 1 } }, { id: "ext", url: "chrome-extension://ext/popup/popup.html" }, response)).toBe(false);
    expect(response).not.toHaveBeenCalled();
  });
});
