import type { AppErrorCode, AppErrorRecord } from "../types/snapVanish";
import { appendDiagnosticLog } from "../lib/diagnostics";
import { recordAnalyticsEvent } from "../lib/analytics";

interface ErrorBlueprint {
  title: string;
  explanation: string;
  recoveryLabel: string;
  recoveryAction: AppErrorRecord["recoveryAction"];
  severity: "warning" | "error";
  shouldAutoRestoreCamera: boolean;
}

const ERROR_CATALOG: Record<AppErrorCode, ErrorBlueprint> = {
  CAMERA_PERMISSION_DENIED: {
    title: "Camera Permission Denied",
    explanation:
      "Browser camera access was blocked. Live hand detection requires permission; synthetic Studio calibration remains available.",
    recoveryLabel: "Retry Camera Access",
    recoveryAction: "retry-camera",
    severity: "warning",
    shouldAutoRestoreCamera: true,
  },
  MICROPHONE_PERMISSION_DENIED: {
    title: "Microphone Permission Denied",
    explanation:
      "Microphone access was denied. Acoustic snap confirmation is paused; you can retry permission or use visual-only gesture detection / keyboard shortcuts.",
    recoveryLabel: "Retry Microphone",
    recoveryAction: "retry-microphone",
    severity: "warning",
    shouldAutoRestoreCamera: false,
  },
  CAMERA_DISCONNECTED: {
    title: "Camera Disconnected",
    explanation:
      "The active video device disconnected or is unavailable. Check the meeting camera and reconnect the device; recovery is not guaranteed.",
    recoveryLabel: "Reconnect Camera",
    recoveryAction: "retry-camera",
    severity: "error",
    shouldAutoRestoreCamera: true,
  },
  MICROPHONE_DISCONNECTED: {
    title: "Microphone Disconnected",
    explanation:
      "The selected audio input device was unplugged. Acoustic snap confirmation has been safely paused until an audio input is reconnected.",
    recoveryLabel: "Reconnect Microphone",
    recoveryAction: "retry-microphone",
    severity: "warning",
    shouldAutoRestoreCamera: false,
  },
  MODEL_LOAD_FAILED: {
    title: "Hand Detection Model Failed to Initialize",
    explanation:
      "The local MediaPipe hand landmark WASM runtime could not initialize. Manual vanish controls and keyboard shortcuts remain active.",
    recoveryLabel: "Reload Detection Model",
    recoveryAction: "reload-model",
    severity: "error",
    shouldAutoRestoreCamera: false,
  },
  UNSUPPORTED_BROWSER: {
    title: "Browser Capability Missing",
    explanation:
      "A required browser capability may be unavailable. The manifest targets Chrome 121+, but individual browser and meeting-site compatibility must be verified.",
    recoveryLabel: "Use Studio Preview",
    recoveryAction: "switch-fallback",
    severity: "warning",
    shouldAutoRestoreCamera: false,
  },
  UNSUPPORTED_PLATFORM: {
    title: "No Supported Meeting Tab Active",
    explanation:
      "Open Google Meet, Microsoft Teams Web, or Zoom Web Client in the active tab to control a live meeting feed.",
    recoveryLabel: "Dismiss",
    recoveryAction: "dismiss",
    severity: "warning",
    shouldAutoRestoreCamera: false,
  },
  TRACK_REPLACEMENT_FAILED: {
    title: "Outgoing Video Track Replacement Unavailable",
    explanation:
      "The meeting's camera sender could not be safely replaced. A local-only overlay may be available; check the meeting view and camera status.",
    recoveryLabel: "Restore Live Camera",
    recoveryAction: "emergency-restore",
    severity: "warning",
    shouldAutoRestoreCamera: true,
  },
  AUDIO_INIT_FAILED: {
    title: "Audio Confirmation Engine Error",
    explanation:
      "Web Audio initialization failed on the selected device. Try choosing another microphone or disabling acoustic confirmation.",
    recoveryLabel: "Retry Audio Setup",
    recoveryAction: "retry-microphone",
    severity: "warning",
    shouldAutoRestoreCamera: false,
  },
  INVALID_SETTINGS: {
    title: "Corrupted Settings Repaired",
    explanation:
      "Invalid or out-of-range configuration values were detected and safely sanitized to valid defaults.",
    recoveryLabel: "Reset to Defaults",
    recoveryAction: "reset-settings",
    severity: "warning",
    shouldAutoRestoreCamera: false,
  },
  EXTENSION_MESSAGING_ERROR: {
    title: "Extension Tab Bridge Unreachable",
    explanation:
      "Could not reach the content script in the meeting tab. If you just installed or updated Snap Vanish, reload the meeting tab once.",
    recoveryLabel: "Reconnect Bridge",
    recoveryAction: "reconnect-extension",
    severity: "warning",
    shouldAutoRestoreCamera: false,
  },
  SERVICE_WORKER_RESTART: {
    title: "Extension Service Worker Reawakened",
    explanation:
      "The extension service worker may have restarted. Check the meeting state before retrying an action.",
    recoveryLabel: "Retry Action",
    recoveryAction: "reconnect-extension",
    severity: "warning",
    shouldAutoRestoreCamera: false,
  },
  MISSING_RESOURCE: {
    title: "Local Asset Missing",
    explanation:
      "A local visual asset or model file could not be loaded. A Studio preview fallback may be available; automatic detection may remain inactive.",
    recoveryLabel: "Switch to Fallback",
    recoveryAction: "switch-fallback",
    severity: "warning",
    shouldAutoRestoreCamera: false,
  },
  UNEXPECTED_EXCEPTION: {
    title: "Unexpected Runtime Error",
    explanation:
      "An unexpected error occurred. Check the meeting camera and request Emergency Restore if needed; recovery can fail.",
    recoveryLabel: "Emergency Restore",
    recoveryAction: "emergency-restore",
    severity: "error",
    shouldAutoRestoreCamera: true,
  },
};

/**
 * Centralized error handler that:
 * 1. Classifies the failure into one of 14 canonical error codes
 * 2. Generates a user-friendly explanation + concrete recovery action
 * 3. Logs only non-sensitive diagnostic metadata
 * 4. Requests a local preview reset on selected failures; it does not verify meeting restoration
 */
export function createAppError(
  code: AppErrorCode,
  options: {
    diagnosticDetail?: string;
    loggingEnabled?: boolean;
    recordHistory?: boolean;
    onSafeRestoreCamera?: () => void;
  } = {},
): AppErrorRecord {
  const bp = ERROR_CATALOG[code] ?? ERROR_CATALOG.UNEXPECTED_EXCEPTION;

  let autoRestoreRequested = false;
  if (bp.shouldAutoRestoreCamera && options.onSafeRestoreCamera) {
    try {
      options.onSafeRestoreCamera();
      autoRestoreRequested = true;
    } catch {
      // Never throw inside recovery path
    }
  }

  const sanitizedDetail = options.diagnosticDetail
    ? options.diagnosticDetail.replace(/(https?:\/\/[^\s]+|token=[^\s&]+)/gi, "[redacted]").slice(0, 240)
    : undefined;

  appendDiagnosticLog(
    {
      level: bp.severity === "error" ? "error" : "warn",
      code,
      message: bp.title,
      details: sanitizedDetail,
    },
    options.loggingEnabled ?? true,
  );

  recordAnalyticsEvent({
    type: "error_recorded",
    source: "system",
    reason: code,
    enabled: options.recordHistory ?? true,
  });

  return {
    id: `err-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    code,
    title: bp.title,
    explanation: bp.explanation,
    recoveryLabel: bp.recoveryLabel,
    recoveryAction: bp.recoveryAction,
    severity: bp.severity,
    timestamp: new Date().toISOString(),
    // The callback only requests a local reset; it cannot confirm a meeting track.
    autoRestoreRequested,
  };
}

export function classifyMediaError(err: unknown, kind: "camera" | "microphone"): AppErrorCode {
  const name = err instanceof DOMException ? err.name : (err as { name?: string })?.name;
  if (name === "NotAllowedError" || name === "PermissionDeniedError" || name === "SecurityError") {
    return kind === "camera"
      ? "CAMERA_PERMISSION_DENIED"
      : "MICROPHONE_PERMISSION_DENIED";
  }
  if (name === "NotFoundError" || name === "DevicesNotFoundError" || name === "OverconstrainedError") {
    return kind === "camera" ? "CAMERA_DISCONNECTED" : "MICROPHONE_DISCONNECTED";
  }
  return kind === "camera" ? "UNEXPECTED_EXCEPTION" : "AUDIO_INIT_FAILED";
}
