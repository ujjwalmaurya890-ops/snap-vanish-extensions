import { useEffect, useState } from "react";
import {
  Activity,
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  Clock,
  Cpu,
  Download,
  RotateCcw,
  Sliders,
  Sparkles,
  Terminal,
  Trash2,
} from "lucide-react";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  RangeControl,
  SelectField,
  StatusDot,
  Switch,
} from "./ui/DesignSystem";
import PersonalizationStudio from "../features/studio/PersonalizationStudio";
import SettingsView from "../features/settings/SettingsView";
import VanishPopup from "./VanishPopup";
import type { SnapStatus } from "./SnapStage";
import type {
  AppErrorRecord,
  DetectionDiagnosticsState,
  DiagnosticLogEntry,
  EffectPreset,
  SnapSettings,
  UsageAnalyticsSummary,
} from "../types/snapVanish";

export type WorkspaceTab = "dashboard" | "studio" | "settings" | "popup";

interface DashboardProps {
  activeTab: WorkspaceTab;
  onChangeTab: (tab: WorkspaceTab) => void;
  settings: SnapSettings;
  presets: EffectPreset[];
  activePresetId: string;
  sessionStartedAt: number;
  status: SnapStatus;
  analytics: UsageAnalyticsSummary;
  diagnostics: DiagnosticLogEntry[];
  detectionState: DetectionDiagnosticsState;
  activeErrors: AppErrorRecord[];
  liveMetrics: {
    fps: number | null;
    renderMs: number | null;
    particles: number;
  };
  liveCameraInfo: {
    active: boolean;
    resolution: string | null;
  };
  audioMonitor: {
    active: boolean;
    levelPercent: number;
    currentDb: number;
    floorDb: number;
  };
  activePlatformLabel: string;
  onPatchSettings: (patch: Partial<SnapSettings>) => void;
  onReplaceAllSettings: (
    nextSettings: SnapSettings,
    nextPresets?: EffectPreset[],
  ) => void;
  onResetDefaults: () => void;
  onSelectPreset: (preset: EffectPreset) => void;
  onSavePreset: (name: string, description: string) => void;
  onDuplicatePreset: (preset: EffectPreset) => void;
  onDeletePreset: (id: string) => void;
  onTriggerVanish: () => void;
  onPreviewEffect: () => void;
  onTriggerRestore: () => void;
  onEmergencyRestore: () => void;
  onOpenCalibration: () => void;
  onOpenOnboarding: () => void;
  onClearHistory: () => void;
  onDismissErrors: () => void;
  onExportDiagnostics: () => void;
}

function formatDurationSec(totalSec: number): string {
  const hrs = Math.floor(totalSec / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return hrs > 0
    ? `${pad(hrs)}:${pad(mins)}:${pad(secs)}`
    : `${pad(mins)}:${pad(secs)}`;
}

export default function Dashboard({
  activeTab,
  onChangeTab,
  settings,
  presets,
  activePresetId,
  sessionStartedAt,
  status,
  analytics,
  diagnostics,
  detectionState,
  activeErrors,
  liveMetrics,
  liveCameraInfo,
  audioMonitor,
  activePlatformLabel,
  onPatchSettings,
  onReplaceAllSettings,
  onResetDefaults,
  onSelectPreset,
  onSavePreset,
  onDuplicatePreset,
  onDeletePreset,
  onTriggerVanish,
  onPreviewEffect,
  onTriggerRestore,
  onEmergencyRestore,
  onOpenCalibration,
  onOpenOnboarding,
  onClearHistory,
  onDismissErrors,
  onExportDiagnostics,
}: DashboardProps) {
  const [devDiagnosticsOpen, setDevDiagnosticsOpen] = useState(false);
  const [sessionElapsedSec, setSessionElapsedSec] = useState(0);

  useEffect(() => {
    const compute = () => {
      const elapsed = Math.max(
        0,
        Math.floor((Date.now() - sessionStartedAt) / 1000),
      );
      setSessionElapsedSec(elapsed);
    };
    compute();
    const timer = window.setInterval(compute, 1000);
    return () => window.clearInterval(timer);
  }, [sessionStartedAt]);

  return (
    <div className="space-y-6">
      {activeErrors.length > 0 && (
        <div
          role="alert"
          className="flex flex-wrap items-start justify-between gap-4 rounded-2xl border border-amber-500/40 bg-amber-500/10 p-4 text-amber-100"
        >
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-400" />
            <div>
              <div className="text-[13.5px] font-semibold">
                {activeErrors[0].title}{" "}
                <span className="font-mono text-[11px] text-amber-300/80">
                  [{activeErrors[0].code}]
                </span>
              </div>
              <p className="mt-0.5 text-[12.5px] text-amber-100/85">
                {activeErrors[0].explanation}
              </p>
              <p className="mt-1 text-[11.5px] text-amber-200/75">
                Action: {activeErrors[0].recoveryLabel}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="danger" onClick={onEmergencyRestore}>
              <RotateCcw className="h-3.5 w-3.5" />
              Restore Live Camera
            </Button>
            <Button size="sm" variant="ghost" onClick={onDismissErrors}>
              Dismiss
            </Button>
          </div>
        </div>
      )}

      {/* Workspace Navigation Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-white/[0.08] bg-[#13151c] p-2">
        <div
          role="tablist"
          aria-label="Snap Vanish workspace views"
          className="flex flex-wrap items-center gap-1"
        >
          {(
            [
              { id: "dashboard", label: "Control Center" },
              { id: "studio", label: "Personalization Studio" },
              { id: "settings", label: "Settings (9 Sections)" },
              { id: "popup", label: "Extension Popup" },
            ] as Array<{ id: WorkspaceTab; label: string }>
          ).map((tab) => {
            const selected = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={selected}
                onClick={() => onChangeTab(tab.id)}
                className={`rounded-xl px-4 py-2 text-[13px] font-medium transition-all ${
                  selected
                    ? "bg-[#e0532c] text-white shadow-[0_6px_16px_-6px_rgba(224,83,44,0.65)]"
                    : "text-[#9ca3b8] hover:bg-white/[0.05] hover:text-white"
                }`}
              >
                {tab.label}
              </button>
            );
          })}
        </div>

        <div className="flex items-center gap-2 pr-2">
          <Badge tone="neutral">{activePlatformLabel}</Badge>
          <Button size="sm" variant="secondary" onClick={onOpenCalibration}>
            <Sliders className="h-3.5 w-3.5 text-[#f0623a]" />
            Calibrate Snap
          </Button>
        </div>
      </div>

      {/* TAB 1: MAIN CONTROL CENTER DASHBOARD */}
      {activeTab === "dashboard" && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
            <Card padding="lg" className="space-y-5 lg:col-span-7">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="rail text-[#ff9d80]">MAIN CONTROL PANEL</div>
                  <h2 className="mt-1 text-[19px] font-semibold text-white">
                    Studio Preview &amp; Meeting Controls
                  </h2>
                </div>
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
                    ? "Paused"
                    : status === "gone"
                      ? "Preview · Vanished"
                      : status === "idle"
                        ? "Preview · Ready"
                        : "Preview · Transitioning"}
                </Badge>
              </div>

              <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
                <Button
                  variant="primary"
                  disabled={
                    !settings.enabled ||
                    status === "vanishing" ||
                    status === "returning" ||
                    status === "gone"
                  }
                  onClick={onTriggerVanish}
                >
                  <Sparkles className="h-4 w-4" />
                  Vanish Meeting + Preview
                </Button>

                <Button
                  variant="secondary"
                  disabled={
                    !settings.enabled ||
                    status === "vanishing" ||
                    status === "returning" ||
                    status === "idle"
                  }
                  onClick={onTriggerRestore}
                >
                  Return Meeting + Preview
                </Button>

                <Button variant="danger" onClick={onEmergencyRestore}>
                  <RotateCcw className="h-4 w-4" />
                  Emergency Restore
                </Button>
              </div>

              <div className="grid grid-cols-1 gap-4 pt-1 sm:grid-cols-2">
                <SelectField
                  label="Active Disintegration Preset"
                  value={activePresetId}
                  onChange={(e) => {
                    const found = presets.find((p) => p.id === e.target.value);
                    if (found) onSelectPreset(found);
                  }}
                >
                  {presets.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} ({p.config.duration.toFixed(1)}s)
                    </option>
                  ))}
                  {activePresetId === "custom" && (
                    <option value="custom">Custom Studio Profile</option>
                  )}
                </SelectField>

                <div className="rounded-xl border border-white/[0.08] bg-[#181b23] p-3.5">
                  <div className="rail text-[#8b92a5]">
                    SNAP DETECTOR STATE MACHINE
                  </div>
                  <div className="mt-1.5 flex items-center justify-between">
                    <span className="font-mono text-[13px] font-semibold uppercase text-white">
                      {liveCameraInfo.active
                        ? detectionState.gesturePhase
                        : "standby (enable webcam)"}
                    </span>
                    <Badge
                      tone={
                        detectionState.gesturePhase === "cocked-ready"
                          ? "amber"
                          : detectionState.gesturePhase === "confirmed"
                            ? "emerald"
                            : "neutral"
                      }
                    >
                      {settings.gesture.mode}
                    </Badge>
                  </div>
                  <div className="mt-1 font-mono text-[11px] text-[#6c7284]">
                    {liveCameraInfo.active
                      ? `Hand: ${detectionState.handDetected ? "Locked" : "None"} · Dist: ${detectionState.thumbMiddleDistanceMm} mm`
                      : "Click 'Enable Live Webcam + Hand AI' under viewport"}
                  </div>
                </div>
              </div>
            </Card>

            {/* Quick Controls Card */}
            <Card padding="lg" className="space-y-4 lg:col-span-5">
              <div className="flex items-center justify-between">
                <div>
                  <div className="rail text-[#ff9d80]">QUICK CONTROLS</div>
                  <h2 className="mt-1 text-[18px] font-semibold text-white">
                    Instant Runtime Tuning
                  </h2>
                </div>
                <button
                  type="button"
                  onClick={() => onChangeTab("studio")}
                  className="font-mono text-[11px] text-[#ff9d80] hover:underline"
                >
                  Full Studio →
                </button>
              </div>

              <RangeControl
                label="Gesture Sensitivity"
                displayValue={`${settings.gesture.sensitivity}/100`}
                min={1}
                max={100}
                value={settings.gesture.sensitivity}
                onChange={(v) =>
                  onPatchSettings({
                    sensitivity: v,
                    gesture: {
                      ...settings.gesture,
                      mode: "custom",
                      sensitivity: v,
                    },
                  })
                }
              />

              <RangeControl
                label="Animation Speed"
                displayValue={`${settings.speed.toFixed(1)}×`}
                min={0.5}
                max={2.5}
                step={0.1}
                value={settings.speed}
                onChange={(v) =>
                  onPatchSettings({ speed: v, meetingMode: "custom" })
                }
              />

              <RangeControl
                label="Particle Density"
                displayValue={`${settings.density}%`}
                min={20}
                max={100}
                step={2}
                value={settings.density}
                onChange={(v) =>
                  onPatchSettings({ density: v, meetingMode: "custom" })
                }
              />

              <div className="space-y-3 border-t border-white/[0.06] pt-3">
                <Switch
                  label="Acoustic Snap Confirmation"
                  checked={
                    settings.audio.enabled && settings.gesture.requireAudioConfirm
                  }
                  onChange={(v) =>
                    onPatchSettings({
                      audio: { ...settings.audio, enabled: v },
                      gesture: { ...settings.gesture, requireAudioConfirm: v },
                    })
                  }
                />
                <Switch
                  label="Low-Power Laptop Mode"
                  checked={settings.lowPowerMode}
                  onChange={(v) =>
                    onPatchSettings({
                      lowPowerMode: v,
                      performanceProfile: v ? "low-power" : "balanced",
                    })
                  }
                />
              </div>
            </Card>
          </div>

          {/* Row 2: Performance Information + Activity Panel */}
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
            <Card padding="lg" className="space-y-4 lg:col-span-5">
              <div className="flex items-center gap-2">
                <Cpu className="h-4 w-4 text-[#f0623a]" />
                <span className="rail text-[#ff9d80]">
                  PERFORMANCE TELEMETRY (MEASURED)
                </span>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-xl border border-white/[0.07] bg-[#181b23] p-3.5">
                  <div className="font-mono text-[10.5px] uppercase text-[#8b92a5]">
                    Frame Processing Rate
                  </div>
                  <div className="mt-1 font-mono text-[18px] font-semibold tabular-nums text-white">
                    {liveMetrics.fps !== null
                      ? `${liveMetrics.fps} FPS`
                      : "Standby (no frame metrics)"}
                  </div>
                  <div className="mt-0.5 font-mono text-[10.5px] text-[#6c7284]">
                    Render:{" "}
                    {liveMetrics.renderMs !== null
                      ? `${liveMetrics.renderMs} ms`
                      : "Idle"}
                  </div>
                </div>

                <div className="rounded-xl border border-white/[0.07] bg-[#181b23] p-3.5">
                  <div className="font-mono text-[10.5px] uppercase text-[#8b92a5]">
                    Detection Latency
                  </div>
                  <div className="mt-1 font-mono text-[18px] font-semibold tabular-nums text-white">
                    {detectionState.inferenceMs !== null
                      ? `${detectionState.inferenceMs} ms`
                      : "Not Active"}
                  </div>
                  <div className="mt-0.5 font-mono text-[10.5px] text-[#6c7284]">
                    Cap: {settings.gesture.inferenceFpsLimit} Hz
                  </div>
                </div>

                <div className="rounded-xl border border-white/[0.07] bg-[#181b23] p-3.5">
                  <div className="font-mono text-[10.5px] uppercase text-[#8b92a5]">
                    CV Model Status
                  </div>
                  <div className="mt-1 font-mono text-[14px] font-semibold uppercase text-emerald-300">
                    {detectionState.modelStatus === "ready"
                      ? "Ready · WASM"
                      : detectionState.modelStatus === "loading"
                        ? `Loading (${detectionState.modelLoadProgress}%)`
                        : detectionState.modelStatus === "error"
                          ? "Load Error"
                          : "Bundled · Idle"}
                  </div>
                  <div className="mt-0.5 font-mono text-[10.5px] text-[#6c7284]">
                    21-pt HandLandmarker
                  </div>
                </div>

                <div className="rounded-xl border border-white/[0.07] bg-[#181b23] p-3.5">
                  <div className="font-mono text-[10.5px] uppercase text-[#8b92a5]">
                    Active Camera Feed
                  </div>
                  <div className="mt-1 font-mono text-[14px] font-semibold text-white">
                    {liveCameraInfo.active
                      ? liveCameraInfo.resolution ?? "Live HD"
                      : "Studio Scene (1280×720)"}
                  </div>
                  <div className="mt-0.5 font-mono text-[10.5px] text-[#6c7284]">
                    {liveMetrics.particles.toLocaleString()} pooled particles
                  </div>
                </div>
              </div>
            </Card>

            {/* Activity Panel */}
            <Card padding="lg" className="space-y-4 lg:col-span-7">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Activity className="h-4 w-4 text-[#f0623a]" />
                  <span className="rail text-[#ff9d80]">
                    SESSION ACTIVITY HISTORY (LOCAL METADATA ONLY)
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <Badge tone="neutral">
                    <Clock className="h-3 w-3" />
                    Session: {formatDurationSec(sessionElapsedSec)}
                  </Badge>
                  {analytics.events.length > 0 && (
                    <button
                      type="button"
                      onClick={onClearHistory}
                      className="inline-flex items-center gap-1 rounded-lg px-2 py-1 font-mono text-[10.5px] text-[#8b92a5] hover:bg-white/5 hover:text-red-300"
                    >
                      <Trash2 className="h-3 w-3" />
                      Clear
                    </button>
                  )}
                </div>
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div className="rounded-xl border border-white/[0.07] bg-[#181b23] px-3.5 py-2.5">
                  <div className="font-mono text-[10px] uppercase text-[#8b92a5]">
                    Vanish Count
                  </div>
                  <div className="font-mono text-[18px] font-semibold tabular-nums text-[#ff9d80]">
                    {analytics.totalActivations}
                  </div>
                </div>
                <div className="rounded-xl border border-white/[0.07] bg-[#181b23] px-3.5 py-2.5">
                  <div className="font-mono text-[10px] uppercase text-[#8b92a5]">
                    Restore Count
                  </div>
                  <div className="font-mono text-[18px] font-semibold tabular-nums text-emerald-300">
                    {analytics.successfulRestorations}
                  </div>
                </div>
                <div className="rounded-xl border border-white/[0.07] bg-[#181b23] px-3.5 py-2.5">
                  <div className="font-mono text-[10px] uppercase text-[#8b92a5]">
                    Status Events
                  </div>
                  <div className="font-mono text-[18px] font-semibold tabular-nums text-white">
                    {analytics.events.length}
                  </div>
                </div>
              </div>

              {analytics.events.length === 0 ? (
                <EmptyState
                  title="No vanish transitions recorded in this session yet"
                  description="Trigger a test vanish above or snap your fingers with Live Webcam enabled. Only timestamps and preset metadata are stored locally."
                />
              ) : (
                <div className="max-h-44 space-y-1.5 overflow-y-auto pr-1">
                  {analytics.events.slice(0, 8).map((ev) => (
                    <div
                      key={ev.id}
                      className="flex items-center justify-between gap-3 rounded-xl border border-white/[0.06] bg-[#171922] px-3.5 py-2 text-[12px]"
                    >
                      <div className="flex items-center gap-2.5">
                        <Badge
                          tone={
                            ev.type === "vanish_activated"
                              ? "ember"
                              : ev.type === "emergency_restore"
                                ? "danger"
                                : "emerald"
                          }
                        >
                          {ev.type.replace(/_/g, " ")}
                        </Badge>
                        <span className="font-medium text-[#e4e6ee]">
                          {ev.effect ?? "dust"}
                        </span>
                        {ev.source && (
                          <span className="font-mono text-[10.5px] text-[#6c7284]">
                            via {ev.source}
                          </span>
                        )}
                      </div>
                      <span className="font-mono text-[11px] tabular-nums text-[#8b92a5]">
                        {new Date(ev.timestamp).toLocaleTimeString()}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          </div>

          {/* Separate Collapsible Developer Diagnostics Panel */}
          <Card padding="none" className="overflow-hidden">
            <button
              type="button"
              onClick={() => setDevDiagnosticsOpen((v) => !v)}
              aria-expanded={devDiagnosticsOpen}
              className="flex w-full items-center justify-between px-5 py-3.5 text-left transition-colors hover:bg-white/[0.03]"
            >
              <div className="flex items-center gap-2.5">
                <Terminal className="h-4 w-4 text-[#f0623a]" />
                <span className="rail text-[#d4d7e0]">
                  DEVELOPER DIAGNOSTICS &amp; KINEMATIC INSPECTOR
                </span>
              </div>
              <div className="flex items-center gap-2 font-mono text-[11px] text-[#8b92a5]">
                <span>{devDiagnosticsOpen ? "Hide" : "Inspect"}</span>
                {devDiagnosticsOpen ? (
                  <ChevronUp className="h-4 w-4" />
                ) : (
                  <ChevronDown className="h-4 w-4" />
                )}
              </div>
            </button>

            {devDiagnosticsOpen && (
              <div className="space-y-4 border-t border-white/[0.07] bg-[#0e1016] p-5">
                <div className="grid grid-cols-2 gap-3 font-mono text-[11.5px] sm:grid-cols-4">
                  <div className="rounded-xl border border-white/[0.07] bg-[#151821] p-3">
                    <div className="text-[10px] text-[#6c7284]">
                      HAND DETECTED
                    </div>
                    <div className="mt-1 text-white">
                      {detectionState.handDetected
                        ? `YES (${detectionState.handedness ?? "Hand"})`
                        : "NO"}
                    </div>
                  </div>
                  <div className="rounded-xl border border-white/[0.07] bg-[#151821] p-3">
                    <div className="text-[10px] text-[#6c7284]">
                      LANDMARK CONFIDENCE
                    </div>
                    <div className="mt-1 text-white">
                      {(detectionState.landmarkConfidence * 100).toFixed(1)}%
                    </div>
                  </div>
                  <div className="rounded-xl border border-white/[0.07] bg-[#151821] p-3">
                    <div className="text-[10px] text-[#6c7284]">
                      THUMB–MIDDLE / VEL
                    </div>
                    <div className="mt-1 text-[#ff9d80]">
                      {detectionState.thumbMiddleDistanceMm} mm ·{" "}
                      {detectionState.approachVelocityMmPerSec} mm/s
                    </div>
                  </div>
                  <div className="rounded-xl border border-white/[0.07] bg-[#151821] p-3">
                    <div className="text-[10px] text-[#6c7284]">
                      AUDIO GATE / COOLDOWN
                    </div>
                    <div className="mt-1 text-emerald-300">
                      {audioMonitor.active
                        ? `${audioMonitor.currentDb} dB (flr ${audioMonitor.floorDb})`
                        : "Mic Idle"}{" "}
                      · {detectionState.cooldownRemainingMs}ms
                    </div>
                  </div>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-mono text-[11px] text-[#8b92a5]">
                    Last state transition reason: {detectionState.lastReason}
                  </span>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={onExportDiagnostics}
                  >
                    <Download className="h-3.5 w-3.5" />
                    Export Diagnostics JSON
                  </Button>
                </div>

                {diagnostics.length > 0 && (
                  <div className="max-h-36 space-y-1 overflow-y-auto rounded-xl border border-white/[0.06] bg-black/50 p-3 font-mono text-[11px]">
                    {diagnostics.slice(0, 12).map((d) => (
                      <div
                        key={d.id}
                        className="flex items-center justify-between gap-3 text-[#9ca3b8]"
                      >
                        <span>
                          <span className="text-[#ff9d80]">[{d.code}]</span>{" "}
                          {d.message}
                        </span>
                        <span className="shrink-0 text-[#5e6478]">
                          {new Date(d.timestamp).toLocaleTimeString()}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </Card>
        </div>
      )}

      {/* TAB 2: PERSONALIZATION STUDIO */}
      {activeTab === "studio" && (
        <PersonalizationStudio
          settings={settings}
          presets={presets}
          activePresetId={activePresetId}
          onPatchSettings={onPatchSettings}
          onSelectPreset={onSelectPreset}
          onSavePreset={onSavePreset}
          onDuplicatePreset={onDuplicatePreset}
          onDeletePreset={onDeletePreset}
          onPreviewEffect={onPreviewEffect}
        />
      )}

      {/* TAB 3: 9-SECTION SETTINGS */}
      {activeTab === "settings" && (
        <SettingsView
          settings={settings}
          presets={presets}
          audioMonitor={audioMonitor}
          onPatchSettings={onPatchSettings}
          onReplaceAllSettings={onReplaceAllSettings}
          onResetDefaults={onResetDefaults}
          onOpenCalibration={onOpenCalibration}
          onOpenOnboarding={onOpenOnboarding}
          onOpenStudioTab={() => onChangeTab("studio")}
          onClearLocalLogs={onClearHistory}
          onTestShortcutAction={(action) => {
            if (action === "toggle") {
              onPatchSettings({ enabled: !settings.enabled });
            } else if (action === "vanish") {
              onTriggerVanish();
            } else {
              onEmergencyRestore();
            }
          }}
        />
      )}

      {/* TAB 4: COMPACT EXTENSION POPUP PREVIEW */}
      {activeTab === "popup" && (
        <Card padding="lg">
          <div className="grid grid-cols-1 items-center gap-8 lg:grid-cols-12">
            <div className="space-y-3 lg:col-span-6">
              <div className="rail text-[#ff9d80]">
                CHROME TOOLBAR POPUP (EXTENSION/POPUP/*)
              </div>
              <h2 className="text-[22px] font-semibold text-white">
                Instant One-Handed Call Control
              </h2>
              <p className="text-[13.5px] leading-relaxed text-[#9ca3b8]">
                Pinned to your Chrome toolbar, the standalone Manifest V3 popup
                synchronizes bidirectionally with{" "}
                <code className="font-mono text-white">chrome.storage.sync</code>{" "}
                and active meeting content scripts. Change any control on the
                right and watch the live viewport respond immediately.
              </p>
            </div>
            <div className="lg:col-span-6">
              <VanishPopup
                enabled={settings.enabled}
                setEnabled={(v) => onPatchSettings({ enabled: v })}
                sensitivity={settings.gesture.sensitivity}
                setSensitivity={(v) =>
                  onPatchSettings({
                    sensitivity: v,
                    gesture: {
                      ...settings.gesture,
                      mode: "custom",
                      sensitivity: v,
                    },
                  })
                }
                audioConfirm={
                  settings.audio.enabled && settings.gesture.requireAudioConfirm
                }
                setAudioConfirm={(v) =>
                  onPatchSettings({
                    audio: { ...settings.audio, enabled: v },
                    gesture: { ...settings.gesture, requireAudioConfirm: v },
                  })
                }
                activePresetId={activePresetId}
                presets={presets}
                onSelectPreset={onSelectPreset}
                status={status}
                activePlatform={activePlatformLabel}
                onSnap={onTriggerVanish}
                onEmergencyRestore={onEmergencyRestore}
                onOpenSettings={() => onChangeTab("settings")}
              />
            </div>
          </div>
        </Card>
      )}
    </div>
  );
}
