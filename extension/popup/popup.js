/**
 * Snap Vanish 2.0 — Compact Chrome Toolbar Popup Controller
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
    "fine-particles": {
      effect: "fine-particles",
      duration: 1.7,
      density: 95,
      direction: "up",
      colorAccent: "#e5e7eb",
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
      duration: 1.2,
      density: 55,
      direction: "up",
      colorAccent: "#d97706",
    },
    "reverse-assembly": {
      effect: "dust",
      duration: 1.8,
      density: 84,
      direction: "left",
      colorAccent: "#10b981",
    },
  };

  const masterToggle = document.getElementById("master-toggle");
  const statusDot = document.getElementById("status-dot");
  const statusText = document.getElementById("status-text");
  const platformLabel = document.getElementById("platform-label");
  const presetSelect = document.getElementById("preset-select");
  const sensRange = document.getElementById("sens-range");
  const sensVal = document.getElementById("sens-val");
  const audioToggle = document.getElementById("audio-toggle");
  const audioState = document.getElementById("audio-state");
  const lowPowerToggle = document.getElementById("lowpower-toggle");
  const lowPowerState = document.getElementById("lowpower-state");
  const btnVanish = document.getElementById("btn-vanish");
  const btnRestore = document.getElementById("btn-restore");
  const btnOpenStudio = document.getElementById("btn-open-studio");

  let currentSettings = {
    enabled: true,
    sensitivity: 62,
    effect: "dust",
    lowPowerMode: false,
    gesture: { enabled: true, sensitivity: 62, requireAudioConfirm: true },
    audio: { enabled: true },
  };
  let callState = { ok: false, engineState: "live", host: null, interceptionMode: "inactive" };

  function renderUI() {
    const enabled = currentSettings.enabled !== false;
    masterToggle.setAttribute("aria-checked", String(enabled));
    sensRange.value = String(currentSettings.sensitivity || 62);
    sensVal.textContent = `${currentSettings.sensitivity || 62}/100`;
    sensRange.disabled = !enabled;
    presetSelect.disabled = !enabled;

    if (PRESET_CONFIGS[currentSettings.effect]) {
      presetSelect.value = currentSettings.effect;
    }

    const audioOn =
      currentSettings.audio?.enabled !== false &&
      currentSettings.gesture?.requireAudioConfirm !== false;
    audioToggle.setAttribute("data-on", String(audioOn));
    audioState.textContent = audioOn ? "ON" : "OFF";

    const lpOn = Boolean(currentSettings.lowPowerMode);
    lowPowerToggle.setAttribute("data-on", String(lpOn));
    lowPowerState.textContent = lpOn ? "ON" : "OFF";

    if (!enabled) {
      statusDot.setAttribute("data-tone", "muted");
      statusText.textContent = "PAUSED";
      btnVanish.disabled = true;
    } else if (callState.engineState === "vanished") {
      statusDot.setAttribute("data-tone", "amber");
      statusText.textContent = "VANISHED · PLATE";
      btnVanish.textContent = "Snap Return";
      btnVanish.disabled = !callState.ok;
    } else {
      statusDot.setAttribute("data-tone", "emerald");
      statusText.textContent = callState.ok ? "ARMED · LIVE CALL" : "ARMED · NO CALL TAB";
      btnVanish.textContent = "Test Vanish";
      btnVanish.disabled = !callState.ok;
    }

    if (callState.ok && callState.host) {
      const modeTag =
        callState.interceptionMode === "webrtc-sender" ? "WebRTC" : "Tile";
      platformLabel.textContent = `${callState.host} · ${modeTag}`;
    } else {
      platformLabel.textContent = "Open Meet / Teams / Zoom";
    }
  }

  function pushSettingsPatch(patch) {
    currentSettings = {
      ...currentSettings,
      ...patch,
      gesture: { ...(currentSettings.gesture || {}), ...(patch.gesture || {}) },
      audio: { ...(currentSettings.audio || {}), ...(patch.audio || {}) },
    };
    renderUI();
    chrome.runtime.sendMessage({
      type: "SETTINGS_CHANGED",
      payload: currentSettings,
    });
  }

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

  // Load any custom user presets from chrome.storage.local
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
    }
  });

  function refreshCallState() {
    chrome.runtime.sendMessage({ type: "GET_STATE" }, (res) => {
      if (chrome.runtime.lastError || !res) {
        callState = { ok: false, engineState: "live", host: null, interceptionMode: "inactive" };
      } else {
        callState = res;
      }
      renderUI();
    });
  }
  refreshCallState();

  masterToggle.addEventListener("click", () => {
    pushSettingsPatch({ enabled: currentSettings.enabled === false });
  });

  presetSelect.addEventListener("change", () => {
    const chosen = PRESET_CONFIGS[presetSelect.value];
    if (chosen) {
      pushSettingsPatch(chosen);
    }
  });

  sensRange.addEventListener("input", () => {
    const val = Number(sensRange.value);
    sensVal.textContent = `${val}/100`;
    pushSettingsPatch({
      sensitivity: val,
      gesture: { sensitivity: val, mode: "custom" },
    });
  });

  audioToggle.addEventListener("click", () => {
    const currentlyOn = audioToggle.getAttribute("data-on") === "true";
    pushSettingsPatch({
      audio: { enabled: !currentlyOn },
      gesture: { requireAudioConfirm: !currentlyOn },
    });
  });

  lowPowerToggle.addEventListener("click", () => {
    const currentlyOn = lowPowerToggle.getAttribute("data-on") === "true";
    pushSettingsPatch({ lowPowerMode: !currentlyOn });
  });

  btnVanish.addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "SNAP_NOW" }, () => {
      setTimeout(refreshCallState, 150);
    });
  });

  btnRestore.addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "EMERGENCY_RESTORE" }, () => {
      setTimeout(refreshCallState, 100);
    });
  });

  btnOpenStudio.addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "OPEN_STUDIO" });
    window.close();
  });
})();
