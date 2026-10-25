import type {
  Direction,
  EffectPreset,
  EffectType,
  GestureAction,
  MeetingModeId,
  SettingsValidationResult,
  SnapSettings,
  ValidationIssue,
} from "../types/snapVanish";

export const STORAGE_KEYS = {
  SETTINGS: "snap_vanish_settings_v2",
  PRESETS: "snap_vanish_presets_v2",
  ANALYTICS: "snap_vanish_analytics_v2",
  DIAGNOSTICS: "snap_vanish_diagnostics_v2",
  FEEDBACK: "snap_vanish_feedback_v2",
  AUTH_SESSION: "snap_vanish_auth_session_v2",
} as const;

export const VALID_EFFECTS: readonly EffectType[] = [
  "dust",
  "pixel-dissolve",
  "digital-glitch",
  "fade-out",
  "light-burst",
] as const;

export const VALID_DIRECTIONS: readonly Direction[] = [
  "left",
  "right",
  "up",
  "down",
  "toward",
] as const;

export const VALID_MEETING_MODES: readonly MeetingModeId[] = [
  "professional",
  "creative",
  "minimal",
  "low-power",
  "custom",
] as const;

export const VALID_GESTURE_ACTIONS: readonly GestureAction[] = [
  "toggle-vanish",
  "vanish-only",
  "restore-only",
  "mute-only",
] as const;

export const DEFAULT_SETTINGS: SnapSettings = {
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
  gesture: {
    enabled: true,
    sensitivity: 62,
    cooldownMs: 2000,
    requireAudioConfirm: true,
    accidentalTriggerProtection: true,
    calibratedCollapseThresholdMm: 12,
    actionMapping: "toggle-vanish",
  },
  shortcuts: {
    toggleSnap: "Alt+Shift+S",
    vanishNow: "Alt+Shift+D",
    muteOnly: "Alt+Shift+M",
    emergencyRestore: "Alt+Shift+R",
  },
  onboardingCompleted: false,
  diagnosticLoggingEnabled: true,
};

export interface MeetingModeDefinition {
  id: Exclude<MeetingModeId, "custom">;
  name: string;
  tagline: string;
  description: string;
  settingsPatch: Partial<SnapSettings>;
}

export const MEETING_MODES: Record<
  Exclude<MeetingModeId, "custom">,
  MeetingModeDefinition
> = {
  professional: {
    id: "professional",
    name: "Professional",
    tagline: "Clean fade transition with strict false-trigger protection",
    description:
      "Uses a restrained 1.2s soft fade-out with slate-blue accent, muted click sound, high snap sensitivity (78) and a 2.5s cooldown to prevent accidental triggers during executive calls.",
    settingsPatch: {
      effect: "fade-out",
      duration: 1.2,
      speed: 1.0,
      particleSize: 1.0,
      density: 55,
      colorAccent: "#3b82f6",
      intensity: 65,
      sound: false,
      lowPowerMode: false,
      sensitivity: 78,
      meetingMode: "professional",
      gesture: {
        ...DEFAULT_SETTINGS.gesture,
        sensitivity: 78,
        cooldownMs: 2500,
        requireAudioConfirm: true,
        accidentalTriggerProtection: true,
      },
    },
  },
  creative: {
    id: "creative",
    name: "Creative",
    tagline: "Signature curl-noise ember dust disintegration",
    description:
      "Full 22k-particle ember dust dispersion with acoustic snap click, 1.8s duration, and balanced hand+audio trigger sensitivity (62).",
    settingsPatch: {
      effect: "dust",
      duration: 1.8,
      direction: "right",
      speed: 1.0,
      particleSize: 1.0,
      density: 85,
      colorAccent: "#d2451e",
      intensity: 88,
      sound: true,
      lowPowerMode: false,
      sensitivity: 62,
      meetingMode: "creative",
      gesture: {
        ...DEFAULT_SETTINGS.gesture,
        sensitivity: 62,
        cooldownMs: 2000,
        requireAudioConfirm: true,
        accidentalTriggerProtection: true,
      },
    },
  },
  minimal: {
    id: "minimal",
    name: "Minimal",
    tagline: "Ultra-fast, distraction-free camera exit",
    description:
      "0.8s rapid fade with no particle scatter, silent operation, and strict gesture confirmation.",
    settingsPatch: {
      effect: "fade-out",
      duration: 0.8,
      speed: 1.4,
      particleSize: 0.8,
      density: 35,
      colorAccent: "#64748b",
      intensity: 45,
      sound: false,
      lowPowerMode: false,
      sensitivity: 72,
      meetingMode: "minimal",
      gesture: {
        ...DEFAULT_SETTINGS.gesture,
        sensitivity: 72,
        cooldownMs: 2200,
        requireAudioConfirm: true,
        accidentalTriggerProtection: true,
      },
    },
  },
  "low-power": {
    id: "low-power",
    name: "Low-Power",
    tagline: "Battery-friendly mode for laptops and integrated GPUs",
    description:
      "Caps particle/block count at 30% density, disables multi-pass motion blur smears, and uses lightweight pixel-dissolve to minimize CPU/GPU thermal load.",
    settingsPatch: {
      effect: "pixel-dissolve",
      duration: 1.1,
      speed: 1.1,
      particleSize: 1.4,
      density: 30,
      colorAccent: "#10b981",
      intensity: 55,
      sound: false,
      lowPowerMode: true,
      sensitivity: 68,
      meetingMode: "low-power",
      gesture: {
        ...DEFAULT_SETTINGS.gesture,
        sensitivity: 68,
        cooldownMs: 2500,
        requireAudioConfirm: true,
        accidentalTriggerProtection: true,
      },
    },
  },
};

export const BUILT_IN_PRESETS: EffectPreset[] = [
  {
    id: "preset-ember-dust",
    name: "Ember Drift (Default)",
    description: "Classic curl-noise ember dust blowing right across the room plate.",
    isBuiltIn: true,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    config: {
      effect: "dust",
      direction: "right",
      duration: 1.8,
      speed: 1.0,
      particleSize: 1.0,
      density: 80,
      colorAccent: "#d2451e",
      intensity: 85,
      sound: true,
      lowPowerMode: false,
    },
  },
  {
    id: "preset-violet-vortex",
    name: "Violet Singularity",
    description: "High-density violet particles expanding toward the camera lens.",
    isBuiltIn: true,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    config: {
      effect: "dust",
      direction: "toward",
      duration: 2.2,
      speed: 1.15,
      particleSize: 1.2,
      density: 90,
      colorAccent: "#8b5cf6",
      intensity: 92,
      sound: true,
      lowPowerMode: false,
    },
  },
  {
    id: "preset-cyber-glitch",
    name: "Signal Loss Glitch",
    description: "RGB scanline displacement and digital block deconstruction.",
    isBuiltIn: true,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    config: {
      effect: "digital-glitch",
      direction: "left",
      duration: 1.3,
      speed: 1.3,
      particleSize: 1.1,
      density: 75,
      colorAccent: "#06b6d4",
      intensity: 85,
      sound: true,
      lowPowerMode: false,
    },
  },
  {
    id: "preset-pixel-mosaic",
    name: "Voxel Dissolve",
    description: "Structured mosaic tiles lifting upward into the background plate.",
    isBuiltIn: true,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    config: {
      effect: "pixel-dissolve",
      direction: "up",
      duration: 1.6,
      speed: 1.0,
      particleSize: 1.5,
      density: 70,
      colorAccent: "#3b82f6",
      intensity: 80,
      sound: true,
      lowPowerMode: false,
    },
  },
  {
    id: "preset-photon-burst",
    name: "Solar Light Burst",
    description: "Luminous radial flash that dissolves into warm golden motes.",
    isBuiltIn: true,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    config: {
      effect: "light-burst",
      direction: "toward",
      duration: 1.5,
      speed: 1.2,
      particleSize: 1.3,
      density: 75,
      colorAccent: "#f59e0b",
      intensity: 90,
      sound: true,
      lowPowerMode: false,
    },
  },
  {
    id: "preset-exec-fade",
    name: "Studio Clean Fade",
    description: "Smooth optical cross-dissolve to the empty room background.",
    isBuiltIn: true,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    config: {
      effect: "fade-out",
      direction: "right",
      duration: 1.2,
      speed: 1.0,
      particleSize: 1.0,
      density: 50,
      colorAccent: "#64748b",
      intensity: 60,
      sound: false,
      lowPowerMode: false,
    },
  },
];

function clampNumber(
  val: unknown,
  min: number,
  max: number,
  fallback: number,
  field: string,
  issues: ValidationIssue[],
): number {
  if (typeof val !== "number" || Number.isNaN(val) || !Number.isFinite(val)) {
    if (val !== undefined) {
      issues.push({
        field,
        message: `${field} must be a finite number between ${min} and ${max}`,
        received: val,
        correctedTo: fallback,
      });
    }
    return fallback;
  }
  if (val < min) {
    issues.push({
      field,
      message: `${field} (${val}) was below minimum ${min}`,
      received: val,
      correctedTo: min,
    });
    return min;
  }
  if (val > max) {
    issues.push({
      field,
      message: `${field} (${val}) exceeded maximum ${max}`,
      received: val,
      correctedTo: max,
    });
    return max;
  }
  return val;
}

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

/**
 * Validates and sanitizes an untrusted settings object or partial update.
 */
export function validateSettings(
  input: unknown,
  base: SnapSettings = DEFAULT_SETTINGS,
): SettingsValidationResult {
  const issues: ValidationIssue[] = [];
  if (!input || typeof input !== "object") {
    issues.push({
      field: "root",
      message: "Settings input must be an object",
      received: input,
      correctedTo: base,
    });
    return { valid: false, issues, sanitized: structuredClone(base) };
  }

  const raw = input as Record<string, unknown>;
  const rawGesture =
    raw.gesture && typeof raw.gesture === "object"
      ? (raw.gesture as Record<string, unknown>)
      : {};
  const rawShortcuts =
    raw.shortcuts && typeof raw.shortcuts === "object"
      ? (raw.shortcuts as Record<string, unknown>)
      : {};

  const enabled =
    typeof raw.enabled === "boolean" ? raw.enabled : base.enabled;
  if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") {
    issues.push({
      field: "enabled",
      message: "enabled must be a boolean",
      received: raw.enabled,
      correctedTo: enabled,
    });
  }

  const sensitivityInput =
    raw.sensitivity !== undefined
      ? raw.sensitivity
      : rawGesture.sensitivity !== undefined
        ? rawGesture.sensitivity
        : base.sensitivity;

  const sensitivity = Math.round(
    clampNumber(
      sensitivityInput,
      0,
      100,
      base.sensitivity,
      "sensitivity",
      issues,
    ),
  );

  const duration = Number(
    clampNumber(raw.duration, 0.5, 4.0, base.duration, "duration", issues).toFixed(2),
  );

  const speed = Number(
    clampNumber(raw.speed, 0.5, 2.5, base.speed, "speed", issues).toFixed(2),
  );

  const particleSize = Number(
    clampNumber(
      raw.particleSize,
      0.5,
      3.0,
      base.particleSize,
      "particleSize",
      issues,
    ).toFixed(2),
  );

  const density = Math.round(
    clampNumber(raw.density, 20, 100, base.density, "density", issues),
  );

  const intensity = Math.round(
    clampNumber(raw.intensity, 10, 100, base.intensity, "intensity", issues),
  );

  let direction: Direction = base.direction;
  if (raw.direction !== undefined) {
    if (VALID_DIRECTIONS.includes(raw.direction as Direction)) {
      direction = raw.direction as Direction;
    } else {
      issues.push({
        field: "direction",
        message: `direction must be one of: ${VALID_DIRECTIONS.join(", ")}`,
        received: raw.direction,
        correctedTo: base.direction,
      });
    }
  }

  let effect: EffectType = base.effect;
  if (raw.effect !== undefined) {
    if (VALID_EFFECTS.includes(raw.effect as EffectType)) {
      effect = raw.effect as EffectType;
    } else {
      issues.push({
        field: "effect",
        message: `effect must be one of: ${VALID_EFFECTS.join(", ")}`,
        received: raw.effect,
        correctedTo: base.effect,
      });
    }
  }

  let colorAccent = base.colorAccent;
  if (raw.colorAccent !== undefined) {
    if (typeof raw.colorAccent === "string" && HEX_COLOR_RE.test(raw.colorAccent)) {
      colorAccent = raw.colorAccent.toLowerCase();
    } else {
      issues.push({
        field: "colorAccent",
        message: "colorAccent must be a 6-digit hex color (#RRGGBB)",
        received: raw.colorAccent,
        correctedTo: base.colorAccent,
      });
    }
  }

  let meetingMode: MeetingModeId = base.meetingMode;
  if (raw.meetingMode !== undefined) {
    if (VALID_MEETING_MODES.includes(raw.meetingMode as MeetingModeId)) {
      meetingMode = raw.meetingMode as MeetingModeId;
    } else {
      issues.push({
        field: "meetingMode",
        message: `meetingMode must be one of: ${VALID_MEETING_MODES.join(", ")}`,
        received: raw.meetingMode,
        correctedTo: base.meetingMode,
      });
    }
  }

  const cooldownMs = Math.round(
    clampNumber(
      rawGesture.cooldownMs,
      500,
      10000,
      base.gesture.cooldownMs,
      "gesture.cooldownMs",
      issues,
    ),
  );

  const calibratedCollapseThresholdMm = Number(
    clampNumber(
      rawGesture.calibratedCollapseThresholdMm,
      6,
      25,
      base.gesture.calibratedCollapseThresholdMm,
      "gesture.calibratedCollapseThresholdMm",
      issues,
    ).toFixed(1),
  );

  let actionMapping: GestureAction = base.gesture.actionMapping;
  if (rawGesture.actionMapping !== undefined) {
    if (VALID_GESTURE_ACTIONS.includes(rawGesture.actionMapping as GestureAction)) {
      actionMapping = rawGesture.actionMapping as GestureAction;
    } else {
      issues.push({
        field: "gesture.actionMapping",
        message: `gesture.actionMapping must be one of: ${VALID_GESTURE_ACTIONS.join(", ")}`,
        received: rawGesture.actionMapping,
        correctedTo: base.gesture.actionMapping,
      });
    }
  }

  const sanitized: SnapSettings = {
    enabled,
    sensitivity,
    duration,
    direction,
    sound: typeof raw.sound === "boolean" ? raw.sound : base.sound,
    effect,
    speed,
    particleSize,
    density,
    colorAccent,
    intensity,
    muteOnVanish:
      typeof raw.muteOnVanish === "boolean"
        ? raw.muteOnVanish
        : base.muteOnVanish,
    lowPowerMode:
      typeof raw.lowPowerMode === "boolean"
        ? raw.lowPowerMode
        : base.lowPowerMode,
    meetingMode,
    gesture: {
      enabled:
        typeof rawGesture.enabled === "boolean"
          ? rawGesture.enabled
          : base.gesture.enabled,
      sensitivity,
      cooldownMs,
      requireAudioConfirm:
        typeof rawGesture.requireAudioConfirm === "boolean"
          ? rawGesture.requireAudioConfirm
          : base.gesture.requireAudioConfirm,
      accidentalTriggerProtection:
        typeof rawGesture.accidentalTriggerProtection === "boolean"
          ? rawGesture.accidentalTriggerProtection
          : base.gesture.accidentalTriggerProtection,
      calibratedCollapseThresholdMm,
      actionMapping,
    },
    shortcuts: {
      toggleSnap:
        typeof rawShortcuts.toggleSnap === "string" &&
        rawShortcuts.toggleSnap.trim().length > 0
          ? rawShortcuts.toggleSnap.trim()
          : base.shortcuts.toggleSnap,
      vanishNow:
        typeof rawShortcuts.vanishNow === "string" &&
        rawShortcuts.vanishNow.trim().length > 0
          ? rawShortcuts.vanishNow.trim()
          : base.shortcuts.vanishNow,
      muteOnly:
        typeof rawShortcuts.muteOnly === "string" &&
        rawShortcuts.muteOnly.trim().length > 0
          ? rawShortcuts.muteOnly.trim()
          : base.shortcuts.muteOnly,
      emergencyRestore:
        typeof rawShortcuts.emergencyRestore === "string" &&
        rawShortcuts.emergencyRestore.trim().length > 0
          ? rawShortcuts.emergencyRestore.trim()
          : base.shortcuts.emergencyRestore,
    },
    onboardingCompleted:
      typeof raw.onboardingCompleted === "boolean"
        ? raw.onboardingCompleted
        : base.onboardingCompleted,
    diagnosticLoggingEnabled:
      typeof raw.diagnosticLoggingEnabled === "boolean"
        ? raw.diagnosticLoggingEnabled
        : base.diagnosticLoggingEnabled,
  };

  return {
    valid: issues.length === 0,
    issues,
    sanitized,
  };
}

/**
 * Merges a partial settings patch into current settings and validates.
 */
export function mergeAndValidateSettings(
  current: SnapSettings,
  patch: Partial<SnapSettings>,
): SettingsValidationResult {
  const merged = {
    ...current,
    ...patch,
    gesture: {
      ...current.gesture,
      ...(patch.gesture ?? {}),
      sensitivity:
        patch.sensitivity !== undefined
          ? patch.sensitivity
          : patch.gesture?.sensitivity !== undefined
            ? patch.gesture.sensitivity
            : current.sensitivity,
    },
    shortcuts: {
      ...current.shortcuts,
      ...(patch.shortcuts ?? {}),
    },
  };
  return validateSettings(merged, current);
}

function getChromeStorage(): {
  sync?: {
    get: (keys: string | string[] | null) => Promise<Record<string, unknown>>;
    set: (items: Record<string, unknown>) => Promise<void>;
  };
} | null {
  const g = globalThis as unknown as {
    chrome?: {
      storage?: {
        sync?: {
          get: (keys: string | string[] | null) => Promise<Record<string, unknown>>;
          set: (items: Record<string, unknown>) => Promise<void>;
        };
      };
    };
  };
  return g.chrome?.storage ?? null;
}

export function loadSettingsSync(): SnapSettings {
  try {
    if (typeof localStorage === "undefined") {
      return structuredClone(DEFAULT_SETTINGS);
    }
    const raw = localStorage.getItem(STORAGE_KEYS.SETTINGS);
    if (!raw) return structuredClone(DEFAULT_SETTINGS);
    const parsed = JSON.parse(raw);
    return validateSettings(parsed, DEFAULT_SETTINGS).sanitized;
  } catch {
    return structuredClone(DEFAULT_SETTINGS);
  }
}

export async function loadSettings(): Promise<SnapSettings> {
  const local = loadSettingsSync();
  const chromeStorage = getChromeStorage();
  if (chromeStorage?.sync) {
    try {
      const stored = await chromeStorage.sync.get(null);
      if (stored && Object.keys(stored).length > 0) {
        const payload = stored[STORAGE_KEYS.SETTINGS] ?? stored;
        const validated = validateSettings(payload, local).sanitized;
        saveSettingsSync(validated);
        return validated;
      }
    } catch {
      // Fallback to localStorage
    }
  }
  return local;
}

export function saveSettingsSync(settings: SnapSettings): SnapSettings {
  const { sanitized } = validateSettings(settings, DEFAULT_SETTINGS);
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(STORAGE_KEYS.SETTINGS, JSON.stringify(sanitized));
    }
  } catch {
    // Ignore quota errors in restricted contexts
  }
  broadcastSyncEvent("SETTINGS_UPDATED", sanitized);
  return sanitized;
}

export async function saveSettings(settings: SnapSettings): Promise<SnapSettings> {
  const sanitized = saveSettingsSync(settings);
  const chromeStorage = getChromeStorage();
  if (chromeStorage?.sync) {
    try {
      await chromeStorage.sync.set({
        enabled: sanitized.enabled,
        sensitivity: sanitized.sensitivity,
        duration: sanitized.duration,
        direction: sanitized.direction,
        sound: sanitized.sound,
        effect: sanitized.effect,
        speed: sanitized.speed,
        particleSize: sanitized.particleSize,
        density: sanitized.density,
        colorAccent: sanitized.colorAccent,
        intensity: sanitized.intensity,
        muteOnVanish: sanitized.muteOnVanish,
        lowPowerMode: sanitized.lowPowerMode,
        meetingMode: sanitized.meetingMode,
        [STORAGE_KEYS.SETTINGS]: sanitized,
      });
    } catch {
      // Fallback remains in localStorage
    }
  }
  return sanitized;
}

export function loadPresets(): EffectPreset[] {
  try {
    if (typeof localStorage === "undefined") {
      return structuredClone(BUILT_IN_PRESETS);
    }
    const raw = localStorage.getItem(STORAGE_KEYS.PRESETS);
    if (!raw) return structuredClone(BUILT_IN_PRESETS);
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return structuredClone(BUILT_IN_PRESETS);

    const customPresets = parsed.filter(
      (p): p is EffectPreset =>
        Boolean(p && typeof p === "object" && typeof p.id === "string" && !p.isBuiltIn),
    );
    return [...structuredClone(BUILT_IN_PRESETS), ...customPresets];
  } catch {
    return structuredClone(BUILT_IN_PRESETS);
  }
}

export function saveCustomPresets(presets: EffectPreset[]): EffectPreset[] {
  const customOnly = presets.filter((p) => !p.isBuiltIn);
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(STORAGE_KEYS.PRESETS, JSON.stringify(customOnly));
    }
  } catch {
    // Ignore storage error
  }
  const all = [...structuredClone(BUILT_IN_PRESETS), ...customOnly];
  broadcastSyncEvent("PRESETS_UPDATED", all);
  return all;
}

export function createPresetFromSettings(
  name: string,
  description: string,
  settings: SnapSettings,
): EffectPreset[] {
  const trimmedName = name.trim() || "Custom Effect Preset";
  const now = new Date().toISOString();
  const preset: EffectPreset = {
    id: `preset-custom-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    name: trimmedName,
    description: description.trim() || "User-configured custom effect preset.",
    isBuiltIn: false,
    createdAt: now,
    updatedAt: now,
    config: {
      effect: settings.effect,
      direction: settings.direction,
      duration: settings.duration,
      speed: settings.speed,
      particleSize: settings.particleSize,
      density: settings.density,
      colorAccent: settings.colorAccent,
      intensity: settings.intensity,
      sound: settings.sound,
      lowPowerMode: settings.lowPowerMode,
    },
  };
  const current = loadPresets();
  return saveCustomPresets([...current, preset]);
}

export function renamePreset(id: string, newName: string, newDescription?: string): EffectPreset[] {
  const trimmed = newName.trim();
  if (!trimmed) return loadPresets();
  const current = loadPresets();
  const updated = current.map((p) => {
    if (p.id !== id || p.isBuiltIn) return p;
    return {
      ...p,
      name: trimmed,
      description: newDescription !== undefined ? newDescription.trim() : p.description,
      updatedAt: new Date().toISOString(),
    };
  });
  return saveCustomPresets(updated);
}

export function duplicatePreset(id: string): EffectPreset[] {
  const current = loadPresets();
  const source = current.find((p) => p.id === id);
  if (!source) return current;
  const now = new Date().toISOString();
  const copy: EffectPreset = {
    ...structuredClone(source),
    id: `preset-custom-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    name: `${source.name} (Copy)`,
    isBuiltIn: false,
    createdAt: now,
    updatedAt: now,
  };
  return saveCustomPresets([...current, copy]);
}

export function deletePreset(id: string): EffectPreset[] {
  const current = loadPresets();
  const filtered = current.filter((p) => p.isBuiltIn || p.id !== id);
  return saveCustomPresets(filtered);
}

export function broadcastSyncEvent(type: string, payload: unknown) {
  try {
    if (typeof BroadcastChannel !== "undefined") {
      const ch = new BroadcastChannel("snap_vanish_channel");
      ch.postMessage({ type, payload, timestamp: Date.now() });
      ch.close();
    }
  } catch {
    // BroadcastChannel unavailable in some environments
  }
}
