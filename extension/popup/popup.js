/**
 * Snap Vanish — Toolbar Popup Controller
 *
 * Shows only truthful, live state: everything in the status grid comes from
 * the content script's GET_STATE response via the service worker, and the
 * shortcut list is read from `chrome.commands.getAll()` so unassigned or
 * conflicting keys are visible instead of hard-coded.
 */
(() => {
  const PRESET_CONFIGS = {
    dust: { effect: "dust", duration: 1.8, density: 80, direction: "right", colorAccent: "#e0532c" },
    "cinematic-disintegration": {
      effect: "cinematic-disintegration",
      duration: 2.2,
      density: 92,
      direction: "right",
      colorAccent: "#f0623a",
    },
    "light-burst": {
      effect: "light-burst",
      duration: 1.5,
      density: 85,
      direction: "toward",
      colorAccent: "#f59e0b",
    },
    "fade-out": {
      effect: "fade-out",
      duration: 2.0,
      density: 60,
      direction: "up",
      colorAccent: "#d97706",
    },
    "digital-glitch": {
      effect: "digital-glitch",
      duration: 1.6,
      density: 88,
      direction: "down",
      colorAccent: "#38bdf8",
    },
    "fine-particles": {
      effect: "fine-particles",
      duration: 1.7,
      density: 95,
      direction: "up",
      colorAccent: "#e5e7eb",
    },
    "reverse-assembly": {
      effect: "dust",
      duration: 1.8,
      density: 84,
      direction: "left",
      colorAccent: "#10b981",
    },
  };

  const MODE_HINTS = {
    smart: "Gesture confirmed by snap sound. Sound alone never triggers.",
    "gesture-only": "Gesture only — the microphone is never opened for detection.",
    manual: "No automatic detection. Use Snap Now, the meeting HUD, or your shortcut.",
  };

  const $ = (id) => document.getElementById(id);
  const masterToggle = $("master-toggle");
  const themeToggle = $("theme-toggle");
  const brandVersion = $("brand-version");
  const statusDot = $("status-dot");
  const statusText = $("status-text");
  const platformLabel = $("platform-label");
  const presetSelect = $("preset-select");
  const sensRange = $("sens-range");
  const sensVal = $("sens-val");
  const micToggle = $("mic-toggle");
  const micState = $("mic-state");
  const lowPowerToggle = $("lowpower-toggle");
  const lowPowerState = $("lowpower-state");
  const btnVanish = $("btn-vanish");
  const btnReturn = $("btn-return");
  const btnRestore = $("btn-restore");
  const btnCapturePlate = $("btn-capture-plate");
  const btnClearPlate = $("btn-clear-plate");
  const plateState = $("plate-state");
  const btnOpenStudio = $("btn-open-studio");
  const btnCustomizeKeys = $("btn-customize-keys");
  const modeHint = $("mode-hint");
  const modeButtons = Array.from(document.querySelectorAll(".seg-btn"));

  const stat = {
    camera: [$("stat-camera"), $("dot-camera")],
    mic: [$("stat-mic"), $("dot-mic")],
    hand: [$("stat-hand"), $("dot-hand")],
    detection: [$("stat-detection"), $("dot-detection")],
    anim: [$("stat-anim"), $("dot-anim")],
    stream: [$("stat-stream"), $("dot-stream")],
  };

  function setStat(key, text, tone) {
    const [label, dot] = stat[key];
    if (label) { label.textContent = text; label.title = text; }
    if (dot) dot.setAttribute("data-tone", tone);
  }

  let settingsError = null;
  let currentSettings = {
    enabled: true,
    sensitivity: 62,
    effect: "dust",
    lowPowerMode: false,
    gesture: { enabled: true, detectionMode: "smart", sensitivity: 62, requireAudioConfirm: true },
    audio: { enabled: true },
  };
  const emptyCallState = {
    ok: false,
    engineState: "live",
    host: null,
    interceptionMode: "inactive",
    cameraPresent: false,
    handModelReady: false,
    audioGateActive: false,
    detectionActive: false,
    muted: null,
  };
  let callState = { ...emptyCallState };

  function detectionMode() {
    return currentSettings.gesture?.detectionMode || "smart";
  }

  function renderUI() {
    const enabled = currentSettings.enabled !== false;
    masterToggle.setAttribute("aria-checked", String(enabled));
    sensRange.value = String(currentSettings.sensitivity ?? 62);
    sensVal.textContent = `${currentSettings.sensitivity ?? 62}/100`;
    sensRange.disabled = !enabled || detectionMode() === "manual";
    presetSelect.disabled = !enabled;
    if (PRESET_CONFIGS[currentSettings.effect]) presetSelect.value = currentSettings.effect;

    for (const btn of modeButtons) {
      const selected = btn.dataset.mode === detectionMode();
      btn.setAttribute("aria-checked", String(selected));
      btn.tabIndex = selected ? 0 : -1;
      btn.disabled = !enabled;
    }
    const smartHint = currentSettings.gesture?.requireAudioConfirm === false
      ? "Audio confirmation is disabled; Smart uses the gesture alone."
      : currentSettings.audio?.enabled === false
        ? "Audio is disabled; Smart cannot confirm a gesture."
        : MODE_HINTS.smart;
    modeHint.textContent = settingsError || (detectionMode() === "smart" ? smartHint : MODE_HINTS[detectionMode()]) || MODE_HINTS.smart;

    const lpOn = Boolean(currentSettings.lowPowerMode);
    lowPowerToggle.setAttribute("data-on", String(lpOn));
    lowPowerToggle.setAttribute("aria-pressed", String(lpOn));
    lowPowerState.textContent = lpOn ? "ON" : "OFF";

    const vanished = callState.ok && callState.engineState === "vanished";
    const transitioning = callState.ok && (callState.engineState === "vanishing" || callState.engineState === "restoring");
    if (callState.restoreError) {
      statusDot.setAttribute("data-tone", "amber");
      statusText.textContent = "CAMERA RESTORE FAILED";
    } else if (callState.renderError) {
      statusDot.setAttribute("data-tone", "amber");
      statusText.textContent = "EFFECT UNAVAILABLE";
    } else if (!enabled) {
      statusDot.setAttribute("data-tone", "muted");
      statusText.textContent = "PAUSED";
    } else if (!callState.ok) {
      statusDot.setAttribute("data-tone", "muted");
      statusText.textContent = callState.reason === "multiple-meeting-tabs" ? "SELECT A MEETING TAB" : "NO REACHABLE MEETING TAB";
    } else if (vanished) {
      statusDot.setAttribute("data-tone", "amber");
      statusText.textContent = callState.interceptionMode === "webrtc-sender" ? "EFFECT ON CAMERA" : "LOCAL TILE ONLY";
    } else if (transitioning) {
      statusDot.setAttribute("data-tone", "amber");
      statusText.textContent = callState.engineState === "vanishing" ? "VANISHING…" : "RETURNING…";
    } else {
      statusDot.setAttribute("data-tone", callState.detectionActive ? "emerald" : "muted");
      statusText.textContent = callState.detectionActive ? "DETECTION ACTIVE" : "SUPPORTED TAB";
    }
    platformLabel.textContent = callState.ok && callState.host
      ? callState.host
      : callState.reason === "multiple-meeting-tabs"
        ? "Focus the intended meeting tab"
        : "Open Meet / Teams / Zoom";

    setStat("camera", !callState.ok ? "Unknown" : callState.cameraPresent ? "Preview found" : "Not found",
      callState.ok && callState.cameraPresent ? "on" : callState.ok ? "warn" : "off");
    const micLabel = !callState.ok || callState.muted === null ? "Unknown" : callState.muted ? "Muted" : "Unmuted";
    setStat("mic", callState.audioGateActive ? `${micLabel} · listening` : micLabel,
      callState.audioGateActive ? "warn" : callState.muted === false ? "on" : "off");
    setStat("hand", !callState.ok ? "Unknown" : callState.handModelReady ? "Model ready" : callState.handModelError ? "Unavailable" : "Not ready",
      callState.ok && callState.handModelReady ? "on" : "off");
    const detectionLabels = {
      active: "Active", manual: "Manual", disabled: "Paused", "paused-hidden": "Tab hidden",
      "no-camera": "No camera", "model-not-ready": "Model not ready", "model-unavailable": "Model unavailable", "audio-unavailable": "Audio unavailable",
      "waiting-audio": "Waiting for audio", transitioning: "Transitioning", starting: "Starting",
    };
    setStat("detection", !callState.ok ? "Unknown" : detectionLabels[callState.detectionStatus] || "Not ready",
      callState.ok && callState.detectionActive ? "on" : "off");
    setStat("anim", !callState.ok ? "Unknown" :
      ({ live: "Live", vanishing: "Vanishing", vanished: "Vanished", restoring: "Returning" }[callState.engineState] || "Unknown"),
      !callState.ok ? "off" : vanished || transitioning ? "warn" : "on");
    const streamLabel = !callState.ok ? "Unknown" : callState.restoreError ? "Restore failed" : callState.renderError ? "Effect unavailable" :
      callState.engineState === "live" ? (callState.interceptionMode === "webrtc-sender" ? "Restore pending" : "No effect") :
      callState.interceptionMode === "webrtc-sender" ? "Effect sent" : "Local tile only";
    setStat("stream", streamLabel, !callState.ok ? "off" : callState.restoreError || callState.renderError || streamLabel === "Local tile only" || streamLabel === "Restore pending" ? "warn" : "on");

    micToggle.disabled = !callState.ok || typeof callState.muted !== "boolean";
    micToggle.setAttribute("data-on", String(callState.muted === false));
    micToggle.setAttribute("aria-pressed", String(callState.muted === false));
    micToggle.setAttribute("data-warn", String(callState.muted === true));
    micState.textContent = micLabel.toUpperCase();

    const capturing = callState.cleanPlateStatus === "countdown";
    const awaitingReview = callState.cleanPlateStatus === "review";
    btnCapturePlate.textContent = capturing ? "Cancel capture" : awaitingReview ? "Review plate" : "Capture plate";
    btnCapturePlate.disabled = !callState.ok || (!capturing && (!enabled || !callState.cameraPresent || callState.engineState !== "live" || Boolean(callState.restoreError)));
    btnClearPlate.disabled = !callState.ok || (!capturing && !awaitingReview && callState.cleanPlateStatus !== "captured");
    plateState.textContent = !callState.ok ? "Meeting background unknown." : capturing
      ? `Capturing in ${callState.cleanPlateRemaining || 1}s — step out of frame.`
      : callState.cleanPlateError && callState.cleanPlateError !== "cancelled"
        ? "Capture was interrupted or failed; try again in the focused meeting tab."
        : awaitingReview
          ? "Review the HUD preview and choose ‘Use this plate’; until then a solid background is used."
          : callState.cleanPlateStatus === "captured"
            ? "Approved plate kept in tab memory for the next vanish."
            : "No captured plate; solid background used.";
    btnVanish.disabled = !enabled || !callState.ok || !callState.cameraPresent || vanished || transitioning || capturing;
    btnReturn.disabled = !enabled || !callState.ok || (!vanished && !transitioning && !callState.restoreError);
  }

  function pushSettingsPatch(patch) {
    currentSettings = {
      ...currentSettings,
      ...patch,
      gesture: { ...(currentSettings.gesture || {}), ...(patch.gesture || {}) },
      audio: { ...(currentSettings.audio || {}), ...(patch.audio || {}) },
    };
    renderUI();
    chrome.runtime.sendMessage({ type: "SETTINGS_CHANGED", payload: patch }, (response) => {
      if (chrome.runtime.lastError || !response?.ok) {
        settingsError = "Settings could not be saved. Try again.";
      } else {
        settingsError = null;
      }
      renderUI();
    });
  }

  /* ----- Theme (popup-local preference) ----- */
  function applyTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme === "light" ? "light" : "dark");
  }
  try {
    chrome.storage.local.get(["sv_popup_theme"], (res) => {
      applyTheme(res?.sv_popup_theme);
    });
  } catch {
    /* storage unavailable — keep dark default */
  }
  themeToggle.addEventListener("click", () => {
    const next =
      document.documentElement.getAttribute("data-theme") === "light" ? "dark" : "light";
    applyTheme(next);
    try {
      chrome.storage.local.set({ sv_popup_theme: next });
    } catch {
      /* best effort */
    }
  });

  /* ----- Version from the manifest (never hard-coded) ----- */
  try {
    const version = chrome.runtime.getManifest()?.version;
    if (version) brandVersion.textContent = `v${version} · MV3 · LOCAL AI`;
  } catch {
    /* keep fallback label */
  }

  /* ----- Settings ----- */
  function applyStoredSettings(s) {
    if (!s || typeof s !== "object") return;
    currentSettings = {
      ...currentSettings,
      ...s,
      gesture: { ...currentSettings.gesture, ...(s.gesture || {}) },
      audio: { ...currentSettings.audio, ...(s.audio || {}) },
    };
    renderUI();
  }
  chrome.storage.sync.get(null, (stored) => {
    applyStoredSettings(stored?.snap_vanish_settings_v2 || stored || {});
  });
  chrome.storage.onChanged?.addListener((changes, area) => {
    if (area === "sync" && changes.snap_vanish_settings_v2?.newValue) {
      applyStoredSettings(changes.snap_vanish_settings_v2.newValue);
    }
  });

  chrome.storage.local.get(["snap_vanish_presets_v2"], (res) => {
    const custom = res?.snap_vanish_presets_v2;
    if (Array.isArray(custom)) {
      for (const p of custom) {
        if (p && p.id && p.name && p.config) {
          PRESET_CONFIGS[p.id] = p.config;
          const opt = document.createElement("option");
          opt.value = p.id;
          opt.textContent = `${p.name} (Custom)`;
          presetSelect.appendChild(opt);
        }
      }
      renderUI();
    }
  });

  let stateRequestId = 0;
  function refreshCallState() {
    const requestId = ++stateRequestId;
    chrome.runtime.sendMessage({ type: "GET_STATE" }, (res) => {
      if (requestId !== stateRequestId) return;
      callState = chrome.runtime.lastError || !res?.ok
        ? { ...emptyCallState, reason: res?.reason || "content-script-unreachable" }
        : { ...emptyCallState, ...res };
      renderUI();
    });
  }
  refreshCallState();
  const statusPoll = window.setInterval(() => { if (!document.hidden) refreshCallState(); }, 1500);
  window.addEventListener("pagehide", () => window.clearInterval(statusPoll), { once: true });

  /* ----- Shortcuts (live bindings from Chrome, brief §7) ----- */
  function renderShortcuts() {
    const fallback = {
      "toggle-snap": "Alt+Shift+S",
      "vanish-now": "Alt+Shift+D",
      "mute-only": "Alt+Shift+M",
      "emergency-restore": "Alt+Shift+R",
    };
    const apply = (commands) => {
      for (const [name, def] of Object.entries(fallback)) {
        const el = $(`key-${name}`);
        if (!el) continue;
        const cmd = Array.isArray(commands) ? commands.find((c) => c.name === name) : null;
        const shortcut = cmd?.shortcut || "";
        el.textContent = shortcut || "Not set";
        el.setAttribute("data-unset", String(!shortcut));
        el.title = shortcut ? `Assigned: ${shortcut}` : `Unassigned (default ${def})`;
      }
    };
    try {
      if (chrome.commands?.getAll) {
        chrome.commands.getAll(apply);
        return;
      }
    } catch {
      /* fall through to defaults */
    }
    for (const name of Object.keys(fallback)) {
      const el = $(`key-${name}`);
      if (el) { el.textContent = "Unavailable"; el.setAttribute("data-unset", "true"); }
    }
    $("keys-hint").textContent = "Shortcut assignments are unavailable in this context.";
  }
  renderShortcuts();

  btnCustomizeKeys.addEventListener("click", () => {
    try {
      chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
    } catch {
      $("keys-hint").textContent =
        "Open chrome://extensions/shortcuts in a new tab to customize bindings.";
    }
  });

  /* ----- Controls ----- */
  masterToggle.addEventListener("click", () => {
    pushSettingsPatch({ enabled: currentSettings.enabled === false });
  });

  for (const btn of modeButtons) {
    btn.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const index = modeButtons.indexOf(btn);
      const next = event.key === "Home" ? 0 : event.key === "End" ? modeButtons.length - 1 :
        (index + (event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : -1) + modeButtons.length) % modeButtons.length;
      if (!modeButtons[next].disabled) { modeButtons[next].focus(); modeButtons[next].click(); }
    });
    btn.addEventListener("click", () => {
      const mode = btn.dataset.mode;
      if (mode === "smart") {
        pushSettingsPatch({
          gesture: { detectionMode: "smart", enabled: true, requireAudioConfirm: true },
          audio: { enabled: true },
        });
      } else if (mode === "gesture-only") {
        pushSettingsPatch({
          gesture: { detectionMode: "gesture-only", enabled: true, requireAudioConfirm: false },
        });
      } else {
        pushSettingsPatch({ gesture: { detectionMode: "manual" } });
      }
    });
  }

  presetSelect.addEventListener("change", () => {
    const chosen = PRESET_CONFIGS[presetSelect.value];
    if (chosen) pushSettingsPatch(chosen);
  });

  sensRange.addEventListener("input", () => {
    const val = Number(sensRange.value);
    sensVal.textContent = `${val}/100`;
    pushSettingsPatch({ sensitivity: val, gesture: { sensitivity: val, mode: "custom" } });
  });

  function sendAction(type) {
    const errorEl = $("action-error");
    chrome.runtime.sendMessage({ type }, (result) => {
      const failed = chrome.runtime.lastError || !result?.ok;
      const reasons = {
        "multiple-meeting-tabs": "Focus the intended meeting tab, then reopen the popup.",
        "no-supported-meeting-tab": "No supported meeting tab was found.",
        "no-verified-camera-preview": "A verified local camera preview was not found.",
        "restore-incomplete": "Restore failed on one or more tabs. Check your meeting camera immediately.",
        "restore-required": "Restore the camera before starting another effect.",
        "focus-meeting-tab": "Focus the meeting tab before capturing a background.",
        "camera-not-live": "Return to the live camera before capturing a background.",
        "capture-pending": "Wait for the capture or cancel it before starting an effect.",
        "rendering-unavailable": "The effect renderer is unavailable; the camera was not replaced.",
        "content-script-unreachable": "The meeting tab is unreachable. Reload it and try again.",
      };
      errorEl.textContent = failed ? (reasons[result?.reason] || "Action could not be completed. Check the meeting tab and try again.") : "";
      errorEl.hidden = !failed;
      window.setTimeout(refreshCallState, 200);
    });
  }
  micToggle.addEventListener("click", () => sendAction("MUTE_TOGGLE"));

  lowPowerToggle.addEventListener("click", () => {
    pushSettingsPatch({ lowPowerMode: !currentSettings.lowPowerMode });
  });

  btnCapturePlate.addEventListener("click", () => sendAction(callState.cleanPlateStatus === "countdown" ? "CANCEL_CLEAN_PLATE" : callState.cleanPlateStatus === "review" ? "REVIEW_CLEAN_PLATE" : "CAPTURE_CLEAN_PLATE"));
  btnClearPlate.addEventListener("click", () => sendAction("CLEAR_CLEAN_PLATE"));
  btnVanish.addEventListener("click", () => sendAction("SNAP_VANISH_NOW"));
  btnReturn.addEventListener("click", () => sendAction("SNAP_RESTORE_NOW"));
  btnRestore.addEventListener("click", () => sendAction("EMERGENCY_RESTORE"));

  btnOpenStudio.addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "OPEN_STUDIO" });
    window.close();
  });
})();
