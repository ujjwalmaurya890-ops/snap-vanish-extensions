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
    if (label) label.textContent = text;
    if (dot) dot.setAttribute("data-tone", tone);
  }

  let currentSettings = {
    enabled: true,
    sensitivity: 62,
    effect: "dust",
    lowPowerMode: false,
    gesture: { enabled: true, detectionMode: "smart", sensitivity: 62, requireAudioConfirm: true },
    audio: { enabled: true },
  };
  let callState = {
    ok: false,
    engineState: "live",
    host: null,
    interceptionMode: "inactive",
    cameraPresent: false,
    handModelReady: false,
    audioGateActive: false,
    detectionActive: false,
    muted: false,
  };

  function detectionMode() {
    return currentSettings.gesture?.detectionMode || "smart";
  }

  function renderUI() {
    const enabled = currentSettings.enabled !== false;
    masterToggle.setAttribute("aria-checked", String(enabled));
    sensRange.value = String(currentSettings.sensitivity || 62);
    sensVal.textContent = `${currentSettings.sensitivity || 62}/100`;
    sensRange.disabled = !enabled || detectionMode() === "manual";
    presetSelect.disabled = !enabled;

    if (PRESET_CONFIGS[currentSettings.effect]) {
      presetSelect.value = currentSettings.effect;
    }

    for (const btn of modeButtons) {
      btn.setAttribute("aria-checked", String(btn.dataset.mode === detectionMode()));
      btn.disabled = !enabled;
    }
    modeHint.textContent = MODE_HINTS[detectionMode()] || MODE_HINTS.smart;

    const lpOn = Boolean(currentSettings.lowPowerMode);
    lowPowerToggle.setAttribute("data-on", String(lpOn));
    lowPowerState.textContent = lpOn ? "ON" : "OFF";

    // Headline status
    const vanished = callState.engineState === "vanished";
    const transitioning =
      callState.engineState === "vanishing" || callState.engineState === "restoring";
    if (!enabled) {
      statusDot.setAttribute("data-tone", "muted");
      statusText.textContent = "PAUSED";
    } else if (vanished) {
      statusDot.setAttribute("data-tone", "amber");
      statusText.textContent = "VANISHED";
    } else if (transitioning) {
      statusDot.setAttribute("data-tone", "amber");
      statusText.textContent =
        callState.engineState === "vanishing" ? "VANISHING…" : "RETURNING…";
    } else {
      statusDot.setAttribute("data-tone", "emerald");
      statusText.textContent = callState.ok ? "ARMED · LIVE CALL" : "ARMED · NO CALL TAB";
    }

    if (callState.ok && callState.host) {
      const modeTag = callState.interceptionMode === "webrtc-sender" ? "WebRTC" : "Tile";
      platformLabel.textContent = `${callState.host} · ${modeTag}`;
    } else {
      platformLabel.textContent = "Open Meet / Teams / Zoom";
    }

    // Live status grid — every value derives from GET_STATE / settings.
    setStat(
      "camera",
      !callState.ok ? "No call tab" : callState.cameraPresent ? "Connected" : "Not found",
      callState.cameraPresent ? "on" : callState.ok ? "warn" : "off",
    );
    setStat(
      "mic",
      callState.muted
        ? "Muted by SV"
        : callState.audioGateActive
          ? "Snap-listen on"
          : "Not monitored",
      callState.muted ? "warn" : callState.audioGateActive ? "on" : "off",
    );
    setStat(
      "hand",
      callState.handModelReady ? "Model ready" : "Loads on demand",
      callState.handModelReady ? "on" : "off",
    );
    setStat(
      "detection",
      !enabled
        ? "Paused"
        : detectionMode() === "manual"
          ? "Manual"
          : callState.detectionActive
            ? "Active"
            : "Idle",
      callState.detectionActive && enabled ? "on" : "off",
    );
    setStat(
      "anim",
      { live: "Live", vanishing: "Vanishing", vanished: "Vanished", restoring: "Returning" }[
        callState.engineState
      ] || "Live",
      vanished || transitioning ? "warn" : "on",
    );
    setStat(
      "stream",
      callState.interceptionMode === "webrtc-sender" ? "WebRTC sender" : "Tile overlay",
      callState.interceptionMode === "webrtc-sender" ? "on" : "off",
    );

    // Mic pill reflects extension-caused mute only (never guesses host state).
    micToggle.disabled = !callState.ok;
    micToggle.setAttribute("data-on", String(!callState.muted));
    micToggle.setAttribute("data-warn", String(Boolean(callState.muted)));
    micState.textContent = !callState.ok ? "—" : callState.muted ? "MUTED" : "LIVE";

    btnVanish.disabled = !enabled || !callState.ok || vanished || transitioning;
    btnReturn.disabled = !enabled || !callState.ok || (!vanished && !transitioning);
  }

  function pushSettingsPatch(patch) {
    currentSettings = {
      ...currentSettings,
      ...patch,
      gesture: { ...(currentSettings.gesture || {}), ...(patch.gesture || {}) },
      audio: { ...(currentSettings.audio || {}), ...(patch.audio || {}) },
    };
    renderUI();
    chrome.runtime.sendMessage({ type: "SETTINGS_CHANGED", payload: currentSettings });
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
  chrome.storage.sync.get(null, (stored) => {
    const s = stored?.snap_vanish_settings_v2 || stored || {};
    currentSettings = {
      ...currentSettings,
      ...s,
      gesture: { ...currentSettings.gesture, ...(s.gesture || {}) },
      audio: { ...currentSettings.audio, ...(s.audio || {}) },
    };
    renderUI();
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

  function refreshCallState() {
    chrome.runtime.sendMessage({ type: "GET_STATE" }, (res) => {
      if (chrome.runtime.lastError || !res) {
        callState = { ...callState, ok: false, engineState: "live", host: null, interceptionMode: "inactive" };
      } else {
        callState = { ...callState, ...res };
      }
      renderUI();
    });
  }
  refreshCallState();

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
    apply(Object.entries(fallback).map(([name, shortcut]) => ({ name, shortcut })));
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

  micToggle.addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "MUTE_TOGGLE" }, () => {
      setTimeout(refreshCallState, 150);
    });
  });

  lowPowerToggle.addEventListener("click", () => {
    pushSettingsPatch({ lowPowerMode: !currentSettings.lowPowerMode });
  });

  btnVanish.addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "SNAP_VANISH_NOW" }, () => {
      setTimeout(refreshCallState, 200);
    });
  });

  btnReturn.addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "SNAP_RESTORE_NOW" }, () => {
      setTimeout(refreshCallState, 200);
    });
  });

  btnRestore.addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "EMERGENCY_RESTORE" }, () => {
      setTimeout(refreshCallState, 120);
    });
  });

  btnOpenStudio.addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "OPEN_STUDIO" });
    window.close();
  });
})();
