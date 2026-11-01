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
 * 1. No mutable module-scope state is used as a source of truth. The worker can
 *    be killed at any moment (idle 30 s, no more than 5 min in the worst case);
 *    every value a handler needs is re-read from `chrome.storage` on demand.
 * 2. The only module-scope mutable value is `offscreenCreating`, a single-flight
 *    promise guard. It is safe because it is re-derived from
 *    `chrome.runtime.getContexts()` before being trusted.
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

const SUPPORTED_HOSTS = [
  "meet.google.com",
  "teams.microsoft.com",
  "teams.live.com",
  "zoom.us",
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
  "OFFSCREEN_EVENT",
]);

const DEFAULT_SYNC_PREFS = {
  enabled: true,
  sensitivity: 62,
  duration: 1.8,
  direction: "right",
  sound: true,
  effect: "dust",
  speed: 1.0,
  particleSize: 1.0,
  density: 80,
  colorAccent: "#e0532c",
  intensity: 85,
  motionSmoothness: 70,
  muteOnVanish: true,
  lowPowerMode: false,
  showCallHud: true,
};

const BADGE = {
  off: { text: "OFF", color: "#3f3f46" },
  on: { text: "ON", color: "#e0532c" },
  gone: { text: "GONE", color: "#d97706" },
};

const OFFSCREEN_PATH = "offscreen/offscreen.html";
/** `AUDIO_PLAYBACK` docs are auto-reclaimed by Chrome after ~30 s of silence. */
const OFFSCREEN_REASONS = ["AUDIO_PLAYBACK"];
const OFFSCREEN_JUSTIFICATION =
  "Play the short local snap-confirmation cue without creating an AudioContext in the meeting page.";

/** Per-tab transient state (engineState / muted). Survives worker suspension. */
const SESSION_TABS_KEY = "sv_tabs_v2";
/** Last tab the user actually interacted with (command routing fallback). */
const SESSION_TARGET_KEY = "sv_target_tab";

function isSupportedMeetingUrl(url) {
  if (typeof url !== "string" || !url.startsWith("https://")) return false;
  try {
    const parsed = new URL(url);
    return SUPPORTED_HOSTS.some(
      (h) => parsed.hostname === h || parsed.hostname.endsWith(`.${h}`),
    );
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * Storage helpers (the only durable state)
 * ------------------------------------------------------------------ */

async function readPrefs() {
  try {
    const stored = await chrome.storage.sync.get(null);
    const nested = stored?.snap_vanish_settings_v2;
    return {
      ...DEFAULT_SYNC_PREFS,
      ...(nested && typeof nested === "object" ? nested : stored ?? {}),
    };
  } catch {
    return { ...DEFAULT_SYNC_PREFS };
  }
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
  const prefs = await readPrefs();
  if (prefs.enabled === false) {
    await setBadge("off");
    return;
  }
  const tabs = await readSessionTabs();
  const vanished = Object.values(tabs).some((t) => t?.engineState === "vanished");
  await setBadge(vanished ? "gone" : "on");
}

/* ------------------------------------------------------------------ *
 * Tab targeting
 * ------------------------------------------------------------------ */

async function listMeetingTabs() {
  try {
    return await chrome.tabs.query({ url: MEETING_PATTERNS });
  } catch {
    return [];
  }
}

/**
 * Resolves the tab a command should be delivered to.
 * Preference order: explicit tab → last interacted meeting tab → active tab →
 * first meeting tab in any window. All of it is re-derived per invocation, so a
 * suspended-then-revived worker still targets the right tab.
 */
async function resolveTargetTab(preferredTabId) {
  if (typeof preferredTabId === "number") {
    try {
      const tab = await chrome.tabs.get(preferredTabId);
      if (tab && isSupportedMeetingUrl(tab.url)) return tab;
    } catch {
      /* tab gone */
    }
  }

  const meetingTabs = await listMeetingTabs();
  if (meetingTabs.length === 0) return null;

  try {
    const session = await chrome.storage.session.get(SESSION_TARGET_KEY);
    const remembered = session?.[SESSION_TARGET_KEY];
    const hit = meetingTabs.find((t) => t.id === remembered);
    if (hit) return hit;
  } catch {
    /* noop */
  }

  try {
    const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const activeHit = meetingTabs.find((t) => t.id === active?.id);
    if (activeHit) return activeHit;
  } catch {
    /* noop */
  }

  return meetingTabs[0] ?? null;
}

async function rememberTargetTab(tabId) {
  try {
    await chrome.storage.session.set({ [SESSION_TARGET_KEY]: tabId });
  } catch {
    /* noop */
  }
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
    return res ?? { ok: true };
  } catch (err) {
    return {
      ok: false,
      reason: "content-script-unreachable",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function sendToTarget(message, preferredTabId) {
  const tab = await resolveTargetTab(preferredTabId);
  if (!tab || typeof tab.id !== "number") {
    return {
      ok: false,
      reason: "no-supported-meeting-tab",
      interceptionMode: "inactive",
    };
  }
  await rememberTargetTab(tab.id);
  return sendToTab(tab.id, message);
}

/** Broadcast used by safety-critical operations (settings + emergency restore). */
async function broadcastToMeetingTabs(message, exceptTabId) {
  const tabs = await listMeetingTabs();
  const results = await Promise.all(
    tabs
      .filter((t) => typeof t.id === "number" && t.id !== exceptTabId)
      .map((t) => sendToTab(t.id, message)),
  );
  return {
    ok: results.some((r) => r && r.ok !== false),
    delivered: results.filter((r) => r && r.ok !== false).length,
    attempted: results.length,
  };
}

/* ------------------------------------------------------------------ *
 * Offscreen document (extension-origin DOM for audio playback)
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

/* ------------------------------------------------------------------ *
 * Lifecycle
 * ------------------------------------------------------------------ */

chrome.runtime.onInstalled.addListener(async (details) => {
  // Merge instead of overwrite: never clobber a returning user's settings.
  const existing = await chrome.storage.sync.get(null);
  const hasUserPrefs =
    existing && Object.keys(existing).length > 0 && existing.enabled !== undefined;
  if (!hasUserPrefs) {
    await chrome.storage.sync.set(DEFAULT_SYNC_PREFS);
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
  void (async () => {
    await forgetSessionTab(tabId);
    await syncBadge();
  })();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (typeof changeInfo.url !== "string") return;
  if (!isSupportedMeetingUrl(changeInfo.url)) {
    void forgetSessionTab(tabId);
  }
});

chrome.commands.onCommand.addListener((command) => {
  void (async () => {
    if (command === "toggle-snap") {
      const prefs = await readPrefs();
      const next = prefs.enabled === false;
      await chrome.storage.sync.set({ enabled: next });
      await broadcastToMeetingTabs({
        type: "SETTINGS_CHANGED",
        payload: { enabled: next },
      });
      await syncBadge();
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
  })();
});

/* ------------------------------------------------------------------ *
 * Message router
 * ------------------------------------------------------------------ */

const handlers = {
  async PING(msg, sender) {
    if (sender.tab?.id !== undefined) {
      const state = await sendToTab(sender.tab.id, { type: "PING" });
      return state;
    }
    return sendToTarget({ type: "PING" });
  },

  async GET_STATE(_msg, sender) {
    if (sender.tab?.id !== undefined) {
      return sendToTab(sender.tab.id, { type: "GET_STATE" });
    }
    const res = await sendToTarget({ type: "GET_STATE" });
    if (res?.ok === false) {
      // Fall back to the cached snapshot so the popup still shows something
      // truthful ("vanished on a background tab") instead of a blank state.
      const tabs = await readSessionTabs();
      const cached = Object.entries(tabs).find(
        ([, v]) => typeof v?.engineState === "string",
      );
      if (cached) {
        return {
          ok: true,
          cached: true,
          tabId: Number(cached[0]),
          engineState: cached[1].engineState,
          interceptionMode: cached[1].interceptionMode ?? "unknown",
        };
      }
    }
    return res;
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

  async SETTINGS_CHANGED(msg, sender) {
    const payload =
      msg.payload && typeof msg.payload === "object" ? msg.payload : {};
    const merged = { ...(await readPrefs()), ...payload };
    // Flat mirrors keep the popup / content-script / studio readers in sync
    // without each having to understand the nested schema.
    await chrome.storage.sync.set({
      ...DEFAULT_SYNC_PREFS,
      ...merged,
      enabled: merged.enabled !== false,
      snap_vanish_settings_v2: merged,
    });
    const broadcast = await broadcastToMeetingTabs(
      { type: "SETTINGS_CHANGED", payload: merged },
      // The sender's own tab already applied the change locally.
      sender.tab?.id,
    );
    await syncBadge();
    return { ok: true, forwarded: broadcast.delivered };
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
    const tab = await resolveTargetTab(payload.tabId);
    if (tab?.id !== undefined) {
      await sendToTab(tab.id, { type: "OFFSCREEN_EVENT", payload });
    }
    return { ok: true };
  },

  async EMERGENCY_RESTORE(_msg, sender) {
    // Always fan out: a stranded vanished tab is the worst possible outcome.
    const res = await broadcastToMeetingTabs({ type: "EMERGENCY_RESTORE" });
    await syncBadge();
    return { ok: true, engineState: "live", ...res, from: sender?.tab?.id ?? null };
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
      ? sendToTarget(msg, sender.tab?.id)
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
