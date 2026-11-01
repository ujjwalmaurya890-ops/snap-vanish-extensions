import {
  CURRENT_SETTINGS_SCHEMA_VERSION,
  type BackgroundMode,
  type DetectionMode,
  type Direction,
  type EffectPreset,
  type EffectType,
  type GestureAction,
  type HudPosition,
  type MeetingModeId,
  type PerformanceProfile,
  type SettingsValidationResult,
  type SnapSettings,
  type ValidationIssue,
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
  "cinematic-disintegration",
  "fine-particles",
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

export const VALID_DETECTION_MODES: readonly DetectionMode[] = [
  "beginner",
  "balanced",
  "precision",
  "custom",
] as const;

export const VALID_GESTURE_ACTIONS: readonly GestureAction[] = [
  "toggle-vanish",
  "vanish-only",
  "restore-only",
  "mute-only",
] as const;

export const VALID_BACKGROUND_MODES: readonly BackgroundMode[] = [
  "captured-plate",
  "temporal-plate",
  "ai-segmentation",
  "studio-fallback",
] as const;

export const VALID_PERFORMANCE_PROFILES: readonly PerformanceProfile[] = [
  "balanced",
  "high-quality",
  "low-power",
] as const;

export const VALID_HUD_POSITIONS: readonly HudPosition[] = [
  "bottom-right",
  "bottom-left",
  "top-right",
] as const;

export const VALID_RESOLUTIONS = [
  "1280x720",
  "640x360",
  "1920x1080",
] as const;

export interface DetectionProfileDefinition {
  id: Exclude<DetectionMode, "custom">;
  name: string;
  tagline: string;
  sensitivity: number;
  minHandConfidence: number;
  landmarkSmoothing: number;
  calibratedCollapseThresholdMm: number;
  cooldownMs: number;
}

export const DETECTION_MODE_PROFILES: Record<
  Exclude<DetectionMode, "custom">,
  DetectionProfileDefinition
> = {
  beginner: {
    id: "beginner",
    name: "Beginner",
    tagline: "Forgiving snap geometry for relaxed hand posture",
    sensitivity: 38,
    minHandConfidence: 0.48,
    landmarkSmoothing: 0.45,
    calibratedCollapseThresholdMm: 16,
    cooldownMs: 2200,
  },
  balanced: {
    id: "balanced",
    name: "Balanced",
    tagline: "Recommended everyday balance of responsiveness and stability",
    sensitivity: 62,
    minHandConfidence: 0.62,
    landmarkSmoothing: 0.35,
    calibratedCollapseThresholdMm: 12,
    cooldownMs: 2000,
  },
  precision: {
    id: "precision",
    name: "Precision",
    tagline: "High confidence requirement for zero accidental meeting triggers",
    sensitivity: 84,
    minHandConfidence: 0.76,
    landmarkSmoothing: 0.25,
    calibratedCollapseThresholdMm: 9.5,
    cooldownMs: 2600,
  },
};

export const DEFAULT_SETTINGS: SnapSettings = {
  schemaVersion: CURRENT_SETTINGS_SCHEMA_VERSION,
  enabled: true,
  autoStartOnCall: true,
  showCallHud: true,
  hudPosition: "bottom-right",
  meetingMode: "creative",
  onboardingCompleted: false,
  sensitivity: 62,
  gesture: {
    enabled: true,
    mode: "balanced",
    sensitivity: 62,
    minHandConfidence: 0.62,
    landmarkSmoothing: 0.35,
    inferenceFpsLimit: 24,
    cooldownMs: 2000,
    requireAudioConfirm: true,
    accidentalTriggerProtection: true,
    calibratedCollapseThresholdMm: 12,
    actionMapping: "toggle-vanish",
  },
  camera: {
    preferredDeviceId: "",
    targetResolution: "1280x720",
    mirrorPreview: true,
    backgroundMode: "temporal-plate",
    autoRestoreOnLeave: true,
  },
  sound: true,
  muteOnVanish: true,
  audio: {
    enabled: true,
    preferredDeviceId: "",
    sensitivityDb: 12,
    confirmWindowMs: 220,
    allowStandaloneAudioTrigger: false,
  },
  effect: "dust",
  direction: "right",
  duration: 1.8,
  speed: 1.0,
  particleSize: 1.0,
  density: 80,
  colorAccent: "#d2451e",
  intensity: 85,
  motionSmoothness: 70,
  lowPowerMode: false,
  performanceProfile: "balanced",
  pauseWhenHidden: true,
  maxParticles: 22000,
  diagnosticLoggingEnabled: true,
  recordActivityHistory: true,
  strictLocalOnly: true,
  shortcuts: {
    toggleSnap: "Alt+Shift+S",
    vanishNow: "Alt+Shift+D",
    restoreCamera: "Alt+Shift+R",
    toggleDetection: "Alt+Shift+G",
    openSettings: "Alt+Shift+O",
    muteOnly: "Alt+Shift+M",
    emergencyRestore: "Alt+Shift+R",
  },
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
    tagline: "Restrained gentle fade with precision false-trigger protection",
    description:
      "Uses a clean 1.2s optical fade-out, silent operation, precision sensitivity (78), and a 2.5s cooldown suited for executive meetings.",
    settingsPatch: {
      effect: "fade-out",
      duration: 1.2,
      speed: 1.0,
      particleSize: 1.0,
      density: 55,
      colorAccent: "#d97706",
      intensity: 65,
      motionSmoothness: 88,
      sound: false,
      lowPowerMode: false,
      performanceProfile: "balanced",
      sensitivity: 78,
      meetingMode: "professional",
      gesture: {
        ...DEFAULT_SETTINGS.gesture,
        mode: "precision",
        sensitivity: 78,
        minHandConfidence: 0.72,
        cooldownMs: 2500,
        requireAudioConfirm: true,
        accidentalTriggerProtection: true,
      },
    },
  },
  creative: {
    id: "creative",
    name: "Creative",
    tagline: "Signature warm ember dust disintegration",
    description:
      "Full 22k-particle warm ember dispersion with acoustic snap confirmation, 1.8s duration, and balanced hand+audio sensitivity (62).",
    settingsPatch: {
      effect: "dust",
      duration: 1.8,
      direction: "right",
      speed: 1.0,
      particleSize: 1.0,
      density: 85,
      colorAccent: "#d2451e",
      intensity: 88,
      motionSmoothness: 72,
      sound: true,
      lowPowerMode: false,
      performanceProfile: "balanced",
      sensitivity: 62,
      meetingMode: "creative",
      gesture: {
        ...DEFAULT_SETTINGS.gesture,
        mode: "balanced",
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
      "0.8s rapid optical fade with zero particle scatter, silent operation, and strict gesture confirmation.",
    settingsPatch: {
      effect: "fade-out",
      duration: 0.8,
      speed: 1.4,
      particleSize: 0.8,
      density: 35,
      colorAccent: "#a1a1aa",
      intensity: 45,
      motionSmoothness: 90,
      sound: false,
      lowPowerMode: false,
      performanceProfile: "balanced",
      sensitivity: 72,
      meetingMode: "minimal",
      gesture: {
        ...DEFAULT_SETTINGS.gesture,
        mode: "precision",
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
    tagline: "Battery-friendly profile for ordinary Windows laptops",
    description:
      "Caps particle density at 30%, reduces CV inference to 15 Hz, disables secondary motion smears, and minimizes integrated GPU load.",
    settingsPatch: {
      effect: "pixel-dissolve",
      duration: 1.1,
      speed: 1.1,
      particleSize: 1.4,
      density: 30,
      colorAccent: "#ea580c",
      intensity: 55,
      motionSmoothness: 60,
      sound: false,
      lowPowerMode: true,
      performanceProfile: "low-power",
      maxParticles: 8000,
      sensitivity: 68,
      meetingMode: "low-power",
      gesture: {
        ...DEFAULT_SETTINGS.gesture,
        mode: "balanced",
        sensitivity: 68,
        inferenceFpsLimit: 15,
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
    name: "Classic Dust",
    description:
      "Signature curl-noise warm ember dust drifting naturally across the background plate.",
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
      motionSmoothness: 70,
      sound: true,
      lowPowerMode: false,
    },
  },
  {
    id: "preset-cinematic-disintegration",
    name: "Cinematic Disintegration",
    description:
      "Layered rotating polygon fragments and fine glowing ash with multi-plane depth parallax.",
    isBuiltIn: true,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    config: {
      effect: "cinematic-disintegration",
      direction: "right",
      duration: 2.3,
      speed: 0.95,
      particleSize: 1.25,
      density: 88,
      colorAccent: "#e0532c",
      intensity: 92,
      motionSmoothness: 82,
      sound: true,
      lowPowerMode: false,
    },
  },
  {
    id: "preset-fine-particles",
    name: "Fine Particles",
    description:
      "Ultra-fine micro-ash dispersion rising softly with subtle thermal turbulence.",
    isBuiltIn: true,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    config: {
      effect: "fine-particles",
      direction: "up",
      duration: 2.0,
      speed: 1.05,
      particleSize: 0.7,
      density: 95,
      colorAccent: "#f59e0b",
      intensity: 78,
      motionSmoothness: 86,
      sound: true,
      lowPowerMode: false,
    },
  },
  {
    id: "preset-photon-burst",
    name: "Energy Burst",
    description:
      "Warm photonic core impulse that expands outward into luminous golden motes.",
    isBuiltIn: true,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    config: {
      effect: "light-burst",
      direction: "toward",
      duration: 1.5,
      speed: 1.2,
      particleSize: 1.3,
      density: 80,
      colorAccent: "#f97316",
      intensity: 90,
      motionSmoothness: 75,
      sound: true,
      lowPowerMode: false,
    },
  },
  {
    id: "preset-exec-fade",
    name: "Gentle Fade",
    description:
      "Smooth optical cross-dissolve to the clean room background for understated exits.",
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
      colorAccent: "#a1a1aa",
      intensity: 55,
      motionSmoothness: 94,
      sound: false,
      lowPowerMode: false,
    },
  },
  {
    id: "preset-reverse-assembly",
    name: "Reverse Assembly",
    description:
      "Converging radial reconstruction trajectory designed for dramatic camera re-entry.",
    isBuiltIn: true,
    reverseMode: true,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    config: {
      effect: "cinematic-disintegration",
      direction: "toward",
      duration: 2.0,
      speed: 1.1,
      particleSize: 1.15,
      density: 85,
      colorAccent: "#fb923c",
      intensity: 88,
      motionSmoothness: 88,
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
      colorAccent: "#ea580c",
      intensity: 80,
      motionSmoothness: 65,
      sound: true,
      lowPowerMode: false,
    },
  },
  {
    id: "preset-cyber-glitch",
    name: "Signal Loss Glitch",
    description: "Scanline displacement and digital block deconstruction.",
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
      colorAccent: "#f97316",
      intensity: 85,
      motionSmoothness: 55,
      sound: true,
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
 * Migrates older v1.x or early unversioned settings payloads to schemaVersion 2.
 */
export function migrateSettingsPayload(raw: Record<string, unknown>): {
  payload: Record<string, unknown>;
  migratedFrom?: number;
} {
  const incomingVersion =
    typeof raw.schemaVersion === "number" ? raw.schemaVersion : 1;
  if (incomingVersion >= CURRENT_SETTINGS_SCHEMA_VERSION) {
    return { payload: raw };
  }

  const migrated: Record<string, unknown> = {
    ...raw,
    schemaVersion: CURRENT_SETTINGS_SCHEMA_VERSION,
  };

  // Migrate flat v1 cooldownMs into gesture.cooldownMs if needed
  if (
    typeof raw.cooldownMs === "number" &&
    (!raw.gesture || typeof raw.gesture !== "object")
  ) {
    migrated.gesture = { cooldownMs: raw.cooldownMs };
  }

  // Migrate legacy lowPowerMode boolean into performanceProfile
  if (raw.lowPowerMode === true && raw.performanceProfile === undefined) {
    migrated.performanceProfile = "low-power";
  }

  return { payload: migrated, migratedFrom: incomingVersion };
}

/**
 * Validates and sanitizes an untrusted settings object or partial update.
 */
export function validateSettings(
  input: unknown,
  base: SnapSettings = DEFAULT_SETTINGS,
): SettingsValidationResult {
  const issues: ValidationIssue[] = [];
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    issues.push({
      field: "root",
      message: "Settings input must be a plain object",
      received: input,
      correctedTo: base,
    });
    return { valid: false, issues, sanitized: structuredClone(base) };
  }

  const { payload: raw, migratedFrom } = migrateSettingsPayload(
    input as Record<string, unknown>,
  );

  const rawGesture =
    raw.gesture && typeof raw.gesture === "object" && !Array.isArray(raw.gesture)
      ? (raw.gesture as Record<string, unknown>)
      : {};
  const rawCamera =
    raw.camera && typeof raw.camera === "object" && !Array.isArray(raw.camera)
      ? (raw.camera as Record<string, unknown>)
      : {};
  const rawAudio =
    raw.audio && typeof raw.audio === "object" && !Array.isArray(raw.audio)
      ? (raw.audio as Record<string, unknown>)
      : {};
  const rawShortcuts =
    raw.shortcuts &&
    typeof raw.shortcuts === "object" &&
    !Array.isArray(raw.shortcuts)
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
    clampNumber(
      raw.duration,
      0.5,
      4.0,
      base.duration,
      "duration",
      issues,
    ).toFixed(2),
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

  const motionSmoothness = Math.round(
    clampNumber(
      raw.motionSmoothness,
      0,
      100,
      base.motionSmoothness,
      "motionSmoothness",
      issues,
    ),
  );

  const maxParticles = Math.round(
    clampNumber(
      raw.maxParticles,
      4000,
      28000,
      base.maxParticles,
      "maxParticles",
      issues,
    ),
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
    if (
      typeof raw.colorAccent === "string" &&
      HEX_COLOR_RE.test(raw.colorAccent)
    ) {
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

  let hudPosition: HudPosition = base.hudPosition;
  if (
    raw.hudPosition !== undefined &&
    VALID_HUD_POSITIONS.includes(raw.hudPosition as HudPosition)
  ) {
    hudPosition = raw.hudPosition as HudPosition;
  }

  let detectionMode: DetectionMode = base.gesture.mode;
  if (rawGesture.mode !== undefined) {
    if (VALID_DETECTION_MODES.includes(rawGesture.mode as DetectionMode)) {
      detectionMode = rawGesture.mode as DetectionMode;
    } else {
      issues.push({
        field: "gesture.mode",
        message: `gesture.mode must be one of: ${VALID_DETECTION_MODES.join(", ")}`,
        received: rawGesture.mode,
        correctedTo: base.gesture.mode,
      });
    }
  }

  const minHandConfidence = Number(
    clampNumber(
      rawGesture.minHandConfidence,
      0.3,
      0.95,
      base.gesture.minHandConfidence,
      "gesture.minHandConfidence",
      issues,
    ).toFixed(2),
  );

  const landmarkSmoothing = Number(
    clampNumber(
      rawGesture.landmarkSmoothing,
      0,
      0.85,
      base.gesture.landmarkSmoothing,
      "gesture.landmarkSmoothing",
      issues,
    ).toFixed(2),
  );

  const inferenceFpsLimit = Math.round(
    clampNumber(
      rawGesture.inferenceFpsLimit,
      10,
      30,
      base.gesture.inferenceFpsLimit,
      "gesture.inferenceFpsLimit",
      issues,
    ),
  );

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

  let backgroundMode: BackgroundMode = base.camera.backgroundMode;
  if (
    rawCamera.backgroundMode !== undefined &&
    VALID_BACKGROUND_MODES.includes(rawCamera.backgroundMode as BackgroundMode)
  ) {
    backgroundMode = rawCamera.backgroundMode as BackgroundMode;
  }

  let targetResolution: SnapSettings["camera"]["targetResolution"] =
    base.camera.targetResolution;
  if (
    rawCamera.targetResolution !== undefined &&
    (VALID_RESOLUTIONS as readonly string[]).includes(
      String(rawCamera.targetResolution),
    )
  ) {
    targetResolution =
      rawCamera.targetResolution as SnapSettings["camera"]["targetResolution"];
  }

  let performanceProfile: PerformanceProfile = base.performanceProfile;
  if (
    raw.performanceProfile !== undefined &&
    VALID_PERFORMANCE_PROFILES.includes(
      raw.performanceProfile as PerformanceProfile,
    )
  ) {
    performanceProfile = raw.performanceProfile as PerformanceProfile;
  }

  const audioSensitivityDb = Math.round(
    clampNumber(
      rawAudio.sensitivityDb,
      6,
      28,
      base.audio.sensitivityDb,
      "audio.sensitivityDb",
      issues,
    ),
  );

  const confirmWindowMs = Math.round(
    clampNumber(
      rawAudio.confirmWindowMs,
      100,
      500,
      base.audio.confirmWindowMs,
      "audio.confirmWindowMs",
      issues,
    ),
  );

  const pickShortcut = (val: unknown, fallback: string) =>
    typeof val === "string" && val.trim().length > 0 && val.trim().length <= 40
      ? val.trim()
      : fallback;

  const requireAudioConfirm =
    typeof rawGesture.requireAudioConfirm === "boolean"
      ? rawGesture.requireAudioConfirm
      : base.gesture.requireAudioConfirm;

  const sanitized: SnapSettings = {
    schemaVersion: CURRENT_SETTINGS_SCHEMA_VERSION,
    enabled,
    autoStartOnCall:
      typeof raw.autoStartOnCall === "boolean"
        ? raw.autoStartOnCall
        : base.autoStartOnCall,
    showCallHud:
      typeof raw.showCallHud === "boolean" ? raw.showCallHud : base.showCallHud,
    hudPosition,
    meetingMode,
    onboardingCompleted:
      typeof raw.onboardingCompleted === "boolean"
        ? raw.onboardingCompleted
        : base.onboardingCompleted,
    sensitivity,
    gesture: {
      enabled:
        typeof rawGesture.enabled === "boolean"
          ? rawGesture.enabled
          : base.gesture.enabled,
      mode: detectionMode,
      sensitivity,
      minHandConfidence,
      landmarkSmoothing,
      inferenceFpsLimit,
      cooldownMs,
      requireAudioConfirm,
      accidentalTriggerProtection:
        typeof rawGesture.accidentalTriggerProtection === "boolean"
          ? rawGesture.accidentalTriggerProtection
          : base.gesture.accidentalTriggerProtection,
      calibratedCollapseThresholdMm,
      actionMapping,
    },
    camera: {
      preferredDeviceId:
        typeof rawCamera.preferredDeviceId === "string"
          ? rawCamera.preferredDeviceId.slice(0, 128)
          : base.camera.preferredDeviceId,
      targetResolution,
      mirrorPreview:
        typeof rawCamera.mirrorPreview === "boolean"
          ? rawCamera.mirrorPreview
          : base.camera.mirrorPreview,
      backgroundMode,
      autoRestoreOnLeave:
        typeof rawCamera.autoRestoreOnLeave === "boolean"
          ? rawCamera.autoRestoreOnLeave
          : base.camera.autoRestoreOnLeave,
    },
    sound: typeof raw.sound === "boolean" ? raw.sound : base.sound,
    muteOnVanish:
      typeof raw.muteOnVanish === "boolean"
        ? raw.muteOnVanish
        : base.muteOnVanish,
    audio: {
      enabled:
        typeof rawAudio.enabled === "boolean"
          ? rawAudio.enabled
          : base.audio.enabled,
      preferredDeviceId:
        typeof rawAudio.preferredDeviceId === "string"
          ? rawAudio.preferredDeviceId.slice(0, 128)
          : base.audio.preferredDeviceId,
      sensitivityDb: audioSensitivityDb,
      confirmWindowMs,
      allowStandaloneAudioTrigger:
        typeof rawAudio.allowStandaloneAudioTrigger === "boolean"
          ? rawAudio.allowStandaloneAudioTrigger
          : base.audio.allowStandaloneAudioTrigger,
    },
    effect,
    direction,
    duration,
    speed,
    particleSize,
    density,
    colorAccent,
    intensity,
    motionSmoothness,
    lowPowerMode:
      typeof raw.lowPowerMode === "boolean"
        ? raw.lowPowerMode
        : base.lowPowerMode,
    performanceProfile,
    pauseWhenHidden:
      typeof raw.pauseWhenHidden === "boolean"
        ? raw.pauseWhenHidden
        : base.pauseWhenHidden,
    maxParticles,
    diagnosticLoggingEnabled:
      typeof raw.diagnosticLoggingEnabled === "boolean"
        ? raw.diagnosticLoggingEnabled
        : base.diagnosticLoggingEnabled,
    recordActivityHistory:
      typeof raw.recordActivityHistory === "boolean"
        ? raw.recordActivityHistory
        : base.recordActivityHistory,
    strictLocalOnly:
      typeof raw.strictLocalOnly === "boolean"
        ? raw.strictLocalOnly
        : base.strictLocalOnly,
    shortcuts: {
      toggleSnap: pickShortcut(
        rawShortcuts.toggleSnap,
        base.shortcuts.toggleSnap,
      ),
      vanishNow: pickShortcut(rawShortcuts.vanishNow, base.shortcuts.vanishNow),
      restoreCamera: pickShortcut(
        rawShortcuts.restoreCamera,
        base.shortcuts.restoreCamera,
      ),
      toggleDetection: pickShortcut(
        rawShortcuts.toggleDetection,
        base.shortcuts.toggleDetection,
      ),
      openSettings: pickShortcut(
        rawShortcuts.openSettings,
        base.shortcuts.openSettings,
      ),
      muteOnly: pickShortcut(rawShortcuts.muteOnly, base.shortcuts.muteOnly),
      emergencyRestore: pickShortcut(
        rawShortcuts.emergencyRestore,
        base.shortcuts.emergencyRestore,
      ),
    },
  };

  return {
    valid: issues.length === 0,
    issues,
    sanitized,
    migratedFromVersion: migratedFrom,
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
    camera: {
      ...current.camera,
      ...(patch.camera ?? {}),
    },
    audio: {
      ...current.audio,
      ...(patch.audio ?? {}),
    },
    shortcuts: {
      ...current.shortcuts,
      ...(patch.shortcuts ?? {}),
    },
  };
  return validateSettings(merged, current);
}

interface ChromeStorageArea {
  get: (keys: string | string[] | null) => Promise<Record<string, unknown>>;
  set: (items: Record<string, unknown>) => Promise<void>;
  remove?: (keys: string | string[]) => Promise<void>;
}

function getChromeStorage(): {
  sync?: ChromeStorageArea;
  local?: ChromeStorageArea;
} | null {
  const g = globalThis as unknown as {
    chrome?: {
      storage?: {
        sync?: ChromeStorageArea;
        local?: ChromeStorageArea;
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

export async function saveSettings(
  settings: SnapSettings,
): Promise<SnapSettings> {
  const sanitized = saveSettingsSync(settings);
  const chromeStorage = getChromeStorage();
  if (chromeStorage?.sync) {
    try {
      // Compact preferences stored in chrome.storage.sync (< 2KB, well under 8KB item quota)
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
        motionSmoothness: sanitized.motionSmoothness,
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
        Boolean(
          p &&
            typeof p === "object" &&
            typeof p.id === "string" &&
            typeof p.name === "string" &&
            p.config &&
            typeof p.config === "object" &&
            !p.isBuiltIn,
        ),
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
  const chromeStorage = getChromeStorage();
  if (chromeStorage?.local) {
    void chromeStorage.local
      .set({ [STORAGE_KEYS.PRESETS]: customOnly })
      .catch(() => {});
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
      motionSmoothness: settings.motionSmoothness,
      sound: settings.sound,
      lowPowerMode: settings.lowPowerMode,
    },
  };
  const current = loadPresets();
  return saveCustomPresets([...current, preset]);
}

export function renamePreset(
  id: string,
  newName: string,
  newDescription?: string,
): EffectPreset[] {
  const trimmed = newName.trim();
  if (!trimmed) return loadPresets();
  const current = loadPresets();
  const updated = current.map((p) => {
    if (p.id !== id || p.isBuiltIn) return p;
    return {
      ...p,
      name: trimmed,
      description:
        newDescription !== undefined ? newDescription.trim() : p.description,
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

export interface ExportedConfigurationBundle {
  product: "snap-vanish";
  schemaVersion: number;
  exportedAt: string;
  settings: SnapSettings;
  customPresets: EffectPreset[];
}

export function exportSettingsJson(
  settings: SnapSettings = loadSettingsSync(),
  presets: EffectPreset[] = loadPresets(),
): string {
  const bundle: ExportedConfigurationBundle = {
    product: "snap-vanish",
    schemaVersion: CURRENT_SETTINGS_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    settings: validateSettings(settings).sanitized,
    customPresets: presets.filter((p) => !p.isBuiltIn),
  };
  return JSON.stringify(bundle, null, 2);
}

export function importSettingsJson(rawJson: string): {
  ok: boolean;
  error?: string;
  settings: SnapSettings;
  presets: EffectPreset[];
  issues: ValidationIssue[];
} {
  try {
    const parsed = JSON.parse(rawJson);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {
        ok: false,
        error: "Imported JSON must be a configuration object.",
        settings: loadSettingsSync(),
        presets: loadPresets(),
        issues: [],
      };
    }

    const candidateSettings =
      (parsed as Record<string, unknown>).settings ?? parsed;
    const validation = validateSettings(candidateSettings, DEFAULT_SETTINGS);
    const savedSettings = saveSettingsSync(validation.sanitized);

    let updatedPresets = loadPresets();
    const rawCustomPresets = (parsed as Record<string, unknown>).customPresets;
    if (Array.isArray(rawCustomPresets)) {
      const sanitizedCustom: EffectPreset[] = [];
      for (const item of rawCustomPresets) {
        if (
          item &&
          typeof item === "object" &&
          typeof (item as Record<string, unknown>).name === "string" &&
          (item as Record<string, unknown>).config &&
          typeof (item as Record<string, unknown>).config === "object"
        ) {
          const itemRec = item as Record<string, unknown>;
          const cfgCheck = validateSettings(
            itemRec.config,
            DEFAULT_SETTINGS,
          ).sanitized;
          sanitizedCustom.push({
            id:
              typeof itemRec.id === "string" && itemRec.id.startsWith("preset-")
                ? itemRec.id
                : `preset-import-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            name: String(itemRec.name).trim().slice(0, 64) || "Imported Preset",
            description:
              typeof itemRec.description === "string"
                ? itemRec.description.trim().slice(0, 200)
                : "Imported custom preset.",
            isBuiltIn: false,
            createdAt:
              typeof itemRec.createdAt === "string"
                ? itemRec.createdAt
                : new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            config: {
              effect: cfgCheck.effect,
              direction: cfgCheck.direction,
              duration: cfgCheck.duration,
              speed: cfgCheck.speed,
              particleSize: cfgCheck.particleSize,
              density: cfgCheck.density,
              colorAccent: cfgCheck.colorAccent,
              intensity: cfgCheck.intensity,
              motionSmoothness: cfgCheck.motionSmoothness,
              sound: cfgCheck.sound,
              lowPowerMode: cfgCheck.lowPowerMode,
            },
          });
        }
      }
      updatedPresets = saveCustomPresets(sanitizedCustom);
    }

    return {
      ok: true,
      settings: savedSettings,
      presets: updatedPresets,
      issues: validation.issues,
    };
  } catch (err) {
    return {
      ok: false,
      error:
        err instanceof Error
          ? `Corrupted or invalid JSON file: ${err.message}`
          : "Corrupted or invalid JSON configuration.",
      settings: loadSettingsSync(),
      presets: loadPresets(),
      issues: [],
    };
  }
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
