/* Snap Vanish v2.0.0 — Popup Controller */

const $ = (id) => document.getElementById(id);

const MODE_PRESETS = {
  professional: {
    effect: "fade-out",
    duration: 1.2,
    sensitivity: 78,
    density: 55,
    sound: false,
    lowPowerMode: false,
  },
  creative: {
    effect: "dust",
    duration: 1.8,
    sensitivity: 62,
    density: 85,
    sound: true,
    lowPowerMode: false,
  },
  minimal: {
    effect: "fade-out",
    duration: 0.8,
    sensitivity: 72,
    density: 35,
    sound: false,
    lowPowerMode: false,
  },
  "low-power": {
    effect: "pixel-dissolve",
    duration: 1.1,
    sensitivity: 68,
    density: 30,
    sound: false,
    lowPowerMode: true,
  },
};

const state = {
  enabled: true,
  sensitivity: 62,
  duration: 1.8,
  direction: "right",
  sound: true,
  effect: "dust",
  density: 80,
  lowPowerMode: false,
  meetingMode: "creative",
  engineState: "live",
  muted: false,
};

function paint() {
  $("enabled").setAttribute("aria-checked", String(state.enabled));
  $("sensitivity").value = String(state.sensitivity);
  $("sensitivity-out").textContent = String(state.sensitivity);
  $("duration").value = String(state.duration);
  $("duration-out").textContent = `${Number(state.duration).toFixed(1)} s`;
  $("density").value = String(state.density);
  $("density-out").textContent = `${state.density}%`;
  $("effect").value = state.effect || "dust";
  $("meetingMode").value = state.meetingMode || "creative";
  $("sound").checked = Boolean(state.sound);
  $("lowPowerMode").checked = Boolean(state.lowPowerMode);

  const badge = $("state-badge");
  const st = state.engineState || "live";
  badge.textContent = st.toUpperCase();
  badge.setAttribute("data-state", st);

  $("snap-label").textContent =
    st === "vanished"
      ? "Restore Camera"
      : st === "vanishing" || st === "restoring"
        ? "Transitioning..."
        : "Vanish Now";

  document.querySelectorAll("#direction button").forEach((b) => {
    const on = b.dataset.dir === state.direction;
    b.classList.toggle("on", on);
    b.setAttribute("aria-checked", String(on));
  });

  const disabled = !state.enabled;
  [
    "snap",
    "sensitivity",
    "duration",
    "density",
    "effect",
    "meetingMode",
    "sound",
    "lowPowerMode",
  ].forEach((id) => {
    const el = $(id);
    if (el) el.disabled = disabled;
  });
  document.querySelectorAll("#direction button").forEach((b) => {
    b.disabled = disabled;
  });

  $("mic-dot").classList.toggle("muted", Boolean(state.muted));
  $("mic-label").textContent = state.muted ? "Mic muted" : "Mic live";
}

async function persist() {
  try {
    await chrome.storage.sync.set({
      enabled: state.enabled,
      sensitivity: state.sensitivity,
      duration: state.duration,
      direction: state.direction,
      sound: state.sound,
      effect: state.effect,
      density: state.density,
      lowPowerMode: state.lowPowerMode,
      meetingMode: state.meetingMode,
    });
  } catch {
    // Ignore storage error
  }
  chrome.runtime.sendMessage(
    { type: "SETTINGS_CHANGED", payload: state },
    (res) => {
      if (chrome.runtime.lastError || !res?.ok) {
        return;
      }
    },
  );
}

function refreshTabState() {
  chrome.runtime.sendMessage({ type: "GET_STATE" }, (res) => {
    if (chrome.runtime.lastError || !res || !res.ok) {
      $("host").textContent = "No active call tab (Meet / Teams / Zoom)";
      $("error-banner").hidden = false;
      $("error-text").textContent =
        res?.error ||
        "Open Google Meet, Microsoft Teams, or Zoom Web in the active tab.";
      return;
    }
    $("error-banner").hidden = true;
    if (res.host) {
      $("host").textContent = `${res.host} · ${res.interceptionMode || "overlay"}`;
    }
    if (res.engineState) state.engineState = res.engineState;
    if (typeof res.muted === "boolean") state.muted = res.muted;
    paint();
  });
}

chrome.storage.sync
  .get(null)
  .then((stored) => {
    if (stored && typeof stored === "object") {
      Object.assign(state, stored);
    }
    paint();
    refreshTabState();
  })
  .catch(() => {
    paint();
  });

$("enabled").addEventListener("click", () => {
  state.enabled = !state.enabled;
  paint();
  persist();
});

$("snap").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "SNAP_TOGGLE" }, (res) => {
    if (chrome.runtime.lastError || !res?.ok) {
      $("error-banner").hidden = false;
      $("error-text").textContent =
        res?.error || "Unable to trigger on this tab. Open a supported call tab.";
      return;
    }
    $("error-banner").hidden = true;
    if (res.engineState) state.engineState = res.engineState;
    if (typeof res.muted === "boolean") state.muted = res.muted;
    paint();
  });
});

$("emergency-restore").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "EMERGENCY_RESTORE" }, (res) => {
    state.engineState = "live";
    state.muted = false;
    if (res?.ok) {
      $("error-banner").hidden = true;
    }
    paint();
  });
});

$("retry-btn").addEventListener("click", () => {
  refreshTabState();
});

$("effect").addEventListener("change", (e) => {
  state.effect = e.target.value;
  state.meetingMode = "custom";
  paint();
  persist();
});

$("meetingMode").addEventListener("change", (e) => {
  const mode = e.target.value;
  state.meetingMode = mode;
  if (MODE_PRESETS[mode]) {
    Object.assign(state, MODE_PRESETS[mode]);
  }
  paint();
  persist();
});

["sensitivity", "duration", "density"].forEach((id) =>
  $(id).addEventListener("input", (e) => {
    state[id] = Number(e.target.value);
    state.meetingMode = "custom";
    paint();
    persist();
  }),
);

document.querySelectorAll("#direction button").forEach((b) =>
  b.addEventListener("click", () => {
    state.direction = b.dataset.dir;
    paint();
    persist();
  }),
);

$("sound").addEventListener("change", (e) => {
  state.sound = e.target.checked;
  paint();
  persist();
});

$("lowPowerMode").addEventListener("change", (e) => {
  state.lowPowerMode = e.target.checked;
  paint();
  persist();
});
