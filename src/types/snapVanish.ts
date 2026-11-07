export const CURRENT_SETTINGS_SCHEMA_VERSION = 2;

export type Direction = "left" | "right" | "up" | "down" | "toward";

export type EffectType =
  | "dust"
  | "cinematic-disintegration"
  | "fine-particles"
  | "pixel-dissolve"
  | "digital-glitch"
  | "fade-out"
  | "light-burst";

/**
 * Legacy status used by SnapStage / VanishPopup.
 * Preserved alongside canonical EngineState.
 */
export type SnapStatus = "idle" | "vanishing" | "gone" | "returning";

/**
 * Canonical core engine state machine states.
 */
export type EngineState =
  | "live"
  | "vanishing"
  | "vanished"
  | "restoring"
  | "error";

/**
 * Explicitly tracks how the video feed is being handled so we never fabricate
 * WebRTC stream replacement when running in overlay or preview mode.
 */
export type InterceptionMode =
  | "webrtc-sender"
  | "getusermedia-proxy"
  | "dom-overlay"
  | "preview-only"
  | "inactive";

export type MeetingModeId =
  | "professional"
  | "creative"
  | "minimal"
  | "low-power"
  | "custom";

export type DetectionMode = "beginner" | "balanced" | "precision" | "custom";

/**
 * How a vanish may be triggered (brief §3):
 * - "smart": visual snap gesture + acoustic transient confirmation (default)
 * - "gesture-only": visual snap gesture alone — the microphone is never opened
 * - "manual": no automatic detection at all — popup, HUD, or keyboard shortcut only
 *
 * In every mode, sound alone can never trigger a vanish.
 */
export type DetectionTriggerMode = "smart" | "gesture-only" | "manual";

export type GesturePhase =
  | "no-hand"
  | "hand-detected"
  | "cocked-ready"
  | "snap-collapsed"
  | "awaiting-audio"
  | "confirmed"
  | "cooldown";

export type GestureAction =
  | "toggle-vanish"
  | "vanish-only"
  | "restore-only"
  | "mute-only";

export type BackgroundMode =
  | "captured-plate"
  | "temporal-plate"
  | "ai-segmentation"
  | "studio-fallback";

export type PerformanceProfile = "balanced" | "high-quality" | "low-power";

export type HudPosition = "bottom-right" | "bottom-left" | "top-right";

export interface GestureSettings {
  enabled: boolean;
  /** Trigger policy: smart (gesture+audio) | gesture-only | manual. */
  detectionMode: DetectionTriggerMode;
  mode: DetectionMode;
  sensitivity: number; // 0 - 100
  minHandConfidence: number; // 0.3 - 0.95
  landmarkSmoothing: number; // 0.0 - 0.85
  inferenceFpsLimit: number; // 10 - 30
  cooldownMs: number; // 500 - 10000
  requireAudioConfirm: boolean;
  accidentalTriggerProtection: boolean;
  calibratedCollapseThresholdMm: number; // 6 - 25 (default 12)
  actionMapping: GestureAction;
}

export interface CameraSettings {
  preferredDeviceId: string;
  targetResolution: "1280x720" | "640x360" | "1920x1080";
  mirrorPreview: boolean;
  backgroundMode: BackgroundMode;
  autoRestoreOnLeave: boolean;
}

export interface AudioConfirmationSettings {
  enabled: boolean;
  preferredDeviceId: string;
  sensitivityDb: number; // 6 - 28 dB jump threshold
  confirmWindowMs: number; // 100 - 500 ms
  allowStandaloneAudioTrigger: boolean; // default false: audio confirms, never triggers alone unless opted in
}

export interface ShortcutSettings {
  toggleSnap: string;
  vanishNow: string;
  restoreCamera: string;
  toggleDetection: string;
  openSettings: string;
  muteOnly: string;
  emergencyRestore: string;
}

export interface SnapSettings {
  schemaVersion: number;
  // 1. General
  enabled: boolean;
  autoStartOnCall: boolean;
  showCallHud: boolean;
  hudPosition: HudPosition;
  meetingMode: MeetingModeId;
  onboardingCompleted: boolean;
  // 2. Detection & Gesture
  sensitivity: number; // 0 - 100 (synchronized with gesture.sensitivity)
  gesture: GestureSettings;
  // 3. Camera & Background
  camera: CameraSettings;
  // 4. Audio
  sound: boolean;
  muteOnVanish: boolean;
  audio: AudioConfirmationSettings;
  // 5. Animation
  effect: EffectType;
  direction: Direction;
  duration: number; // 0.5 - 4.0 seconds
  speed: number; // 0.5 - 2.5 multiplier
  particleSize: number; // 0.5 - 3.0 multiplier
  density: number; // 20 - 100 percentage
  colorAccent: string; // Hex color e.g. #e0532c
  intensity: number; // 10 - 100 percentage
  motionSmoothness: number; // 0 - 100 percentage
  // 6. Performance
  lowPowerMode: boolean;
  performanceProfile: PerformanceProfile;
  pauseWhenHidden: boolean;
  maxParticles: number; // 4000 - 28000
  // 7. Privacy
  diagnosticLoggingEnabled: boolean;
  recordActivityHistory: boolean;
  strictLocalOnly: boolean;
  // 8. Keyboard Shortcuts
  shortcuts: ShortcutSettings;
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
  | "motionSmoothness"
  | "sound"
  | "lowPowerMode"
>;

export interface EffectPreset {
  id: string;
  name: string;
  description: string;
  isBuiltIn?: boolean;
  reverseMode?: boolean;
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
  migratedFromVersion?: number;
}

export type AnalyticsEventType =
  | "vanish_activated"
  | "restore_completed"
  | "emergency_restore"
  | "trigger_failed"
  | "trigger_blocked_cooldown"
  | "detection_toggled"
  | "preset_selected"
  | "mode_selected"
  | "calibration_completed"
  | "error_recorded";

export interface AnalyticsEvent {
  id: string;
  type: AnalyticsEventType;
  timestamp: string;
  effect?: EffectType;
  presetId?: string;
  modeId?: MeetingModeId;
  source?: "manual" | "gesture" | "shortcut" | "popup" | "dashboard" | "system";
  sessionStatus?: EngineState;
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
  dailyActivations: Record<string, number>;
  events: AnalyticsEvent[];
  lastUpdated: string;
}

export interface DetectionDiagnosticsState {
  modelStatus: "unloaded" | "loading" | "ready" | "error";
  modelLoadProgress: number; // 0 - 100
  modelError: string | null;
  handDetected: boolean;
  handedness: "Left" | "Right" | null;
  landmarkConfidence: number; // 0 - 1
  gesturePhase: GesturePhase;
  gestureCandidate: boolean;
  gestureConfirmed: boolean;
  audioConfirmed: boolean;
  audioCurrentDb: number;
  audioFloorDb: number;
  thumbMiddleDistanceMm: number;
  approachVelocityMmPerSec: number;
  wristOmegaRadPerSec: number;
  cooldownRemainingMs: number;
  inferenceMs: number | null;
  lastReason: string;
  processingErrors: string[];
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
  cameraResolution: string | null;
  permissions: {
    camera: "granted" | "denied" | "prompt" | "unknown";
    microphone: "granted" | "denied" | "prompt" | "unknown";
  };
  cleanup: ResourceCleanupStatus;
  logs: DiagnosticLogEntry[];
}

export type AppErrorCode =
  | "CAMERA_PERMISSION_DENIED"
  | "MICROPHONE_PERMISSION_DENIED"
  | "CAMERA_DISCONNECTED"
  | "MICROPHONE_DISCONNECTED"
  | "MODEL_LOAD_FAILED"
  | "UNSUPPORTED_BROWSER"
  | "UNSUPPORTED_PLATFORM"
  | "TRACK_REPLACEMENT_FAILED"
  | "AUDIO_INIT_FAILED"
  | "INVALID_SETTINGS"
  | "EXTENSION_MESSAGING_ERROR"
  | "SERVICE_WORKER_RESTART"
  | "MISSING_RESOURCE"
  | "UNEXPECTED_EXCEPTION";

export interface AppErrorRecord {
  id: string;
  code: AppErrorCode;
  title: string;
  explanation: string;
  recoveryLabel: string;
  recoveryAction:
    | "retry-camera"
    | "retry-microphone"
    | "reload-model"
    | "emergency-restore"
    | "reset-settings"
    | "reconnect-extension"
    | "switch-fallback"
    | "dismiss";
  severity: "warning" | "error";
  timestamp: string;
  autoRestoredCamera: boolean;
}

export type PlatformSupportLevel =
  | "Partially implemented"
  | "Experimental"
  | "Fully implemented and tested"
  | "Unsupported";

export interface PlatformCompatibilityEntry {
  id: "google-meet" | "microsoft-teams" | "zoom-web";
  name: string;
  hostPatterns: string[];
  classification: PlatformSupportLevel;
  verificationStatus: "Tested in automated harness; Untested in live call";
  outgoingStreamMethod: string;
  selfViewOverlaySupport: boolean;
  knownLimitations: string[];
  fallbackWorkflow: string;
}

export type ExtensionMessageType =
  | "PING"
  | "GET_STATE"
  | "SNAP_NOW"
  | "SNAP_TOGGLE"
  | "SNAP_VANISH_NOW"
  | "SNAP_RESTORE_NOW"
  | "EMERGENCY_RESTORE"
  | "MUTE_TOGGLE"
  | "DETECTION_TOGGLE"
  | "CAPTURE_CLEAN_PLATE"
  | "REVIEW_CLEAN_PLATE"
  | "CANCEL_CLEAN_PLATE"
  | "CLEAR_CLEAN_PLATE"
  | "OPEN_STUDIO"
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
  detectionEnabled?: boolean;
  handModelReady?: boolean;
  handModelBackend?: "in-page" | "offscreen" | null;
  handModelError?: string | null;
  webrtcSendersCount?: number;
  muted?: boolean | null;
  cameraPresent?: boolean;
  detectionActive?: boolean;
  detectionStatus?: string;
  audioGateActive?: boolean;
  restoreError?: string | null;
  renderError?: string | null;
  cleanPlateStatus?: "none" | "countdown" | "review" | "captured";
  cleanPlateRemaining?: number;
  cleanPlateError?: string | null;
  backgroundMethod?: "solid-fallback" | "captured-plate";
  tabId?: number;
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
