/**
 * Snap Vanish 2.0 — Manifest V3 Background Service Worker
 *
 * Responsibilities:
 * - Strict runtime validation of extension messages across Popup, Studio, and Content Scripts
 * - Storage partitioning (`chrome.storage.sync` for compact preferences vs
 *   `chrome.storage.local` for metadata-only activity logs)
 * - Global Chrome `commands` routing (`toggle-snap`, `vanish-now`, `emergency-restore`)
 * - Toolbar badge synchronization (`ON`, `GONE`, `OFF`)
 */

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

async function updateBadge(enabled, vanished = false) {
  try {
    if (!enabled) {
      await chrome.action.setBadgeText({ text: "OFF" });
      await chrome.action.setBadgeBackgroundColor({ color: "#3f3f46" });
    } else if (vanished) {
      await chrome.action.setBadgeText({ text: "GONE" });
      await chrome.action.setBadgeBackgroundColor({ color: "#d97706" });
    } else {
      await chrome.action.setBadgeText({ text: "ON" });
      await chrome.action.setBadgeBackgroundColor({ color: "#e0532c" });
    }
  } catch {
    // Ignore badge API errors during worker startup
  }
}

async function findActiveMeetingTab() {
  const activeTabs = await chrome.tabs.query({
    active: true,
    currentWindow: true,
  });
  if (activeTabs[0] && isSupportedMeetingUrl(activeTabs[0].url)) {
    return activeTabs[0];
  }
  const allTabs = await chrome.tabs.query({
    url: [
      "https://meet.google.com/*",
      "https://teams.microsoft.com/*",
      "https://teams.live.com/*",
      "https://*.zoom.us/wc/*",
      "https://app.zoom.us/wc/*",
    ],
  });
  return allTabs[0] || null;
}

async function forwardToMeetingTab(message) {
  const tab = await findActiveMeetingTab();
  if (!tab || typeof tab.id !== "number") {
    return {
      ok: false,
      reason: "no-supported-meeting-tab",
      interceptionMode: "inactive",
    };
  }
  try {
    const res = await chrome.tabs.sendMessage(tab.id, message);
    if (res && typeof res.engineState === "string") {
      const prefs = await chrome.storage.sync.get(["enabled"]);
      await updateBadge(prefs.enabled !== false, res.engineState === "vanished");
    }
    return res || { ok: true };
  } catch (err) {
    return {
      ok: false,
      reason: "content-script-unreachable",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

chrome.runtime.onInstalled.addListener(async (details) => {
  const existing = await chrome.storage.sync.get(null);
  if (!existing || Object.keys(existing).length === 0) {
    await chrome.storage.sync.set(DEFAULT_SYNC_PREFS);
  }
  await updateBadge(existing?.enabled !== false, false);
  if (details.reason === "install") {
    await chrome.runtime.openOptionsPage();
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && changes.enabled) {
    void updateBadge(changes.enabled.newValue !== false, false);
  }
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command === "toggle-snap") {
    const curr = await chrome.storage.sync.get(["enabled"]);
    const next = curr.enabled === false;
    await chrome.storage.sync.set({ enabled: next });
    await updateBadge(next, false);
    await forwardToMeetingTab({
      type: "SETTINGS_CHANGED",
      payload: { enabled: next },
    });
  } else if (command === "vanish-now") {
    await forwardToMeetingTab({ type: "SNAP_NOW" });
  } else if (command === "mute-only") {
    await forwardToMeetingTab({ type: "MUTE_TOGGLE" });
  } else if (command === "emergency-restore" || command === "reset-frame") {
    await forwardToMeetingTab({ type: "EMERGENCY_RESTORE" });
    const curr = await chrome.storage.sync.get(["enabled"]);
    await updateBadge(curr.enabled !== false, false);
  }
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg !== "object" || typeof msg.type !== "string") {
    sendResponse({ ok: false, reason: "invalid-message" });
    return false;
  }
  if (!ALLOWED_TYPES.has(msg.type)) {
    sendResponse({ ok: false, reason: "unsupported-message-type" });
    return false;
  }

  if (msg.type === "OPEN_STUDIO") {
    chrome.runtime
      .openOptionsPage()
      .then(() => sendResponse({ ok: true }))
      .catch((err) =>
        sendResponse({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    return true;
  }

  if (msg.type === "CLEAR_LOCAL_DATA") {
    chrome.storage.local
      .clear()
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (msg.type === "SETTINGS_CHANGED" || msg.type === "SETTINGS") {
    const payload = msg.payload && typeof msg.payload === "object" ? msg.payload : {};
    chrome.storage.sync
      .set({
        enabled: payload.enabled !== false,
        sensitivity: Number(payload.sensitivity ?? 62),
        duration: Number(payload.duration ?? 1.8),
        direction: String(payload.direction ?? "right"),
        effect: String(payload.effect ?? "dust"),
        speed: Number(payload.speed ?? 1),
        density: Number(payload.density ?? 80),
        colorAccent: String(payload.colorAccent ?? "#e0532c"),
        lowPowerMode: Boolean(payload.lowPowerMode),
        snap_vanish_settings_v2: payload,
      })
      .then(() => forwardToMeetingTab({ type: "SETTINGS_CHANGED", payload }))
      .then((res) => sendResponse({ ok: true, forwarded: res.ok }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  forwardToMeetingTab(msg)
    .then(sendResponse)
    .catch((err) =>
      sendResponse({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  return true;
});
