import { useCallback, useEffect, useRef, useState } from "react";
import { HelpCircle, RotateCcw, Sliders } from "lucide-react";
import SnapStage, { type SnapStatus } from "./components/SnapStage";
import { SnapMark } from "./components/SnapMark";
import Dashboard, { type WorkspaceTab } from "./components/Dashboard";
import OnboardingModal from "./components/OnboardingModal";
import CalibrationModal from "./features/calibration/CalibrationModal";
import {
  ArchitectureAndInstallSection,
  Footer,
} from "./components/Sections";
import { Badge, Button, StatusDot } from "./components/ui/DesignSystem";
import {
  BUILT_IN_PRESETS,
  DEFAULT_SETTINGS,
  createPresetFromSettings,
  deletePreset,
  duplicatePreset,
  loadPresets,
  loadSettings,
  saveCustomPresets,
  saveSettings,
} from "./lib/settings";
import {
  clearAnalyticsData,
  createEmptyAnalytics,
  loadAnalytics,
  recordAnalyticsEvent,
} from "./lib/analytics";
import {
  appendDiagnosticLog,
  clearDiagnosticLogs,
  loadDiagnosticLogs,
} from "./lib/diagnostics";
import { sendExtensionMessage } from "./lib/messaging";
import { createAppError } from "./services/errorService";
import type {
  AppErrorCode,
  AppErrorRecord,
  DetectionDiagnosticsState,
  DiagnosticLogEntry,
  EffectPreset,
  SnapSettings,
  UsageAnalyticsSummary,
} from "./types/snapVanish";

const INITIAL_DETECTION_DIAG: DetectionDiagnosticsState = {
  modelStatus: "unloaded",
  modelLoadProgress: 0,
  modelError: null,
  handDetected: false,
  handedness: null,
  landmarkConfidence: 0,
  gesturePhase: "no-hand",
  gestureCandidate: false,
  gestureConfirmed: false,
  audioConfirmed: false,
  audioCurrentDb: -90,
  audioFloorDb: -60,
  thumbMiddleDistanceMm: 0,
  approachVelocityMmPerSec: 0,
  wristOmegaRadPerSec: 0,
  cooldownRemainingMs: 0,
  inferenceMs: null,
  lastReason: "standby",
  processingErrors: [],
};

export function App() {
  const sessionStartedAtRef = useRef<number>(Date.now());
  const [settings, setSettings] = useState<SnapSettings>(DEFAULT_SETTINGS);
  const [presets, setPresets] = useState<EffectPreset[]>(BUILT_IN_PRESETS);
  const [activePresetId, setActivePresetId] = useState<string>(
    BUILT_IN_PRESETS[0]?.id ?? "preset-classic-dust",
  );
  const [analytics, setAnalytics] = useState<UsageAnalyticsSummary>(
    createEmptyAnalytics,
  );
  const [diagnostics, setDiagnostics] = useState<DiagnosticLogEntry[]>([]);
  const [detectionState, setDetectionState] =
    useState<DetectionDiagnosticsState>(INITIAL_DETECTION_DIAG);
  const [activeErrors, setActiveErrors] = useState<AppErrorRecord[]>([]);

  const [activeTab, setActiveTab] = useState<WorkspaceTab>("dashboard");
  const [status, setStatus] = useState<SnapStatus>("idle");
  const [snapSignal, setSnapSignal] = useState(0);
  const [restoreSignal, setRestoreSignal] = useState(0);
  const [emergencySignal, setEmergencySignal] = useState(0);
  const [liveCameraRequested, setLiveCameraRequested] = useState(false);

  const [onboardingOpen, setOnboardingOpen] = useState(false);
  const [calibrationOpen, setCalibrationOpen] = useState(false);
  const [activePlatformLabel, setActivePlatformLabel] = useState(
    "Effect Studio · Local MV3",
  );

  const [liveMetrics, setLiveMetrics] = useState<{
    fps: number | null;
    renderMs: number | null;
    particles: number;
  }>({ fps: null, renderMs: null, particles: 0 });

  const [liveCameraInfo, setLiveCameraInfo] = useState<{
    active: boolean;
    resolution: string | null;
  }>({ active: false, resolution: null });

  const [audioMonitor, setAudioMonitor] = useState<{
    active: boolean;
    levelPercent: number;
    currentDb: number;
    floorDb: number;
  }>({ active: false, levelPercent: 0, currentDb: -90, floorDb: -60 });

  useEffect(() => {
    let mounted = true;
    Promise.all([
      loadSettings(),
      Promise.resolve(loadPresets()),
      Promise.resolve(loadAnalytics()),
      Promise.resolve(loadDiagnosticLogs()),
      sendExtensionMessage({ type: "GET_STATE" }),
    ]).then(([loadedSettings, loadedPresets, loadedAnalytics, loadedDiag, extRes]) => {
      if (!mounted) return;
      setSettings(loadedSettings);
      setPresets(loadedPresets);
      setAnalytics(loadedAnalytics);
      setDiagnostics(loadedDiag);
      if (!loadedSettings.onboardingCompleted) {
        setOnboardingOpen(true);
      }
      if (extRes.ok && extRes.host) {
        setActivePlatformLabel(`Connected · ${extRes.host}`);
      }
    });

    // Listen for BroadcastChannel cross-tab / popup sync
    let ch: BroadcastChannel | null = null;
    try {
      if (typeof BroadcastChannel !== "undefined") {
        ch = new BroadcastChannel("snap_vanish_channel");
        ch.onmessage = (ev) => {
          if (ev.data?.type === "SETTINGS_UPDATED" && ev.data?.payload) {
            setSettings(ev.data.payload as SnapSettings);
          }
        };
      }
    } catch {
      // Ignore if BroadcastChannel unavailable
    }

    return () => {
      mounted = false;
      ch?.close();
    };
  }, []);

  const patchSettings = useCallback((patch: Partial<SnapSettings>) => {
    setSettings((prev) => {
      const merged: SnapSettings = {
        ...prev,
        ...patch,
        gesture: patch.gesture
          ? { ...prev.gesture, ...patch.gesture }
          : prev.gesture,
        audio: patch.audio ? { ...prev.audio, ...patch.audio } : prev.audio,
        camera: patch.camera ? { ...prev.camera, ...patch.camera } : prev.camera,
        shortcuts: patch.shortcuts
          ? { ...prev.shortcuts, ...patch.shortcuts }
          : prev.shortcuts,
      };
      void saveSettings(merged);
      void sendExtensionMessage({
        type: "SETTINGS_CHANGED",
        payload: merged as unknown as Record<string, unknown>,
      });
      return merged;
    });
  }, []);

  const handleReplaceAllSettings = useCallback(
    (nextSettings: SnapSettings, nextPresets?: EffectPreset[]) => {
      setSettings(nextSettings);
      void saveSettings(nextSettings);
      void sendExtensionMessage({
        type: "SETTINGS_CHANGED",
        payload: nextSettings as unknown as Record<string, unknown>,
      });
      if (nextPresets) {
        const all = saveCustomPresets(nextPresets);
        setPresets(all);
      }
    },
    [],
  );

  const handleResetDefaults = useCallback(async () => {
    const fresh: SnapSettings = {
      ...structuredClone(DEFAULT_SETTINGS),
      onboardingCompleted: true,
    };
    setSettings(fresh);
    await saveSettings(fresh);
    const basePresets = saveCustomPresets([]);
    setPresets(basePresets);
    setActivePresetId(basePresets[0]?.id ?? "preset-classic-dust");
    void sendExtensionMessage({
      type: "SETTINGS_CHANGED",
      payload: fresh as unknown as Record<string, unknown>,
    });
    const logs = appendDiagnosticLog(
      {
        level: "info",
        code: "SETTINGS_RESET",
        message: "Reset all settings and presets to factory v2 defaults",
      },
      fresh.diagnosticLoggingEnabled,
    );
    setDiagnostics(logs);
  }, []);

  const handleTriggerVanish = useCallback(() => {
    if (!settings.enabled) return;
    setSnapSignal((n) => n + 1);
    void sendExtensionMessage({ type: "SNAP_NOW" });
  }, [settings.enabled]);

  const handleTriggerRestore = useCallback(() => {
    if (!settings.enabled) return;
    setRestoreSignal((n) => n + 1);
    void sendExtensionMessage({ type: "SNAP_RESTORE_NOW" });
  }, [settings.enabled]);

  const handleEmergencyRestore = useCallback(() => {
    setEmergencySignal((n) => n + 1);
    setActiveErrors([]);
    void sendExtensionMessage({ type: "EMERGENCY_RESTORE" });
    const nextAnalytics = recordAnalyticsEvent({
      type: "emergency_restore",
      effect: settings.effect,
      presetId: activePresetId,
      source: "dashboard",
      enabled: settings.recordActivityHistory,
    });
    setAnalytics(nextAnalytics);
    const logs = appendDiagnosticLog(
      {
        level: "warn",
        code: "EMERGENCY_RESTORE",
        message: "Emergency Restore triggered: live camera restored unconditionally",
      },
      settings.diagnosticLoggingEnabled,
    );
    setDiagnostics(logs);
  }, [
    activePresetId,
    settings.diagnosticLoggingEnabled,
    settings.effect,
    settings.recordActivityHistory,
  ]);

  const handleStageStatus = useCallback(
    (next: SnapStatus) => {
      setStatus(next);
      if (next === "gone") {
        const nextAnalytics = recordAnalyticsEvent({
          type: "vanish_activated",
          effect: settings.effect,
          presetId: activePresetId,
          source: liveCameraInfo.active ? "gesture" : "manual",
          enabled: settings.recordActivityHistory,
        });
        setAnalytics(nextAnalytics);
      } else if (next === "idle") {
        const nextAnalytics = recordAnalyticsEvent({
          type: "restore_completed",
          effect: settings.effect,
          presetId: activePresetId,
          source: "manual",
          enabled: settings.recordActivityHistory,
        });
        setAnalytics(nextAnalytics);
      }
    },
    [
      activePresetId,
      liveCameraInfo.active,
      settings.effect,
      settings.recordActivityHistory,
    ],
  );

  const handleSelectPreset = useCallback(
    (preset: EffectPreset) => {
      setActivePresetId(preset.id);
      patchSettings({
        effect: preset.config.effect,
        direction: preset.config.direction,
        duration: preset.config.duration,
        speed: preset.config.speed,
        particleSize: preset.config.particleSize,
        density: preset.config.density,
        colorAccent: preset.config.colorAccent,
        intensity: preset.config.intensity,
        motionSmoothness: preset.config.motionSmoothness,
      });
      const nextAnalytics = recordAnalyticsEvent({
        type: "preset_selected",
        presetId: preset.id,
        effect: preset.config.effect,
        source: "dashboard",
        enabled: settings.recordActivityHistory,
      });
      setAnalytics(nextAnalytics);
    },
    [patchSettings, settings.recordActivityHistory],
  );

  const handleSavePreset = useCallback(
    (name: string, description: string) => {
      const updated = createPresetFromSettings(name, description, settings);
      setPresets(updated);
      const newest = updated[updated.length - 1];
      if (newest) setActivePresetId(newest.id);
    },
    [settings],
  );

  const handleDuplicatePreset = useCallback(
    (source: EffectPreset) => {
      const updated = duplicatePreset(source.id);
      setPresets(updated);
      const newest = updated[updated.length - 1];
      if (newest) handleSelectPreset(newest);
    },
    [handleSelectPreset],
  );

  const handleDeletePreset = useCallback(
    (id: string) => {
      const updated = deletePreset(id);
      setPresets(updated);
      if (activePresetId === id && updated[0]) {
        handleSelectPreset(updated[0]);
      }
    },
    [activePresetId, handleSelectPreset],
  );

  const handleRaiseError = useCallback(
    (code: AppErrorCode, detail?: string) => {
      const rec = createAppError(code, {
        diagnosticDetail: detail,
        loggingEnabled: settings.diagnosticLoggingEnabled,
        recordHistory: settings.recordActivityHistory,
        onSafeRestoreCamera: () => {
          setEmergencySignal((n) => n + 1);
        },
      });
      setActiveErrors((prev) => [rec, ...prev.slice(0, 4)]);
      setDiagnostics(loadDiagnosticLogs());
    },
    [settings.diagnosticLoggingEnabled, settings.recordActivityHistory],
  );

  const handleClearHistory = useCallback(() => {
    const freshAnalytics = clearAnalyticsData();
    const freshLogs = clearDiagnosticLogs();
    setAnalytics(freshAnalytics);
    setDiagnostics(freshLogs);
  }, []);

  const handleExportDiagnostics = useCallback(() => {
    const payload = {
      exportedAt: new Date().toISOString(),
      schemaVersion: settings.schemaVersion,
      detectionMode: settings.gesture.mode,
      activePlatformLabel,
      detectionState,
      logs: diagnostics,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `snap-vanish-diagnostics-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [
    activePlatformLabel,
    detectionState,
    diagnostics,
    settings.gesture.mode,
    settings.schemaVersion,
  ]);

  return (
    <div className="min-h-screen bg-[#09090b] text-[#f4f4f6]">
      <header className="sticky top-0 z-40 border-b border-white/[0.08] bg-[#0b0d12]/90 backdrop-blur-xl">
        <div className="mx-auto flex max-w-[1280px] flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6 lg:px-8">
          <div className="flex items-center gap-3">
            <a
              href="#top"
              className="flex items-center gap-2.5 text-[15px] font-semibold tracking-tight text-white"
            >
              <SnapMark size={24} />
              <span>Snap Vanish</span>
              <span className="rounded-md border border-[#f0623a]/35 bg-[#e0532c]/15 px-1.5 py-0.5 font-mono text-[10.5px] font-medium text-[#ff9d80]">
                2.0
              </span>
            </a>

            <div className="hidden items-center gap-2 sm:flex">
              <Badge
                tone={
                  !settings.enabled
                    ? "neutral"
                    : status === "gone"
                      ? "amber"
                      : "emerald"
                }
              >
                <StatusDot
                  tone={
                    !settings.enabled
                      ? "muted"
                      : status === "gone"
                        ? "amber"
                        : "emerald"
                  }
                  pulse={settings.enabled && status === "idle"}
                />
                {!settings.enabled
                  ? "Disabled"
                  : status === "gone"
                    ? "Vanished"
                    : "Active"}
              </Badge>
              <span className="hidden font-mono text-[11px] text-[#6c7284] md:inline">
                {activePlatformLabel}
              </span>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            <div className="inline-flex items-center gap-2 rounded-xl border border-white/[0.08] bg-[#151821] px-3 py-1.5 text-[12px]">
              <span className="text-[#c9cdd8]">Extension</span>
              <button
                type="button"
                role="switch"
                aria-checked={settings.enabled}
                aria-label="Master extension enable toggle"
                onClick={() => patchSettings({ enabled: !settings.enabled })}
                className={`relative h-5 w-9 rounded-full transition-colors ${
                  settings.enabled ? "bg-[#e0532c]" : "bg-[#2a2e3b]"
                }`}
              >
                <span
                  className={`absolute top-[2px] h-4 w-4 rounded-full bg-white transition-transform ${
                    settings.enabled ? "translate-x-[18px]" : "translate-x-[2px]"
                  }`}
                />
              </button>
            </div>

            <Button
              size="sm"
              variant="secondary"
              onClick={() => setCalibrationOpen(true)}
              className="hidden sm:inline-flex"
            >
              <Sliders className="h-3.5 w-3.5 text-[#f0623a]" />
              Calibrate
            </Button>

            <Button
              size="sm"
              variant="ghost"
              onClick={() => setOnboardingOpen(true)}
              title="Open 8-Step Setup Guide"
            >
              <HelpCircle className="h-4 w-4" />
              <span className="hidden md:inline">Setup Guide</span>
            </Button>

            <Button
              size="sm"
              variant="danger"
              onClick={handleEmergencyRestore}
              title="Emergency Camera & Mic Restore (Alt+Shift+R)"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              <span>Emergency Restore</span>
            </Button>
          </div>
        </div>
      </header>

      <main
        id="top"
        className="mx-auto max-w-[1280px] space-y-6 px-4 py-6 sm:px-6 lg:px-8"
      >
        <section className="space-y-4">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <div className="rail text-[#ff9d80]">
                LOCAL 21-POINT HAND AI · ACOUSTIC CONFIRMATION · POOLED PARTICLE ENGINE
              </div>
              <h1 className="mt-1 text-[24px] font-semibold tracking-tight text-white sm:text-[30px]">
                Snap your fingers. Disintegrate cleanly out of frame.
              </h1>
            </div>
            <div className="font-mono text-[11px] text-[#8b92a5]">
              Shortcuts: <span className="text-white">Alt+Shift+D</span> Vanish ·{" "}
              <span className="text-white">Alt+Shift+R</span> Emergency Restore
            </div>
          </div>

          <SnapStage
            enabled={settings.enabled}
            duration={settings.duration}
            direction={settings.direction}
            sensitivity={settings.gesture.sensitivity}
            snapSignal={snapSignal}
            restoreSignal={restoreSignal}
            emergencySignal={emergencySignal}
            sound={settings.sound}
            effect={settings.effect}
            speed={settings.speed}
            particleSize={settings.particleSize}
            density={settings.density}
            colorAccent={settings.colorAccent}
            intensity={settings.intensity}
            motionSmoothness={settings.motionSmoothness}
            lowPowerMode={settings.lowPowerMode}
            pauseWhenHidden={settings.pauseWhenHidden}
            maxParticles={settings.maxParticles}
            fullSettings={settings}
            liveCameraRequested={liveCameraRequested}
            onLiveCameraChange={(active, resolution) =>
              setLiveCameraInfo({ active, resolution })
            }
            onAudioMonitorChange={(active, levelPercent, currentDb, floorDb) =>
              setAudioMonitor({ active, levelPercent, currentDb, floorDb })
            }
            onDetectionDiagnostics={setDetectionState}
            onRaiseError={handleRaiseError}
            onGestureTriggered={(mapping) => {
              const logs = appendDiagnosticLog(
                {
                  level: "info",
                  code: "GESTURE_CONFIRMED",
                  message: `Confirmed 21-pt finger snap (${mapping})`,
                },
                settings.diagnosticLoggingEnabled,
              );
              setDiagnostics(logs);
            }}
            onStatus={handleStageStatus}
            onEmergencyRestore={() => {
              setActiveErrors([]);
            }}
            onMetrics={setLiveMetrics}
          />
        </section>

        <Dashboard
          activeTab={activeTab}
          onChangeTab={setActiveTab}
          settings={settings}
          presets={presets}
          activePresetId={activePresetId}
          sessionStartedAt={sessionStartedAtRef.current}
          status={status}
          analytics={analytics}
          diagnostics={diagnostics}
          detectionState={detectionState}
          activeErrors={activeErrors}
          liveMetrics={liveMetrics}
          liveCameraInfo={liveCameraInfo}
          audioMonitor={audioMonitor}
          activePlatformLabel={activePlatformLabel}
          onPatchSettings={(patch) => {
            if (patch.meetingMode === "custom") {
              setActivePresetId("custom");
            }
            patchSettings(patch);
          }}
          onReplaceAllSettings={handleReplaceAllSettings}
          onResetDefaults={handleResetDefaults}
          onSelectPreset={handleSelectPreset}
          onSavePreset={handleSavePreset}
          onDuplicatePreset={handleDuplicatePreset}
          onDeletePreset={handleDeletePreset}
          onTriggerVanish={handleTriggerVanish}
          onTriggerRestore={handleTriggerRestore}
          onEmergencyRestore={handleEmergencyRestore}
          onOpenCalibration={() => setCalibrationOpen(true)}
          onOpenOnboarding={() => setOnboardingOpen(true)}
          onClearHistory={handleClearHistory}
          onDismissErrors={() => setActiveErrors([])}
          onExportDiagnostics={handleExportDiagnostics}
        />
      </main>

      <ArchitectureAndInstallSection
        onOpenOnboarding={() => setOnboardingOpen(true)}
      />

      <Footer />

      <OnboardingModal
        open={onboardingOpen}
        onComplete={() => {
          setOnboardingOpen(false);
          patchSettings({ onboardingCompleted: true });
        }}
        onRequestLiveCamera={() => setLiveCameraRequested(true)}
        onOpenCalibration={() => setCalibrationOpen(true)}
        onTriggerDemoVanish={handleTriggerVanish}
        onTriggerEmergencyRestore={handleEmergencyRestore}
      />

      <CalibrationModal
        open={calibrationOpen}
        settings={settings}
        onClose={() => setCalibrationOpen(false)}
        onSaveCalibration={(cal) => {
          patchSettings({
            sensitivity: cal.sensitivity,
            gesture: {
              ...settings.gesture,
              mode: cal.mode,
              sensitivity: cal.sensitivity,
              calibratedCollapseThresholdMm: cal.calibratedCollapseThresholdMm,
              requireAudioConfirm: cal.requireAudioConfirm,
            },
            audio: {
              ...settings.audio,
              sensitivityDb: cal.audioSensitivityDb,
            },
          });
          recordAnalyticsEvent({
            type: "calibration_completed",
            source: "dashboard",
            enabled: settings.recordActivityHistory,
          });
          setAnalytics(loadAnalytics());
          const logs = appendDiagnosticLog(
            {
              level: "info",
              code: "CALIBRATION_SAVED",
              message: `Saved calibrated profile (${cal.mode}, gate=${cal.calibratedCollapseThresholdMm}mm, sens=${cal.sensitivity})`,
            },
            settings.diagnosticLoggingEnabled,
          );
          setDiagnostics(logs);
        }}
      />
    </div>
  );
}
export default App;
