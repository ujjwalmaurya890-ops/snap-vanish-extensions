/**
 * Snap Vanish 2.0 — Manifest V3 Background Service Worker
 *
 * RESPONSIBILITIES
 * - Stateless message router across Popup / Studio / Content Script / Offscreen
 * - Tab targeting that survives service-worker suspension (session storage)
 * - Global `chrome.commands` routing
 * - Toolbar badge synchronisation derived from persisted state
 * - Offscreen document lifecycle (confirmation cue playback)
 *
 * MV3 LIFECYCLE RULES ENFORCED HERE
 * 1. No module-scope value is the source of truth: durable preferences and
 *    per-tab state are re-read from chrome.storage after a worker restart.
 * 2. In-memory guards coordinate active offscreen creation and settings writes;
 *    the stored document remains authoritative when the worker is restarted.
 * 3. Every async `onMessage` handler returns `true` synchronously and calls
 *    `sendResponse` exactly once on every code path (including throws).
 */

const MEETING_PATTERNS = [
  "https://meet.google.com/*",
  "https://teams.microsoft.com/*",
  "https://teams.live.com/*",
  "https://*.zoom.us/wc/*",
  "https://app.zoom.us/wc/*",
];

const ALLOWED_TYPES = new Set([
  "PING",
  "GET_STATE",
  "SNAP_NOW",
  "SNAP_TOGGLE",
  "SNAP_VANISH_NOW",
  "SNAP_RESTORE_NOW",
  "EMERGENCY_RESTORE",
  "MUTE_TOGGLE",
  "DETECTION_TOGGLE",
  "CAPTURE_CLEAN_PLATE",
  "REVIEW_CLEAN_PLATE",
  "CANCEL_CLEAN_PLATE",
  "CLEAR_CLEAN_PLATE",
  "OPEN_STUDIO",
  "RESET_FRAME",
  "SETTINGS_CHANGED",
  "SETTINGS",
  "STATE",
  "CALIBRATE_GESTURE",
  "RUN_DIAGNOSTICS",
  "CLEAR_LOCAL_DATA",
  "SYNC_DASHBOARD_STATE",
  "PLAY_CUE",
  "HAND_MODEL_START",
  "HAND_MODEL_INFER",
  "HAND_MODEL_RELEASE",
  "OFFSCREEN_EVENT",
]);

// Canonical sync document. Defaults mirror src/lib/settings.ts; legacy flat
// keys are read only when this document does not yet exist.
const SETTINGS_KEY = "snap_vanish_settings_v2";
const DEFAULT_SYNC_PREFS = {
  schemaVersion: 2,
  enabled: true,
  autoStartOnCall: true,
  showCallHud: true,
  hudPosition: "bottom-right",
  meetingMode: "creative",
  onboardingCompleted: false,
  sensitivity: 62,
  gesture: {
    enabled: true, detectionMode: "smart", mode: "balanced", sensitivity: 62,
    minHandConfidence: 0.62, landmarkSmoothing: 0.35, inferenceFpsLimit: 24,
    cooldownMs: 2000, requireAudioConfirm: true, accidentalTriggerProtection: true,
    calibratedCollapseThresholdMm: 12, actionMapping: "toggle-vanish",
  },
  camera: {
    preferredDeviceId: "", targetResolution: "1280x720", mirrorPreview: true,
    backgroundMode: "temporal-plate", autoRestoreOnLeave: true,
  },
  sound: true,
  muteOnVanish: true,
  audio: {
    enabled: true, preferredDeviceId: "", sensitivityDb: 12,
    confirmWindowMs: 220, allowStandaloneAudioTrigger: false,
  },
  effect: "dust", direction: "right", duration: 1.8, speed: 1.0,
  particleSize: 1.0, density: 80, colorAccent: "#d2451e", intensity: 85,
  motionSmoothness: 70, lowPowerMode: false, performanceProfile: "balanced",
  pauseWhenHidden: true, maxParticles: 22000, diagnosticLoggingEnabled: true,
  recordActivityHistory: true, strictLocalOnly: true,
  shortcuts: {
    toggleSnap: "Alt+Shift+S", vanishNow: "Alt+Shift+D", restoreCamera: "Alt+Shift+R",
    toggleDetection: "Alt+Shift+G", openSettings: "Alt+Shift+O",
    muteOnly: "Alt+Shift+M", emergencyRestore: "Alt+Shift+R",
  },
};

/* ------------------------------------------------------------------ *
 * Settings sanitisation
 *
 * Every `SETTINGS_CHANGED` payload is treated as untrusted input: only
 * allowlisted keys survive, numbers are clamped to their documented ranges,
 * and enums/colors must match exactly. Unknown keys are dropped instead of
 * being mirrored into `chrome.storage.sync`, which previously let any
 * extension context persist arbitrary junk (brief §9/§13).
 * ------------------------------------------------------------------ */

const VALID_EFFECTS = new Set([
  "dust",
  "cinematic-disintegration",
  "fine-particles",
  "pixel-dissolve",
  "digital-glitch",
  "fade-out",
  "light-burst",
]);
const VALID_DIRECTIONS = new Set(["left", "right", "up", "down", "toward"]);
const VALID_TRIGGER_MODES = new Set(["smart", "gesture-only", "manual"]);
const VALID_DETECTION_PROFILES = new Set([
  "beginner",
  "balanced",
  "precision",
  "custom",
]);
const VALID_HUD_POSITIONS = new Set([
  "bottom-right",
  "bottom-left",
  "top-right",
]);
const HEX_COLOR_RE = /^#[0-9a-f]{6}$/i;

function clampNum(value, lo, hi) {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.min(hi, Math.max(lo, value));
}

function clampInt(value, lo, hi) {
  const number = clampNum(value, lo, hi);
  return number === undefined ? undefined : Math.round(number);
}

function pickBool(value) {
  return typeof value === "boolean" ? value : undefined;
}

function sanitizeNested(source, spec) {
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    return undefined;
  }
  const out = {};
  for (const [key, rule] of Object.entries(spec)) {
    if (source[key] === undefined) continue;
    const v = rule(source[key]);
    if (v !== undefined) out[key] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

const GESTURE_SPEC = {
  enabled: pickBool,
  detectionMode: (v) => (VALID_TRIGGER_MODES.has(v) ? v : undefined),
  mode: (v) => (VALID_DETECTION_PROFILES.has(v) ? v : undefined),
  actionMapping: (v) => ["toggle-vanish", "vanish-only", "restore-only", "mute-only"].includes(v) ? v : undefined,
  sensitivity: (v) => clampInt(v, 0, 100),
  minHandConfidence: (v) => clampNum(v, 0.3, 0.95),
  landmarkSmoothing: (v) => clampNum(v, 0, 0.85),
  inferenceFpsLimit: (v) => clampInt(v, 10, 30),
  cooldownMs: (v) => clampInt(v, 500, 10000),
  requireAudioConfirm: pickBool,
  accidentalTriggerProtection: pickBool,
  calibratedCollapseThresholdMm: (v) => clampNum(v, 6, 25),
};
const AUDIO_SPEC = {
  enabled: pickBool,
  preferredDeviceId: (v) =>
    typeof v === "string" ? v.slice(0, 128) : undefined,
  sensitivityDb: (v) => clampInt(v, 6, 28),
  confirmWindowMs: (v) => clampInt(v, 100, 500),
  allowStandaloneAudioTrigger: pickBool,
};
const CAMERA_SPEC = {
  preferredDeviceId: (v) =>
    typeof v === "string" ? v.slice(0, 128) : undefined,
  targetResolution: (v) =>
    ["1280x720", "640x360", "1920x1080"].includes(v) ? v : undefined,
  mirrorPreview: pickBool,
  backgroundMode: (v) =>
    ["captured-plate", "temporal-plate", "ai-segmentation", "studio-fallback"].includes(v)
      ? v
      : undefined,
  autoRestoreOnLeave: pickBool,
};

/** Returns a new object containing only valid, in-range settings keys. */
function sanitizeSettingsPatch(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return {};
  }
  const flatSpec = {
    enabled: pickBool,
    autoStartOnCall: pickBool,
    showCallHud: pickBool,
    hudPosition: (v) => (VALID_HUD_POSITIONS.has(v) ? v : undefined),
    onboardingCompleted: pickBool,
    meetingMode: (v) => ["professional", "creative", "minimal", "low-power", "custom"].includes(v) ? v : undefined,
    performanceProfile: (v) => ["balanced", "high-quality", "low-power"].includes(v) ? v : undefined,
    sensitivity: (v) => clampInt(v, 0, 100),
    sound: pickBool,
    muteOnVanish: pickBool,
    effect: (v) => (VALID_EFFECTS.has(v) ? v : undefined),
    direction: (v) => (VALID_DIRECTIONS.has(v) ? v : undefined),
    duration: (v) => clampNum(v, 0.5, 4.0),
    speed: (v) => clampNum(v, 0.5, 2.5),
    particleSize: (v) => clampNum(v, 0.5, 3.0),
    density: (v) => clampInt(v, 20, 100),
    colorAccent: (v) =>
      typeof v === "string" && HEX_COLOR_RE.test(v) ? v.toLowerCase() : undefined,
    intensity: (v) => clampInt(v, 10, 100),
    motionSmoothness: (v) => clampInt(v, 0, 100),
    lowPowerMode: pickBool,
    pauseWhenHidden: pickBool,
    maxParticles: (v) => clampInt(v, 4000, 28000),
    diagnosticLoggingEnabled: pickBool,
    recordActivityHistory: pickBool,
    strictLocalOnly: pickBool,
    schemaVersion: (v) => (v === 2 ? 2 : undefined),
  };
  const out = sanitizeNested(payload, flatSpec) ?? {};
  const gesture = sanitizeNested(payload.gesture, GESTURE_SPEC);
  if (gesture) out.gesture = gesture;
  const audio = sanitizeNested(payload.audio, AUDIO_SPEC);
  if (audio) out.audio = audio;
  const camera = sanitizeNested(payload.camera, CAMERA_SPEC);
  if (camera) out.camera = camera;
  const shortcut = (v) => typeof v === "string" && v.trim().length > 0 && v.trim().length <= 40 ? v.trim() : undefined;
  const shortcuts = sanitizeNested(payload.shortcuts, {
    toggleSnap: shortcut, vanishNow: shortcut, restoreCamera: shortcut,
    toggleDetection: shortcut, openSettings: shortcut, muteOnly: shortcut, emergencyRestore: shortcut,
  });
  if (shortcuts) out.shortcuts = shortcuts;
  return out;
}

function mergeSettings(current, patch) {
  const merged = { ...current, ...patch };
  for (const key of ["gesture", "audio", "camera", "shortcuts"]) {
    merged[key] = { ...(current[key] ?? {}), ...(patch[key] ?? {}) };
  }
  const sensitivity = patch.sensitivity ?? patch.gesture?.sensitivity;
  if (sensitivity !== undefined) {
    merged.sensitivity = sensitivity;
    merged.gesture.sensitivity = sensitivity;
  }
  return merged;
}

const BADGE = {
  off: { text: "OFF", color: "#3f3f46" },
  on: { text: "ON", color: "#e0532c" },
};

const OFFSCREEN_PATH = "offscreen/offscreen.html";
// BLOBS is used to decode transient, locally processed camera frames when a
// meeting's CSP prevents WebAssembly in the content-script context.
const OFFSCREEN_REASONS = ["AUDIO_PLAYBACK", "BLOBS"];
const OFFSCREEN_JUSTIFICATION =
  "Play local cues and decode transient camera-frame blobs for local hand inference when page CSP blocks WebAssembly.";

/** Per-tab transient state (engineState / muted). Survives worker suspension. */
const SESSION_TABS_KEY = "sv_tabs_v2";

// Match the content-script scope, not the broader origin-wide WAR scope.
function isSupportedMeetingUrl(url) {
  if (typeof url !== "string") return false;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return false;
    if (["meet.google.com", "teams.microsoft.com", "teams.live.com"].includes(parsed.hostname)) return true;
    return (parsed.hostname === "zoom.us" || parsed.hostname.endsWith(".zoom.us")) && parsed.pathname.startsWith("/wc/");
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * Storage helpers (the only durable state)
 * ------------------------------------------------------------------ */

async function readPrefs() {
  const stored = await chrome.storage.sync.get(null);
  const nested = stored?.[SETTINGS_KEY];
  const source = nested && typeof nested === "object" && !Array.isArray(nested) ? nested : stored;
  return mergeSettings(DEFAULT_SYNC_PREFS, sanitizeSettingsPatch(source));
}

async function readSessionTabs() {
  try {
    const res = await chrome.storage.session.get(SESSION_TABS_KEY);
    const map = res?.[SESSION_TABS_KEY];
    return map && typeof map === "object" ? map : {};
  } catch {
    return {};
  }
}

async function writeSessionTab(tabId, patch) {
  try {
    const map = await readSessionTabs();
    const prev = map[tabId] ?? {};
    map[tabId] = { ...prev, ...patch, updatedAt: Date.now() };
    // Keep the map tiny and bounded — it is a routing cache, not a log.
    const ids = Object.keys(map);
    if (ids.length > 12) {
      ids
        .sort((a, b) => (map[a].updatedAt ?? 0) - (map[b].updatedAt ?? 0))
        .slice(0, ids.length - 12)
        .forEach((id) => delete map[id]);
    }
    await chrome.storage.session.set({ [SESSION_TABS_KEY]: map });
  } catch {
    /* session storage is best-effort */
  }
}

async function forgetSessionTab(tabId) {
  try {
    const map = await readSessionTabs();
    if (map[tabId]) {
      delete map[tabId];
      await chrome.storage.session.set({ [SESSION_TABS_KEY]: map });
    }
  } catch {
    /* noop */
  }
}

/* ------------------------------------------------------------------ *
 * Badge
 * ------------------------------------------------------------------ */

async function setBadge(kind) {
  const state = BADGE[kind] ?? BADGE.on;
  try {
    await chrome.action.setBadgeText({ text: state.text });
    await chrome.action.setBadgeBackgroundColor({ color: state.color });
  } catch {
    /* badge API can reject during early worker startup */
  }
}

/** Derives the badge purely from persisted state — never from a global. */
async function syncBadge() {
  try {
    const prefs = await readPrefs();
    if (prefs.enabled === false) {
      await setBadge("off");
      return;
    }
    // The session cache can outlive a content script. Do not present its last
    // state as a live claim about any meeting's outgoing stream.
    await setBadge("on");
  } catch {
    // Do not claim an enabled state when durable preferences cannot be read.
    try { await chrome.action.setBadgeText({ text: "?" }); } catch { /* unavailable */ }
  }
}

/* ------------------------------------------------------------------ *
 * Tab targeting
 * ------------------------------------------------------------------ */

async function listMeetingTabs() {
  try {
    return (await chrome.tabs.query({ url: MEETING_PATTERNS })).filter((tab) => isSupportedMeetingUrl(tab.url));
  } catch {
    return [];
  }
}

/** Never send a camera/microphone command to an arbitrary background meeting. */
async function resolveTargetTab(preferredTabId) {
  if (typeof preferredTabId === "number") {
    try {
      const tab = await chrome.tabs.get(preferredTabId);
      if (tab && isSupportedMeetingUrl(tab.url)) return { tab };
    } catch { /* tab gone */ }
    return { tab: null, reason: "invalid-target-tab" };
  }

  const meetingTabs = await listMeetingTabs();
  if (meetingTabs.length === 0) return { tab: null, reason: "no-supported-meeting-tab" };
  try {
    const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const activeHit = meetingTabs.find((tab) => tab.id === active?.id);
    if (activeHit) return { tab: activeHit };
  } catch { /* try the unambiguous single-tab case */ }
  if (meetingTabs.length === 1) return { tab: meetingTabs[0] };
  return { tab: null, reason: "multiple-meeting-tabs" };
}

function sourceMeetingTabId(sender) {
  return isSupportedMeetingUrl(sender?.tab?.url) ? sender.tab.id : undefined;
}

/**
 * Last state written per tab. Purely an optimisation to avoid a session-storage
 * write on every popup PING; correctness never depends on it (it is re-derived
 * from the content script on the next message after a worker restart).
 */
const lastWrittenState = new Map();

/** Sends to a single tab; returns a structured failure instead of throwing. */
async function sendToTab(tabId, message) {
  try {
    const res = await chrome.tabs.sendMessage(tabId, message);
    if (res && typeof res.engineState === "string") {
      const signature = `${res.engineState}|${res.interceptionMode ?? ""}|${res.muted ?? ""}`;
      if (lastWrittenState.get(tabId) !== signature) {
        lastWrittenState.set(tabId, signature);
        await writeSessionTab(tabId, {
          engineState: res.engineState,
          interceptionMode: res.interceptionMode,
          muted: res.muted,
        });
        await syncBadge();
      }
    }
    return res ?? { ok: false, reason: "empty-response" };
  } catch (err) {
    lastWrittenState.delete(tabId);
    await forgetSessionTab(tabId);
    return {
      ok: false,
      reason: "content-script-unreachable",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function sendToTarget(message, preferredTabId) {
  const { tab, reason } = await resolveTargetTab(preferredTabId);
  if (!tab || typeof tab.id !== "number") {
    return { ok: false, reason: reason || "no-supported-meeting-tab", interceptionMode: "inactive" };
  }
  const response = await sendToTab(tab.id, message);
  return { ...response, tabId: tab.id };
}

/** Broadcast used by safety-critical operations (settings + emergency restore). */
async function broadcastToMeetingTabs(message, exceptTabId) {
  const tabs = await listMeetingTabs();
  const results = await Promise.all(
    tabs
      .filter((t) => typeof t.id === "number" && t.id !== exceptTabId)
      .map((t) => sendToTab(t.id, message)),
  );
  const delivered = results.filter((result) => result?.ok === true).length;
  return {
    ok: results.length > 0 && delivered === results.length,
    delivered,
    attempted: results.length,
  };
}

// This in-memory queue coordinates concurrent events only; the canonical value
// is always read from storage at commit time, including after a worker restart.
const settingsWrites = { chain: Promise.resolve(), pending: null };

function writeSettings(update) {
  const operation = settingsWrites.chain.then(async () => {
    const current = await readPrefs();
    const patch = sanitizeSettingsPatch(typeof update === "function" ? update(current) : update);
    const merged = mergeSettings(current, patch);
    await chrome.storage.sync.set({ [SETTINGS_KEY]: merged });
    const broadcast = await broadcastToMeetingTabs({ type: "SETTINGS_CHANGED", payload: merged });
    await syncBadge();
    return { ok: true, settings: merged, forwarded: broadcast.delivered };
  });
  settingsWrites.chain = operation.catch(() => {});
  return operation;
}

function flushPendingSettings() {
  const batch = settingsWrites.pending;
  if (!batch) return settingsWrites.chain;
  settingsWrites.pending = null;
  clearTimeout(batch.timer);
  clearTimeout(batch.maxTimer);
  const operation = writeSettings(batch.patch);
  operation.then(
    (result) => batch.waiters.forEach(({ resolve }) => resolve(result)),
    (error) => batch.waiters.forEach(({ reject }) => reject(error)),
  );
  return operation;
}

function queueSettingsPatch(patch) {
  return new Promise((resolve, reject) => {
    let batch = settingsWrites.pending;
    if (!batch) {
      batch = { patch: {}, waiters: [], timer: null, maxTimer: null };
      settingsWrites.pending = batch;
      // Bound latency even during a long drag; ordinary slider bursts become one write.
      batch.maxTimer = setTimeout(() => { void flushPendingSettings().catch(() => {}); }, 1000);
    }
    batch.patch = mergeSettings(batch.patch, patch);
    batch.waiters.push({ resolve, reject });
    clearTimeout(batch.timer);
    batch.timer = setTimeout(() => { void flushPendingSettings().catch(() => {}); }, 300);
  });
}

/* ------------------------------------------------------------------ *
 * Offscreen document (extension-origin audio and CSP-safe local inference)
 * ------------------------------------------------------------------ */

let offscreenCreating = null;

async function hasOffscreenDocument() {
  try {
    if (!chrome.runtime.getContexts) return false;
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
      documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH)],
    });
    return contexts.length > 0;
  } catch {
    return false;
  }
}

async function ensureOffscreenDocument() {
  if (await hasOffscreenDocument()) return true;
  if (offscreenCreating) {
    await offscreenCreating;
    return true;
  }
  offscreenCreating = chrome.offscreen
    .createDocument({
      url: OFFSCREEN_PATH,
      reasons: OFFSCREEN_REASONS,
      justification: OFFSCREEN_JUSTIFICATION,
    })
    .catch(async (err) => {
      // A concurrent creation (popup + command race) surfaces as
      // "Only a single offscreen document may be created" — treat as success.
      const msg = err instanceof Error ? err.message : String(err);
      if (!/single offscreen/i.test(msg)) throw err;
    })
    .finally(() => {
      offscreenCreating = null;
    });
  try {
    await offscreenCreating;
    return true;
  } catch {
    return false;
  }
}

async function releaseOffscreenModelForTab(tabId) {
  try {
    if (await hasOffscreenDocument()) {
      await chrome.runtime.sendMessage({ type: "OFFSCREEN_HAND_RELEASE", payload: { tabId } });
    }
  } catch { /* document may already be gone */ }
}

/* ------------------------------------------------------------------ *
 * Lifecycle
 * ------------------------------------------------------------------ */

chrome.runtime.onInstalled.addListener(async (details) => {
  // Migrate once. An existing canonical document wins over legacy flat mirrors;
  // without it, preserve valid legacy fields rather than resetting preferences.
  const existing = await chrome.storage.sync.get(null);
  const canonical = existing?.[SETTINGS_KEY];
  if (!canonical || typeof canonical !== "object" || Array.isArray(canonical)) {
    const migrated = mergeSettings(DEFAULT_SYNC_PREFS, sanitizeSettingsPatch(existing));
    await chrome.storage.sync.set({ [SETTINGS_KEY]: migrated });
  }
  await syncBadge();
  if (details.reason === "install") {
    try {
      await chrome.runtime.openOptionsPage();
    } catch {
      /* options page can fail in managed environments */
    }
  }
});

chrome.runtime.onStartup.addListener(() => {
  void syncBadge();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && (changes.enabled || changes.snap_vanish_settings_v2)) {
    void syncBadge();
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  lastWrittenState.delete(tabId);
  void releaseOffscreenModelForTab(tabId);
  void (async () => {
    await forgetSessionTab(tabId);
    await syncBadge();
  })();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") void releaseOffscreenModelForTab(tabId);
  if (typeof changeInfo.url !== "string") return;
  if (!isSupportedMeetingUrl(changeInfo.url)) {
    lastWrittenState.delete(tabId);
    void releaseOffscreenModelForTab(tabId);
    void forgetSessionTab(tabId);
  }
});

chrome.commands.onCommand.addListener((command) => {
  void (async () => {
    if (command === "toggle-snap") {
      // Respect earlier UI edits and compute the toggle inside the serialized
      // write, so rapid repeated commands cannot reuse a stale value.
      await flushPendingSettings();
      await writeSettings((prefs) => ({ enabled: prefs.enabled === false }));
      return;
    }
    if (command === "vanish-now") {
      await sendToTarget({ type: "SNAP_NOW" });
      return;
    }
    if (command === "mute-only") {
      await sendToTarget({ type: "MUTE_TOGGLE" });
      return;
    }
    if (command === "emergency-restore" || command === "reset-frame") {
      // Safety-critical: hit every meeting tab, not just the resolved one.
      await broadcastToMeetingTabs({ type: "EMERGENCY_RESTORE" });
      await syncBadge();
    }
  })().catch((error) => {
    console.warn("[snap-vanish] command failed:", error instanceof Error ? error.message : String(error));
  });
});

/* ------------------------------------------------------------------ *
 * Message router
 * ------------------------------------------------------------------ */

async function forwardHandModel(type, msg, sender) {
  const tabId = sourceMeetingTabId(sender);
  if (typeof tabId !== "number" || (sender.frameId !== undefined && sender.frameId !== 0)) {
    return { ok: false, reason: "unexpected-sender" };
  }
  if (type === "OFFSCREEN_HAND_RELEASE") {
    await releaseOffscreenModelForTab(tabId);
    return { ok: true };
  }
  const payload = { tabId };
  if (type === "OFFSCREEN_HAND_START") {
    const confidence = msg.payload?.minConfidence;
    payload.minConfidence = typeof confidence === "number" && Number.isFinite(confidence) ? Math.max(0.3, Math.min(0.95, confidence)) : 0.62;
    if (!(await ensureOffscreenDocument())) return { ok: false, reason: "offscreen-unavailable" };
  } else {
    const frame = msg.payload?.frame;
    if (typeof frame !== "string" || frame.length > 250000 || !frame.startsWith("data:image/jpeg;base64,")) {
      return { ok: false, reason: "invalid-frame" };
    }
    if (!(await hasOffscreenDocument())) return { ok: false, reason: "offscreen-unavailable" };
    payload.frame = frame;
    payload.timestamp = typeof msg.payload?.timestamp === "number" && Number.isFinite(msg.payload.timestamp) ? msg.payload.timestamp : 0;
  }
  try {
    return await chrome.runtime.sendMessage({ type, payload }) ?? { ok: false, reason: "offscreen-unavailable" };
  } catch {
    return { ok: false, reason: "offscreen-unavailable" };
  }
}

const handlers = {
  HAND_MODEL_START: (msg, sender) => forwardHandModel("OFFSCREEN_HAND_START", msg, sender),
  HAND_MODEL_INFER: (msg, sender) => forwardHandModel("OFFSCREEN_HAND_INFER", msg, sender),
  HAND_MODEL_RELEASE: (msg, sender) => forwardHandModel("OFFSCREEN_HAND_RELEASE", msg, sender),

  async PING(_msg, sender) {
    return sendToTarget({ type: "PING" }, sourceMeetingTabId(sender));
  },

  async GET_STATE(_msg, sender) {
    // Never promote a cached snapshot to a live response. A closed/reloaded
    // content script is unknown, even if a previous tab reported a state.
    return sendToTarget({ type: "GET_STATE" }, sourceMeetingTabId(sender));
  },

  async OPEN_STUDIO() {
    await chrome.runtime.openOptionsPage();
    return { ok: true };
  },

  async CLEAR_LOCAL_DATA() {
    await chrome.storage.local.clear();
    await chrome.storage.session.clear();
    await syncBadge();
    return { ok: true };
  },

  async SETTINGS_CHANGED(msg) {
    // All surfaces send patches through this single, serialized writer.
    return queueSettingsPatch(sanitizeSettingsPatch(msg.payload));
  },

  async DETECTION_TOGGLE() {
    await flushPendingSettings();
    return writeSettings((prefs) => ({ gesture: { enabled: prefs.gesture?.enabled === false } }));
  },

  async PLAY_CUE(msg) {
    const ok = await ensureOffscreenDocument();
    if (!ok) return { ok: false, reason: "offscreen-unavailable" };
    const cue = typeof msg.payload?.cue === "string" ? msg.payload.cue : "snap";
    try {
      // Messages sent from the service worker are delivered to every other
      // extension context (offscreen doc, popup, studio) but never back to the
      // sender, so this cannot re-enter the router.
      await chrome.runtime.sendMessage({ type: "OFFSCREEN_PLAY", payload: { cue } });
      return { ok: true, cue, mode: "offscreen" };
    } catch (err) {
      return {
        ok: false,
        reason: "offscreen-unreachable",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },

  async OFFSCREEN_EVENT(msg, sender) {
    // Only the offscreen document (an extension context, no tab) may post these.
    if (sender.tab) return { ok: false, reason: "unexpected-sender" };
    const payload = msg.payload && typeof msg.payload === "object" ? msg.payload : {};
    const { tab } = await resolveTargetTab(payload.tabId);
    if (tab?.id !== undefined) {
      return sendToTab(tab.id, { type: "OFFSCREEN_EVENT", payload });
    }
    return { ok: false, reason: "no-target-tab" };
  },

  async EMERGENCY_RESTORE(_msg, sender) {
    // Always fan out: a stranded vanished tab is the worst possible outcome.
    const res = await broadcastToMeetingTabs({ type: "EMERGENCY_RESTORE" });
    await syncBadge();
    return { ...res, reason: res.ok ? undefined : res.attempted ? "restore-incomplete" : "no-supported-meeting-tab", from: sender?.tab?.id ?? null };
  },

  async RESET_FRAME(_msg, sender) {
    return handlers.EMERGENCY_RESTORE(_msg, sender);
  },
};

const FORWARD_TO_TAB = new Set([
  "SNAP_NOW",
  "SNAP_TOGGLE",
  "SNAP_VANISH_NOW",
  "SNAP_RESTORE_NOW",
  "MUTE_TOGGLE",
  "DETECTION_TOGGLE",
  "CAPTURE_CLEAN_PLATE",
  "REVIEW_CLEAN_PLATE",
  "CANCEL_CLEAN_PLATE",
  "CLEAR_CLEAN_PLATE",
  "CALIBRATE_GESTURE",
  "RUN_DIAGNOSTICS",
  "STATE",
  "SYNC_DASHBOARD_STATE",
  "SETTINGS",
]);

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Reject anything that did not originate inside this extension.
  if (sender?.id && sender.id !== chrome.runtime.id) {
    sendResponse({ ok: false, reason: "foreign-sender" });
    return false;
  }
  if (!msg || typeof msg !== "object" || typeof msg.type !== "string") {
    sendResponse({ ok: false, reason: "invalid-message" });
    return false;
  }
  if (!ALLOWED_TYPES.has(msg.type)) {
    sendResponse({ ok: false, reason: "unsupported-message-type" });
    return false;
  }

  const respond = (value) => {
    try {
      sendResponse(value);
    } catch {
      /* channel already closed */
    }
  };

  const special = handlers[msg.type];
  const work = special
    ? special(msg, sender)
    : FORWARD_TO_TAB.has(msg.type)
      ? sendToTarget(msg, sourceMeetingTabId(sender))
      : Promise.resolve({ ok: false, reason: "no-handler" });

  work
    .then(respond)
    .catch((err) =>
      respond({
        ok: false,
        reason: "handler-error",
        error: err instanceof Error ? err.message : String(err),
      }),
    );

  // Always async: the response is delivered after the microtask above.
  return true;
});
