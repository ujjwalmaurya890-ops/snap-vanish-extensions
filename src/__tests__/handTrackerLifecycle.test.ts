// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ hand: vi.fn(), segmenter: vi.fn() }));
vi.mock("@mediapipe/tasks-vision", () => ({
  HandLandmarker: { createFromOptions: mocks.hand },
  ImageSegmenter: { createFromOptions: mocks.segmenter },
}));
vi.mock("../lib/messaging", () => ({
  resolveBundledAssetUrl: (path: string) => path.endsWith(".js") ? "data:text/javascript,export default function factory(){}" : path,
}));
import { HandLandmarkService } from "../features/detection/handTracker";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}
function model() { return { close: vi.fn(), detectForVideo: vi.fn() }; }
afterEach(() => { vi.clearAllMocks(); Reflect.deleteProperty(globalThis, "ModuleFactory"); });

describe("Studio hand model lifecycle", () => {
  it("closes a model that resolves after disposal and does not report ready", async () => {
    const pending = deferred<ReturnType<typeof model>>();
    mocks.hand.mockReturnValueOnce(pending.promise);
    const service = new HandLandmarkService();
    const progress = vi.fn();
    const startup = service.initialize({ onProgress: progress });
    await vi.waitFor(() => expect(mocks.hand).toHaveBeenCalledOnce());
    service.dispose();
    const late = model();
    pending.resolve(late);
    expect(await startup).toMatchObject({ ok: false, cancelled: true });
    expect(late.close).toHaveBeenCalledOnce();
    expect(service.currentStatus).toBe("unloaded");
    expect(progress).not.toHaveBeenCalledWith(100, expect.anything());
  });

  it("does not let stale initialization overwrite a newer model", async () => {
    const first = deferred<ReturnType<typeof model>>();
    const second = deferred<ReturnType<typeof model>>();
    mocks.hand.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const service = new HandLandmarkService();
    const oldStart = service.initialize();
    await vi.waitFor(() => expect(mocks.hand).toHaveBeenCalledTimes(1));
    service.dispose();
    const newStart = service.initialize();
    await vi.waitFor(() => expect(mocks.hand).toHaveBeenCalledTimes(2));
    const fresh = model(); second.resolve(fresh);
    expect((await newStart).ok).toBe(true);
    const stale = model(); first.resolve(stale);
    expect(await oldStart).toMatchObject({ ok: false, cancelled: true });
    expect(stale.close).toHaveBeenCalledOnce();
    expect(service.currentStatus).toBe("ready");
    expect(fresh.close).not.toHaveBeenCalled();
    service.dispose();
    expect(fresh.close).toHaveBeenCalledOnce();
  });

  it("shares concurrent startup, falls back from GPU to CPU, and closes on dispose", async () => {
    const result = model();
    mocks.hand.mockRejectedValueOnce(new Error("GPU unavailable")).mockResolvedValueOnce(result);
    const service = new HandLandmarkService();
    const [a, b] = await Promise.all([service.initialize(), service.initialize()]);
    expect(a.ok && b.ok).toBe(true);
    expect(mocks.hand).toHaveBeenCalledTimes(2);
    expect(mocks.hand.mock.calls[0][1].baseOptions.delegate).toBe("GPU");
    expect(mocks.hand.mock.calls[1][1].baseOptions.delegate).toBe("CPU");
    service.dispose();
    expect(result.close).toHaveBeenCalledOnce();
  });

  it("closes both tasks if segmentation finishes after disposal", async () => {
    const segmenter = deferred<{ close: ReturnType<typeof vi.fn> }>();
    const hand = model();
    mocks.hand.mockResolvedValueOnce(hand);
    mocks.segmenter.mockReturnValueOnce(segmenter.promise);
    const service = new HandLandmarkService();
    const startup = service.initialize({ enableSegmentation: true });
    await vi.waitFor(() => expect(mocks.segmenter).toHaveBeenCalledOnce());
    service.dispose();
    const lateSeg = { close: vi.fn() };
    segmenter.resolve(lateSeg);
    expect(await startup).toMatchObject({ ok: false, cancelled: true });
    expect(hand.close).toHaveBeenCalledOnce();
    expect(lateSeg.close).toHaveBeenCalledOnce();
  });
});
