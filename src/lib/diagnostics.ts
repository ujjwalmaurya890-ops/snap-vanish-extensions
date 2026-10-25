import type {
  DiagnosticLogEntry,
  DiagnosticSnapshot,
  EngineState,
  InterceptionMode,
  ResourceCleanupStatus,
} from "../types/snapVanish";
import { isExtensionRuntimeAvailable } from "./messaging";
import { STORAGE_KEYS, broadcastSyncEvent } from "./settings";

const MAX_DIAGNOSTIC_LOGS = 100;

export function loadDiagnosticLogs(): DiagnosticLogEntry[] {
  try {
    if (typeof localStorage === "undefined") return [];
    const raw = localStorage.getItem(STORAGE_KEYS.DIAGNOSTICS);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.slice(0, MAX_DIAGNOSTIC_LOGS) : [];
  } catch {
    return [];
  }
}

export function appendDiagnosticLog(
  entry: Omit<DiagnosticLogEntry, "id" | "timestamp">,
  loggingEnabled = true,
): DiagnosticLogEntry[] {
  if (!loggingEnabled) return loadDiagnosticLogs();
  const current = loadDiagnosticLogs();
  const fullEntry: DiagnosticLogEntry = {
    id: `diag-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    timestamp: new Date().toISOString(),
    ...entry,
  };
  const updated = [fullEntry, ...current].slice(0, MAX_DIAGNOSTIC_LOGS);
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(STORAGE_KEYS.DIAGNOSTICS, JSON.stringify(updated));
    }
  } catch {
    // Ignore
  }
  broadcastSyncEvent("DIAGNOSTICS_UPDATED", updated);
  return updated;
}

export function clearDiagnosticLogs(): DiagnosticLogEntry[] {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.removeItem(STORAGE_KEYS.DIAGNOSTICS);
    }
  } catch {
    // Ignore
  }
  broadcastSyncEvent("DIAGNOSTICS_UPDATED", []);
  return [];
}

/**
 * Measures actual canvas frame intervals and per-frame render execution time.
 * Never fabricates numbers: returns null when insufficient samples have been collected.
 */
export class FramePerformanceTracker {
  private frameIntervals: number[] = [];
  private renderDurations: number[] = [];
  private lastFrameTimestamp: number | null = null;
  private readonly maxSamples = 30;

  recordFrame(renderStartMs: number, renderEndMs: number) {
    const duration = Math.max(0, renderEndMs - renderStartMs);
    this.renderDurations.push(duration);
    if (this.renderDurations.length > this.maxSamples) {
      this.renderDurations.shift();
    }

    if (this.lastFrameTimestamp !== null) {
      const interval = renderEndMs - this.lastFrameTimestamp;
      if (interval > 1 && interval < 1000) {
        this.frameIntervals.push(interval);
        if (this.frameIntervals.length > this.maxSamples) {
          this.frameIntervals.shift();
        }
      }
    }
    this.lastFrameTimestamp = renderEndMs;
  }

  getMeasuredFps(): number | null {
    if (this.frameIntervals.length < 3) return null;
    const avgInterval =
      this.frameIntervals.reduce((a, b) => a + b, 0) /
      this.frameIntervals.length;
    if (avgInterval <= 0) return null;
    return Math.min(120, Math.round(1000 / avgInterval));
  }

  getMeasuredRenderMs(): number | null {
    if (this.renderDurations.length === 0) return null;
    const avg =
      this.renderDurations.reduce((a, b) => a + b, 0) /
      this.renderDurations.length;
    return Number(avg.toFixed(2));
  }

  reset() {
    this.frameIntervals = [];
    this.renderDurations = [];
    this.lastFrameTimestamp = null;
  }
}

export function checkWebGL2Support(): boolean {
  try {
    if (typeof document === "undefined") return false;
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2");
    return Boolean(gl);
  } catch {
    return false;
  }
}

export function checkMediaDevicesSupport(): boolean {
  return Boolean(
    typeof navigator !== "undefined" &&
      navigator.mediaDevices &&
      typeof navigator.mediaDevices.getUserMedia === "function",
  );
}

export async function queryMediaPermissions(): Promise<{
  camera: "granted" | "denied" | "prompt" | "unknown";
  microphone: "granted" | "denied" | "prompt" | "unknown";
}> {
  const result: {
    camera: "granted" | "denied" | "prompt" | "unknown";
    microphone: "granted" | "denied" | "prompt" | "unknown";
  } = {
    camera: "unknown",
    microphone: "unknown",
  };

  if (typeof navigator === "undefined" || !navigator.permissions?.query) {
    return result;
  }

  try {
    const cam = await navigator.permissions.query({
      name: "camera" as PermissionName,
    });
    if (
      cam.state === "granted" ||
      cam.state === "denied" ||
      cam.state === "prompt"
    ) {
      result.camera = cam.state;
    }
  } catch {
    result.camera = "unknown";
  }

  try {
    const mic = await navigator.permissions.query({
      name: "microphone" as PermissionName,
    });
    if (
      mic.state === "granted" ||
      mic.state === "denied" ||
      mic.state === "prompt"
    ) {
      result.microphone = mic.state;
    }
  } catch {
    result.microphone = "unknown";
  }

  return result;
}

export async function buildDiagnosticSnapshot(params: {
  perfTracker: FramePerformanceTracker;
  activeParticleCount: number;
  engineState: EngineState;
  interceptionMode: InterceptionMode;
  lowPowerActive: boolean;
  cleanup: ResourceCleanupStatus;
}): Promise<DiagnosticSnapshot> {
  const permissions = await queryMediaPermissions();
  return {
    measuredFps: params.perfTracker.getMeasuredFps(),
    frameRenderMs: params.perfTracker.getMeasuredRenderMs(),
    activeParticleCount: params.activeParticleCount,
    engineState: params.engineState,
    interceptionMode: params.interceptionMode,
    lowPowerActive: params.lowPowerActive,
    webGL2Supported: checkWebGL2Support(),
    mediaDevicesSupported: checkMediaDevicesSupport(),
    extensionBridgeConnected: isExtensionRuntimeAvailable(),
    permissions,
    cleanup: params.cleanup,
    logs: loadDiagnosticLogs(),
  };
}
