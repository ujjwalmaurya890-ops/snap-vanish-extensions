/**
 * Snap Vanish v2.0.0 — Chrome Manifest V3 Service Worker.
 *
 * Routes keyboard commands and popup/dashboard actions to the active call tab.
 * Persists settings in chrome.storage.sync so service-worker restarts never
 * lose user configuration. No external network calls are made here.
 */

const CALL_HOSTS = ["meet.google.com", "teams.microsoft.com", "zoom.us"];

const DEFAULTS = {
  enabled: true,
  sensitivity: 62,
  duration: 1.8,
  direction: "right",
  sound: true,
  effect: "dust",
  speed: 1.0,
  particleSize: 1.0,
  density: 80,
  colorAccent: "#d2451e",
  intensity: 85,
  muteOnVanish: true,
  lowPowerMode: false,
  meetingMode: "creative",
  cooldownMs: 2000,
};

const VALID_MESSAGE_TYPES = new Set([
  "PING",
  "GET_STATE",
  "SNAP_NOW",
  "SNAP_TOGGLE",
  "SNAP_VANISH_NOW",
  "EMERGENCY_RESTORE",
  "MUTE_TOGGLE",
  "RESET_FRAME",
  "SETTINGS_CHANGED",
  "SETTINGS",
  "STATE",
  "CALIBRATE_GESTURE",
  "RUN_DIAGNOSTICS",
  "CLEAR_LOCAL_DATA",
  "SYNC_DASHBOARD_STATE",
]);

function isValidMessage(msg) {
  return Boolean(
    msg &&
      typeof msg === "object" &&
      !Array.isArray(msg) &&
      typeof msg.type === "string" &&
      VALID_MESSAGE_TYPES.has(msg.type),
  );
}

async function activeCallTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !tab.url) return null;
    const host = new URL(tab.url).hostname;
    const supported = CALL_HOSTS.some(
      (h) => host === h || host.endsWith(`.${h}`),
    );
    return supported ? tab : null;
  } catch {
    return null;
  }
}

async function sendToCallTab(message) {
  const tab = await activeCallTab();
  if (!tab || !tab.id) {
    return {
      ok: false,
      reason: "no-call-tab",
      error: "Open Google Meet, Microsoft Teams, or Zoom Web in the active tab.",
    };
  }
  try {
    const response = await chrome.tabs.sendMessage(tab.id, message);
    return response ?? { ok: true, host: new URL(tab.url).hostname };
  } catch (err) {
    return {
      ok: false,
      reason: "content-script-not-ready",
      error:
        err instanceof Error
          ? err.message
          : "Reload the meeting tab to attach Snap Vanish.",
    };
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  try {
    const stored = await chrome.storage.sync.get(null);
    await chrome.storage.sync.set({ ...DEFAULTS, ...stored });
  } catch {
    // Storage unavailable in restricted test mode
  }
});

chrome.commands.onCommand.addListener((command) => {
  const actionMap = {
    "toggle-snap": "SNAP_TOGGLE",
    "vanish-now": "SNAP_VANISH_NOW",
    "mute-only": "MUTE_TOGGLE",
    "reset-frame": "EMERGENCY_RESTORE",
  };
  const action = actionMap[command];
  if (action) {
    sendToCallTab({ type: action }).catch(() => {});
  }
});

chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  if (!isValidMessage(message)) {
    respond({
      ok: false,
      reason: "invalid-message",
      error: "Unsupported or malformed extension message.",
    });
    return false;
  }

  switch (message.type) {
    case "PING":
      respond({ ok: true, host: "service-worker", version: "2.0.0" });
      return false;

    case "SNAP_NOW":
    case "SNAP_TOGGLE":
      sendToCallTab({ type: "SNAP_TOGGLE" }).then(respond);
      return true;

    case "SNAP_VANISH_NOW":
      sendToCallTab({ type: "SNAP_VANISH_NOW" }).then(respond);
      return true;

    case "EMERGENCY_RESTORE":
    case "RESET_FRAME":
      sendToCallTab({ type: "EMERGENCY_RESTORE" }).then(respond);
      return true;

    case "MUTE_TOGGLE":
      sendToCallTab({ type: "MUTE_TOGGLE" }).then(respond);
      return true;

    case "SETTINGS_CHANGED":
      chrome.storage.sync
        .set(message.payload ?? {})
        .catch(() => {})
        .finally(() => {
          sendToCallTab({
            type: "SETTINGS",
            payload: message.payload ?? {},
          }).then(respond);
        });
      return true;

    case "GET_STATE":
      sendToCallTab({ type: "STATE" }).then(respond);
      return true;

    case "RUN_DIAGNOSTICS":
      sendToCallTab({ type: "RUN_DIAGNOSTICS" }).then(respond);
      return true;

    case "CALIBRATE_GESTURE":
      sendToCallTab({
        type: "CALIBRATE_GESTURE",
        payload: message.payload ?? {},
      }).then(respond);
      return true;

    default:
      respond({ ok: false, reason: "unhandled-message-type" });
      return false;
  }
});
