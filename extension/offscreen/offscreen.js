/**
 * Snap Vanish 2.0 — Offscreen Audio Document
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
 * - Chrome reclaims `AUDIO_PLAYBACK` documents ~30 s after the last sound, so no
 *   manual teardown timer is needed; a re-create is idempotent in the worker.
 * - This document never touches camera data, network, or storage.
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

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Only the service worker drives this document.
  if (sender?.tab || (sender?.id && sender.id !== chrome.runtime.id)) return false;
  if (!msg || typeof msg.type !== "string") return false;

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
    });
    return false;
  }

  return false;
});
