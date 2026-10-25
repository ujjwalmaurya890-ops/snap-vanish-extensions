export type Direction = "left" | "right" | "up" | "down" | "toward";

export type EffectType =
  | "dust"
  | "pixel-dissolve"
  | "digital-glitch"
  | "fade-out"
  | "light-burst";

/**
 * Legacy status used by SnapStage / VanishPopup in baseline code.
 * Preserved for backward compatibility alongside EngineState.
 */
export type SnapStatus = "idle" | "vanishing" | "gone" | "returning";

/**
 * Canonical core engine state machine states.
 */
export type EngineState = "live" | "vanishing" | "vanished" | "restoring" | "error";

/**
 * Explicitly tracks how the video feed is being handled so we never fabricate
 * WebRTC stream replacement when running in overlay or preview mode.
 */
export type InterceptionMode =
  | "webrtc-sender"
  | "dom-overlay"
  | "preview-only"
  | "inactive";

export type MeetingModeId =
  | "professional"
  | "creative"
  | "minimal"
  | "low-power"
  | "custom";

export type GestureAction =
  | "toggle-vanish"
  | "vanish-only"
  | "restore-only"
  | "mute-only";

export interface GestureSettings {
  enabled: boolean;
  sensitivity: number; // 0 - 100
  cooldownMs: number; // 500 - 10000
  requireAudioConfirm: boolean;
  accidentalTriggerProtection: boolean;
  calibratedCollapseThresholdMm: number; // 6 - 25 (default 12)
  actionMapping: GestureAction;
}

export interface ShortcutSettings {
  toggleSnap: string;
  vanishNow: string;
  muteOnly: string;
  emergencyRestore: string;
}

export interface SnapSettings {
  enabled: boolean;
  sensitivity: number; // 0 - 100 (synchronized with gesture.sensitivity)
  duration: number; // 0.5 - 4.0 seconds
  direction: Direction;
  sound: boolean;
  effect: EffectType;
  speed: number; // 0.5 - 2.5 multiplier
  particleSize: number; // 0.5 - 3.0 multiplier
  density: number; // 20 - 100 percentage
  colorAccent: string; // Hex color e.g. #d2451e
  intensity: number; // 10 - 100 percentage
  muteOnVanish: boolean;
  lowPowerMode: boolean;
  meetingMode: MeetingModeId;
  gesture: GestureSettings;
  shortcuts: ShortcutSettings;
  onboardingCompleted: boolean;
  diagnosticLoggingEnabled: boolean;
}

export type EffectConfig = Pick<
  SnapSettings,
  | "effect"
  | "direction"
  | "duration"
  | "speed"
  | "particleSize"
  | "density"
  | "colorAccent"
  | "intensity"
  | "sound"
  | "lowPowerMode"
>;

export interface EffectPreset {
  id: string;
  name: string;
  description: string;
  isBuiltIn?: boolean;
  createdAt: string;
  updatedAt: string;
  config: EffectConfig;
}

export interface ValidationIssue {
  field: string;
  message: string;
  received: unknown;
  correctedTo: unknown;
}

export interface SettingsValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
  sanitized: SnapSettings;
}

export type AnalyticsEventType =
  | "vanish_activated"
  | "restore_completed"
  | "emergency_restore"
  | "trigger_failed"
  | "trigger_blocked_cooldown"
  | "preset_selected"
  | "mode_selected"
  | "calibration_completed";

export interface AnalyticsEvent {
  id: string;
  type: AnalyticsEventType;
  timestamp: string;
  effect?: EffectType;
  presetId?: string;
  modeId?: MeetingModeId;
  source?: "manual" | "gesture" | "shortcut" | "popup" | "dashboard";
  reason?: string;
}

export interface UsageAnalyticsSummary {
  totalActivations: number;
  successfulRestorations: number;
  emergencyRestorations: number;
  failedTriggers: number;
  cooldownBlocks: number;
  effectCounts: Record<EffectType, number>;
  presetCounts: Record<string, number>;
  dailyActivations: Record<string, number>; // YYYY-MM-DD -> count
  events: AnalyticsEvent[];
  lastUpdated: string;
}

export interface DiagnosticLogEntry {
  id: string;
  timestamp: string;
  level: "info" | "warn" | "error";
  code: string;
  message: string;
  details?: string;
}

export interface ResourceCleanupStatus {
  animationFrameActive: boolean;
  mediaTracksActive: number;
  audioContextState: "closed" | "running" | "suspended" | "uninitialized";
  activeListeners: number;
  lastCleanedAt: string | null;
}

export interface DiagnosticSnapshot {
  measuredFps: number | null;
  frameRenderMs: number | null;
  activeParticleCount: number;
  engineState: EngineState;
  interceptionMode: InterceptionMode;
  lowPowerActive: boolean;
  webGL2Supported: boolean;
  mediaDevicesSupported: boolean;
  extensionBridgeConnected: boolean;
  permissions: {
    camera: "granted" | "denied" | "prompt" | "unknown";
    microphone: "granted" | "denied" | "prompt" | "unknown";
  };
  cleanup: ResourceCleanupStatus;
  logs: DiagnosticLogEntry[];
}

export type ExtensionMessageType =
  | "PING"
  | "GET_STATE"
  | "SNAP_NOW"
  | "SNAP_TOGGLE"
  | "SNAP_VANISH_NOW"
  | "EMERGENCY_RESTORE"
  | "MUTE_TOGGLE"
  | "RESET_FRAME"
  | "SETTINGS_CHANGED"
  | "SETTINGS"
  | "STATE"
  | "CALIBRATE_GESTURE"
  | "RUN_DIAGNOSTICS"
  | "CLEAR_LOCAL_DATA"
  | "SYNC_DASHBOARD_STATE";

export interface ExtensionMessage {
  type: ExtensionMessageType;
  payload?: Record<string, unknown>;
  requestId?: string;
}

export interface ExtensionResponse {
  ok: boolean;
  reason?: string;
  host?: string;
  engineState?: EngineState;
  interceptionMode?: InterceptionMode;
  muted?: boolean;
  settings?: Partial<SnapSettings>;
  diagnostics?: Partial<DiagnosticSnapshot>;
  error?: string;
}

export type PlanTier = "free" | "pro";

export interface EntitlementState {
  tier: PlanTier;
  verificationSource: "local-only" | "server-verified" | "unconfigured";
  cloudSyncConfigured: boolean;
  billingConfigured: boolean;
  entitlements: {
    coreVanishRestore: boolean;
    essentialEffects: EffectType[];
    allEffects: EffectType[];
    maxLocalPresets: number;
    cloudPresetSync: boolean;
    advancedAnalyticsExport: boolean;
  };
}

export interface FeedbackSubmission {
  id: string;
  category: "bug" | "feature" | "ux" | "general";
  title: string;
  description: string;
  includeDiagnostics: boolean;
  diagnosticSnapshot?: Partial<DiagnosticSnapshot>;
  createdAt: string;
  status: "recorded-locally" | "submitted-cloud";
}

export interface ChangelogEntry {
  version: string;
  date: string;
  title: string;
  highlights: string[];
  type: "major" | "minor" | "fix";
}

export function engineStateToSnapStatus(state: EngineState): SnapStatus {
  switch (state) {
    case "live":
    case "error":
      return "idle";
    case "vanishing":
      return "vanishing";
    case "vanished":
      return "gone";
    case "restoring":
      return "returning";
  }
}

export function snapStatusToEngineState(status: SnapStatus): EngineState {
  switch (status) {
    case "idle":
      return "live";
    case "vanishing":
      return "vanishing";
    case "gone":
      return "vanished";
    case "returning":
      return "restoring";
  }
}
