/**
 * Snap Vanish — Offscreen Local Audio and CSP-safe Hand Inference
 *
 * WHY THIS EXISTS
 * `chrome.commands` keyboard shortcuts and toolbar actions have no user
 * activation in the meeting tab, so an `AudioContext` created by the content
 * script can stay `suspended` and the snap-confirmation cue is silently dropped.
 * An offscreen document created with `reasons: ["AUDIO_PLAYBACK"]` is allowed to
 * start an AudioContext and render audio without user activation, so the cue is
 * guaranteed to be audible.
 *
 * DESIGN NOTES
 * - One long-lived `AudioContext`; the noise-burst buffer is synthesised once and
 *   cached per cue. The previous implementation created (and closed) a brand new
 *   AudioContext per cue inside the meeting page.
 * - When a meeting CSP blocks WebAssembly, a throttled JPEG frame is decoded
 *   locally as a Blob, inferred, and discarded. Frames are never stored or sent
 *   to a network endpoint. Each meeting tab has its own model and tracker state.
 * - Models are released on pause, tab teardown/removal, or inference failure.
 */

const SAMPLE_RATE_FALLBACK = 48_000;
const CUES = {
  snap: { duration: 0.055, centreHz: 3400, q: 1.4, gain: 0.32, decay: 3.2 },
  restore: { duration: 0.075, centreHz: 2200, q: 1.1, gain: 0.26, decay: 2.4 },
  error: { duration: 0.12, centreHz: 640, q: 0.9, gain: 0.22, decay: 1.6 },
};

/** @type {AudioContext | null} */
let ctx = null;
/** @type {Map<string, AudioBuffer>} */
const bufferCache = new Map();

function getContext() {
  if (ctx && ctx.state !== "closed") return ctx;
  const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!AC) return null;
  ctx = new AC({ sampleRate: SAMPLE_RATE_FALLBACK, latencyHint: "interactive" });
  return ctx;
}

function bufferFor(audioCtx, cueName) {
  const cached = bufferCache.get(cueName);
  if (cached) return cached;
  const spec = CUES[cueName] ?? CUES.snap;
  const len = Math.floor(audioCtx.sampleRate * spec.duration);
  const buf = audioCtx.createBuffer(1, len, audioCtx.sampleRate);
  const data = buf.getChannelData(0);
  const attack = Math.floor(len * 0.06) || 1;
  for (let i = 0; i < len; i++) {
    const t = i / len;
    const envelope = Math.pow(1 - t, spec.decay) * (i < attack ? i / attack : 1);
    data[i] = (Math.random() * 2 - 1) * envelope;
  }
  bufferCache.set(cueName, buf);
  return buf;
}

async function playCue(cueName) {
  const audioCtx = getContext();
  if (!audioCtx) return { ok: false, reason: "no-audiocontext" };
  if (audioCtx.state === "suspended") {
    try {
      await audioCtx.resume();
    } catch {
      /* fall through — the start() below will simply be silent */
    }
  }
  const spec = CUES[cueName] ?? CUES.snap;
  const src = audioCtx.createBufferSource();
  src.buffer = bufferFor(audioCtx, cueName);

  const bandpass = audioCtx.createBiquadFilter();
  bandpass.type = "bandpass";
  bandpass.frequency.value = spec.centreHz;
  bandpass.Q.value = spec.q;

  const gain = audioCtx.createGain();
  gain.gain.value = spec.gain;

  src.connect(bandpass).connect(gain).connect(audioCtx.destination);
  src.start();
  src.onended = () => {
    try {
      src.disconnect();
      bandpass.disconnect();
      gain.disconnect();
    } catch {
      /* already disconnected */
    }
  };
  return { ok: true, state: audioCtx.state };
}

// Each model belongs to one meeting tab. Do not persist or log frame data.
const handModels = new Map();
let handStartQueue = Promise.resolve();
const MAX_HAND_MODELS = 4;
const FRAME_PREFIX = "data:image/jpeg;base64,";

async function startHandModel(tabId, minConfidence) {
  if (!Number.isInteger(tabId)) return { ok: false, reason: "invalid-tab" };
  const existing = handModels.get(tabId);
  if (existing?.model) return { ok: true };
  if (existing?.loading) return existing.loading;
  if (handModels.size >= MAX_HAND_MODELS) return { ok: false, reason: "model-capacity" };
  const record = { model: null, loading: null, inFlight: false, timestamp: -1 };
  handModels.set(tabId, record);
  const loading = handStartQueue.then(async () => {
    let created = null;
    let factory = null;
    try {
      if (handModels.get(tabId) !== record) return { ok: false, reason: "cancelled" };
      const wasm = await import(chrome.runtime.getURL("wasm/vision_wasm_module_internal.js"));
      factory = wasm.default;
      if (typeof factory !== "function") throw new Error("WASM module factory unavailable");
      const { HandLandmarker } = await import(chrome.runtime.getURL("vendor/vision_bundle.mjs"));
      const fileset = { wasmLoaderPath: "", wasmBinaryPath: chrome.runtime.getURL("wasm/vision_wasm_module_internal.wasm") };
      for (const delegate of ["GPU", "CPU"]) {
        if (handModels.get(tabId) !== record) return { ok: false, reason: "cancelled" };
        try {
          globalThis.ModuleFactory = factory;
          created = await HandLandmarker.createFromOptions(fileset, {
            baseOptions: { modelAssetPath: chrome.runtime.getURL("models/hand_landmarker.task"), delegate },
            runningMode: "VIDEO", numHands: 1,
            minHandDetectionConfidence: minConfidence, minHandPresenceConfidence: minConfidence,
          });
          if (created && typeof created.detectForVideo === "function") break;
          try { created?.close?.(); } catch { /* ignore */ }
          created = null;
        } catch { created = null; }
      }
      if (!created) throw new Error("HandLandmarker creation failed");
      if (handModels.get(tabId) !== record) {
        try { created.close(); } catch { /* ignore */ }
        return { ok: false, reason: "cancelled" };
      }
      record.model = created;
      return { ok: true };
    } catch {
      try { created?.close?.(); } catch { /* ignore */ }
      if (handModels.get(tabId) === record) handModels.delete(tabId);
      return { ok: false, reason: "model-unavailable" };
    } finally {
      if (factory && globalThis.ModuleFactory === factory) delete globalThis.ModuleFactory;
      record.loading = null;
    }
  });
  handStartQueue = loading.then(() => undefined, () => undefined);
  record.loading = loading;
  return loading;
}

function releaseHandModel(tabId) {
  const record = handModels.get(tabId);
  handModels.delete(tabId);
  try { record?.model?.close(); } catch { /* already closed */ }
  return { ok: true };
}

async function inferHandFrame(tabId, dataUrl, timestamp) {
  const record = handModels.get(tabId);
  if (!record?.model) return { ok: false, reason: "model-unavailable" };
  if (record.inFlight) return { ok: false, reason: "busy" };
  if (typeof dataUrl !== "string" || dataUrl.length > 250000 || !dataUrl.startsWith(FRAME_PREFIX)) {
    return { ok: false, reason: "invalid-frame" };
  }
  record.inFlight = true;
  let bitmap = null;
  try {
    const bytes = atob(dataUrl.slice(FRAME_PREFIX.length));
    const buffer = new Uint8Array(bytes.length);
    for (let i = 0; i < bytes.length; i += 1) buffer[i] = bytes.charCodeAt(i);
    bitmap = await createImageBitmap(new Blob([buffer], { type: "image/jpeg" }));
    if (handModels.get(tabId) !== record) return { ok: false, reason: "cancelled" };
    if (bitmap.width > 320 || bitmap.height > 320) return { ok: false, reason: "invalid-frame-size" };
    record.timestamp = Math.max(record.timestamp + 1, Math.floor(Number.isFinite(timestamp) ? timestamp : 0));
    const result = record.model.detectForVideo(bitmap, record.timestamp);
    return { ok: true, landmarks: result?.landmarks || [], worldLandmarks: result?.worldLandmarks || [] };
  } catch {
    if (handModels.get(tabId) === record) releaseHandModel(tabId);
    return { ok: false, reason: "inference-failed" };
  } finally {
    try { bitmap?.close(); } catch { /* ignore */ }
    record.inFlight = false;
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Only the service worker drives this document.
  if (sender?.tab || (sender?.id && sender.id !== chrome.runtime.id)) return false;
  if (!msg || typeof msg.type !== "string") return false;

  if (msg.type === "OFFSCREEN_HAND_START" || msg.type === "OFFSCREEN_HAND_INFER" || msg.type === "OFFSCREEN_HAND_RELEASE") {
    if (sender?.url !== chrome.runtime.getURL("background.js")) return false;
    const payload = msg.payload || {};
    if (msg.type === "OFFSCREEN_HAND_RELEASE") {
      sendResponse(releaseHandModel(payload.tabId));
      return false;
    }
    const operation = msg.type === "OFFSCREEN_HAND_START"
      ? startHandModel(payload.tabId, payload.minConfidence)
      : inferHandFrame(payload.tabId, payload.frame, payload.timestamp);
    operation.then(sendResponse).catch(() => sendResponse({ ok: false, reason: "inference-unavailable" }));
    return true;
  }

  if (msg.type === "OFFSCREEN_PLAY") {
    playCue(typeof msg.payload?.cue === "string" ? msg.payload.cue : "snap")
      .then(sendResponse)
      .catch((err) =>
        sendResponse({
          ok: false,
          reason: "play-failed",
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    return true;
  }

  if (msg.type === "OFFSCREEN_STATUS") {
    sendResponse({
      ok: true,
      state: ctx?.state ?? "uninitialised",
      cachedCues: [...bufferCache.keys()],
      handModelCount: handModels.size,
    });
    return false;
  }

  return false;
});
