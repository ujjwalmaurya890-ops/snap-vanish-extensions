import { useState } from "react";
import type {
  DiagnosticLogEntry,
  EffectPreset,
  GestureAction,
  MeetingModeId,
  SnapSettings,
  UsageAnalyticsSummary,
} from "../types/snapVanish";
import type { SnapStatus } from "./SnapStage";
import {
  MEETING_MODES,
  VALID_DIRECTIONS,
  VALID_EFFECTS,
} from "../lib/settings";
import {
  SnapGestureDetector,
  createSyntheticHandFrame,
  type SnapCandidateEvaluation,
} from "../lib/gestureEngine";
import { getWeeklyUsageSummary } from "../lib/analytics";
import {
  authenticateWithCloud,
  clearAuthSession,
  getCloudSyncStatus,
  getEntitlementState,
  loadAuthSession,
  resolvePresetSyncConflicts,
  type CloudAuthUser,
} from "../lib/cloudAndBilling";
import {
  CHANGELOG_ENTRIES,
  CURRENT_EXTENSION_VERSION,
  deleteFeedbackSubmission,
  loadFeedbackSubmissions,
  submitFeedback,
} from "../lib/feedbackAndChangelog";

export type DashboardTab =
  | "overview"
  | "studio"
  | "gestures"
  | "analytics"
  | "diagnostics"
  | "privacy"
  | "account"
  | "feedback";

interface DashboardProps {
  activeTab: DashboardTab;
  onTabChange: (tab: DashboardTab) => void;
  settings: SnapSettings;
  onUpdateSettings: (patch: Partial<SnapSettings>) => void;
  onResetSettings: () => void;
  presets: EffectPreset[];
  selectedPresetId: string;
  onSelectPreset: (preset: EffectPreset) => void;
  onCreatePreset: (name: string, description: string) => void;
  onRenamePreset: (id: string, name: string, description?: string) => void;
  onDuplicatePreset: (id: string) => void;
  onDeletePreset: (id: string) => void;
  analytics: UsageAnalyticsSummary;
  onClearAnalytics: () => void;
  diagnosticLogs: DiagnosticLogEntry[];
  onAddDiagnosticLog: (
    level: "info" | "warn" | "error",
    code: string,
    message: string,
  ) => void;
  onClearDiagnostics: () => void;
  onClearAllData: () => void;
  stageStatus: SnapStatus;
  onTriggerStage: () => void;
  onEmergencyRestore: () => void;
  onOpenOnboarding: () => void;
  liveMetrics: {
    fps: number | null;
    renderMs: number | null;
    particles: number;
  };
  extensionBridgeConnected: boolean;
}

const COLOR_SWATCHES = [
  { hex: "#d2451e", label: "Ember" },
  { hex: "#8b5cf6", label: "Violet" },
  { hex: "#3b82f6", label: "Cobalt" },
  { hex: "#10b981", label: "Emerald" },
  { hex: "#f59e0b", label: "Solar" },
  { hex: "#06b6d4", label: "Cyan" },
  { hex: "#ec4899", label: "Rose" },
];

export default function Dashboard({
  activeTab,
  onTabChange,
  settings,
  onUpdateSettings,
  onResetSettings,
  presets,
  selectedPresetId,
  onSelectPreset,
  onCreatePreset,
  onRenamePreset,
  onDuplicatePreset,
  onDeletePreset,
  analytics,
  onClearAnalytics,
  diagnosticLogs,
  onAddDiagnosticLog,
  onClearDiagnostics,
  onClearAllData,
  stageStatus,
  onTriggerStage,
  onEmergencyRestore,
  onOpenOnboarding,
  liveMetrics,
  extensionBridgeConnected,
}: DashboardProps) {
  // Preset creation & rename state
  const [newPresetName, setNewPresetName] = useState("");
  const [newPresetDesc, setNewPresetDesc] = useState("");
  const [editingPresetId, setEditingPresetId] = useState<string | null>(null);
  const [editingPresetName, setEditingPresetName] = useState("");
  const [validationNotice, setValidationNotice] = useState<string | null>(null);

  // Gesture calibration & simulation state
  const [calibrationResult, setCalibrationResult] =
    useState<SnapCandidateEvaluation | null>(null);
  const [calibrationLabel, setCalibrationLabel] = useState<string>("");

  // Cloud auth & sync state
  const [authUser, setAuthUser] = useState<CloudAuthUser | null>(() =>
    loadAuthSession(),
  );
  const [authMode, setAuthMode] = useState<"signin" | "signup">("signin");
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authStatusMsg, setAuthStatusMsg] = useState<string | null>(null);
  const [syncConflictMsg, setSyncConflictMsg] = useState<string | null>(null);

  // Feedback form state
  const [fbCategory, setFbCategory] = useState<
    "bug" | "feature" | "ux" | "general"
  >("feature");
  const [fbTitle, setFbTitle] = useState("");
  const [fbDesc, setFbDesc] = useState("");
  const [fbIncludeDiag, setFbIncludeDiag] = useState(false);
  const [fbError, setFbError] = useState<string | null>(null);
  const [fbSuccess, setFbSuccess] = useState<string | null>(null);
  const [feedbackList, setFeedbackList] = useState(() =>
    loadFeedbackSubmissions(),
  );

  const weekly = getWeeklyUsageSummary(analytics);
  const cloudStatus = getCloudSyncStatus();
  const entitlements = getEntitlementState(authUser);

  const navItems: { id: DashboardTab; label: string; badge?: string }[] = [
    { id: "overview", label: "Overview" },
    { id: "studio", label: "Effect Studio & Presets", badge: `${presets.length}` },
    { id: "gestures", label: "Gesture Studio & Modes" },
    {
      id: "analytics",
      label: "Usage Analytics",
      badge: `${analytics.totalActivations}`,
    },
    { id: "diagnostics", label: "Diagnostics & Perf" },
    { id: "privacy", label: "Privacy Center" },
    { id: "account", label: "Account, Cloud & Plans" },
    { id: "feedback", label: "Feedback & Changelog" },
  ];

  const runGestureSimulation = (
    scenario: "valid-snap" | "fast-wave" | "mug-reach" | "cooldown-double",
  ) => {
    const detector = new SnapGestureDetector(settings.gesture);
    const t0 = 1000;
    if (scenario === "valid-snap") {
      detector.evaluateLandmarks(
        createSyntheticHandFrame({ thumbMiddleDistMm: 52 }),
        t0,
      );
      const res = detector.evaluateLandmarks(
        createSyntheticHandFrame({
          thumbMiddleDistMm: Math.max(
            6,
            settings.gesture.calibratedCollapseThresholdMm - 4,
          ),
        }),
        t0 + 65,
      );
      setCalibrationResult(res);
      setCalibrationLabel(
        "Simulated clean finger snap (52mm → 8mm in 65ms, steady wrist)",
      );
    } else if (scenario === "fast-wave") {
      detector.evaluateLandmarks(
        createSyntheticHandFrame({ thumbMiddleDistMm: 50, wristOffsetRad: 0 }),
        t0,
      );
      const res = detector.evaluateLandmarks(
        createSyntheticHandFrame({
          thumbMiddleDistMm: 8,
          wristOffsetRad: 0.45,
        }),
        t0 + 40,
      );
      setCalibrationResult(res);
      setCalibrationLabel(
        "Simulated hand wave (wrist angular velocity > 2.2 rad/s)",
      );
    } else if (scenario === "mug-reach") {
      detector.evaluateLandmarks(
        createSyntheticHandFrame({ thumbMiddleDistMm: 50, bboxScale: 1.0 }),
        t0,
      );
      const res = detector.evaluateLandmarks(
        createSyntheticHandFrame({ thumbMiddleDistMm: 8, bboxScale: 1.55 }),
        t0 + 60,
      );
      setCalibrationResult(res);
      setCalibrationLabel(
        "Simulated reaching toward camera (bounding box area delta > 40%)",
      );
    } else if (scenario === "cooldown-double") {
      detector.evaluateLandmarks(
        createSyntheticHandFrame({ thumbMiddleDistMm: 52 }),
        t0,
      );
      detector.evaluateLandmarks(
        createSyntheticHandFrame({ thumbMiddleDistMm: 8 }),
        t0 + 60,
      );
      const res = detector.evaluateLandmarks(
        createSyntheticHandFrame({ thumbMiddleDistMm: 8 }),
        t0 + 250,
      );
      setCalibrationResult(res);
      setCalibrationLabel(
        "Simulated rapid second trigger 190ms after first snap (blocked by cooldown)",
      );
    }
  };

  return (
    <section
      id="dashboard"
      aria-label="Snap Vanish Companion SaaS Dashboard"
      className="border-b border-rule bg-[#0d0e14] text-[#f3f4f8]"
    >
      <div className="mx-auto max-w-[1280px] px-6 py-14 md:px-10 md:py-20">
        {/* Dashboard Header */}
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-white/10 pb-6">
          <div>
            <div className="flex items-center gap-2.5">
              <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.18em] text-violet-400">
                COMPANION SAAS WORKSPACE
              </span>
              <span className="rounded-full border border-emerald-500/35 bg-emerald-500/15 px-2.5 py-0.5 font-mono text-[10px] text-emerald-300">
                LOCAL SYNC ACTIVE
              </span>
              <span className="rounded-full border border-white/15 bg-white/5 px-2.5 py-0.5 font-mono text-[10px] text-[#9ca3b8]">
                {extensionBridgeConnected
                  ? "EXTENSION RUNTIME CONNECTED"
                  : "WEB STUDIO MODE"}
              </span>
            </div>
            <h2 className="mt-2 font-display text-[clamp(2rem,4vw,3.25rem)] leading-tight text-white">
              Snap Vanish Control Center
            </h2>
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            <button
              type="button"
              onClick={onTriggerStage}
              disabled={!settings.enabled}
              className="rounded-lg bg-violet-600 px-4 py-2.5 text-[12.5px] font-semibold text-white transition-colors hover:bg-violet-500 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {stageStatus === "gone" ? "Restore Frame" : "Trigger Vanish"}
            </button>
            <button
              type="button"
              onClick={onEmergencyRestore}
              className="rounded-lg border border-red-500/40 bg-red-500/15 px-4 py-2.5 text-[12.5px] font-semibold text-red-200 transition-colors hover:bg-red-500/25"
            >
              Emergency Restore
            </button>
            <button
              type="button"
              onClick={onOpenOnboarding}
              className="rounded-lg border border-white/15 bg-[#151722] px-3.5 py-2.5 text-[12px] font-medium text-[#c4c9db] hover:border-white/30 hover:text-white"
            >
              Setup Wizard
            </button>
          </div>
        </div>

        {/* Layout: Sidebar Nav + Active View */}
        <div className="mt-8 grid grid-cols-1 gap-8 lg:grid-cols-[240px_1fr]">
          {/* Sidebar Navigation */}
          <nav
            aria-label="Dashboard sections"
            className="flex flex-row flex-wrap gap-1.5 lg:flex-col"
          >
            {navItems.map((item) => {
              const active = activeTab === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => onTabChange(item.id)}
                  className={`flex items-center justify-between rounded-xl px-3.5 py-2.5 text-left text-[13px] font-medium transition-colors ${
                    active
                      ? "bg-violet-600 text-white shadow-sm"
                      : "bg-[#151722]/70 text-[#9ca3b8] hover:bg-[#151722] hover:text-white"
                  }`}
                >
                  <span>{item.label}</span>
                  {item.badge !== undefined && (
                    <span
                      className={`ml-2 rounded-full px-2 py-0.5 font-mono text-[10px] ${
                        active
                          ? "bg-white/20 text-white"
                          : "bg-white/10 text-[#9ca3b8]"
                      }`}
                    >
                      {item.badge}
                    </span>
                  )}
                </button>
              );
            })}
          </nav>

          {/* Content Panel */}
          <div className="min-w-0 rounded-2xl border border-white/10 bg-[#151722] p-6 md:p-8">
            {/* -------------------------------------------------- 1. OVERVIEW */}
            {activeTab === "overview" && (
              <div className="space-y-6">
                <div>
                  <h3 className="text-[18px] font-semibold text-white">
                    Workspace Overview
                  </h3>
                  <p className="mt-1 text-[13px] text-[#9ca3b8]">
                    Live synchronized status across the stage preview, popup
                    controller, and local storage.
                  </p>
                </div>

                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
                  <StatCard
                    label="Engine Status"
                    value={
                      !settings.enabled
                        ? "DISABLED"
                        : stageStatus === "idle"
                          ? "LIVE"
                          : stageStatus.toUpperCase()
                    }
                    sub={`Effect: ${settings.effect}`}
                  />
                  <StatCard
                    label="Measured Frame Rate"
                    value={
                      liveMetrics.fps !== null
                        ? `${liveMetrics.fps} FPS`
                        : "Measuring…"
                    }
                    sub={
                      liveMetrics.renderMs !== null
                        ? `${liveMetrics.renderMs} ms / frame render`
                        : "Real runtime canvas telemetry"
                    }
                  />
                  <StatCard
                    label="Total Activations"
                    value={String(analytics.totalActivations)}
                    sub={`${analytics.successfulRestorations} restorations · ${analytics.emergencyRestorations} emergency`}
                  />
                  <StatCard
                    label="Meeting Mode"
                    value={settings.meetingMode.toUpperCase()}
                    sub={`Sensitivity ${settings.sensitivity} · ${settings.gesture.cooldownMs}ms cooldown`}
                  />
                </div>

                {/* Quick Mode Switcher */}
                <div className="rounded-xl border border-white/10 bg-[#0d0e14] p-5">
                  <div className="flex items-center justify-between">
                    <h4 className="text-[14px] font-semibold text-white">
                      Smart Meeting Modes
                    </h4>
                    <span className="font-mono text-[11px] text-violet-400">
                      Click to apply real parameter profile
                    </span>
                  </div>
                  <div className="mt-3.5 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
                    {(
                      [
                        "professional",
                        "creative",
                        "minimal",
                        "low-power",
                      ] as Exclude<MeetingModeId, "custom">[]
                    ).map((modeKey) => {
                      const m = MEETING_MODES[modeKey];
                      const active = settings.meetingMode === modeKey;
                      return (
                        <button
                          key={modeKey}
                          type="button"
                          onClick={() => onUpdateSettings(m.settingsPatch)}
                          className={`flex flex-col justify-between rounded-xl border p-3.5 text-left transition-colors ${
                            active
                              ? "border-violet-500 bg-violet-600/20"
                              : "border-white/10 bg-[#151722] hover:border-white/25"
                          }`}
                        >
                          <div>
                            <div className="flex items-center justify-between">
                              <span className="font-semibold text-white">
                                {m.name}
                              </span>
                              {active && (
                                <span className="rounded bg-violet-500 px-1.5 py-0.5 font-mono text-[9px] uppercase text-white">
                                  Active
                                </span>
                              )}
                            </div>
                            <p className="mt-1 text-[11.5px] text-[#9ca3b8]">
                              {m.tagline}
                            </p>
                          </div>
                          <div className="mt-3 font-mono text-[10px] text-violet-300">
                            {m.settingsPatch.effect} ·{" "}
                            {m.settingsPatch.duration}s ·{" "}
                            {m.settingsPatch.density}% density
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Quick links */}
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                  <button
                    type="button"
                    onClick={() => onTabChange("studio")}
                    className="rounded-xl border border-white/10 bg-[#0d0e14] p-4 text-left hover:border-violet-500/50"
                  >
                    <div className="font-semibold text-violet-300">
                      Custom Effect Studio →
                    </div>
                    <p className="mt-1 text-[12px] text-[#9ca3b8]">
                      Fine-tune particle size, density, speed, color accent, and
                      manage saved presets.
                    </p>
                  </button>
                  <button
                    type="button"
                    onClick={() => onTabChange("gestures")}
                    className="rounded-xl border border-white/10 bg-[#0d0e14] p-4 text-left hover:border-violet-500/50"
                  >
                    <div className="font-semibold text-violet-300">
                      Gesture Calibration →
                    </div>
                    <p className="mt-1 text-[12px] text-[#9ca3b8]">
                      Test finger-snap detection, false-positive rejection, and
                      cooldown settings.
                    </p>
                  </button>
                  <button
                    type="button"
                    onClick={() => onTabChange("diagnostics")}
                    className="rounded-xl border border-white/10 bg-[#0d0e14] p-4 text-left hover:border-violet-500/50"
                  >
                    <div className="font-semibold text-violet-300">
                      System Diagnostics →
                    </div>
                    <p className="mt-1 text-[12px] text-[#9ca3b8]">
                      Inspect real FPS, render latency, WebGL2 support, and
                      resource cleanup states.
                    </p>
                  </button>
                </div>
              </div>
            )}

            {/* -------------------------------------------------- 2. EFFECT STUDIO */}
            {activeTab === "studio" && (
              <div className="space-y-6">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h3 className="text-[18px] font-semibold text-white">
                      Custom Effect Studio
                    </h3>
                    <p className="mt-1 text-[13px] text-[#9ca3b8]">
                      Every control modifies the live canvas engine and persists
                      automatically.
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={onTriggerStage}
                      className="rounded-lg bg-violet-600 px-3.5 py-2 text-[12px] font-semibold text-white hover:bg-violet-500"
                    >
                      Preview Effect on Stage
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        onResetSettings();
                        setValidationNotice("Reset all parameters to factory defaults.");
                      }}
                      className="rounded-lg border border-white/15 px-3.5 py-2 text-[12px] text-[#9ca3b8] hover:border-white/30 hover:text-white"
                    >
                      Reset to Defaults
                    </button>
                  </div>
                </div>

                {validationNotice && (
                  <div className="rounded-lg border border-violet-500/40 bg-violet-500/10 px-4 py-2.5 text-[12px] text-violet-200">
                    {validationNotice}
                  </div>
                )}

                {/* Effect Type & Direction */}
                <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
                  <div className="rounded-xl border border-white/10 bg-[#0d0e14] p-4">
                    <label className="block text-[12px] font-semibold uppercase tracking-wider text-[#9ca3b8]">
                      1. Visual Effect Algorithm
                    </label>
                    <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
                      {VALID_EFFECTS.map((ef) => (
                        <button
                          key={ef}
                          type="button"
                          onClick={() =>
                            onUpdateSettings({
                              effect: ef,
                              meetingMode: "custom",
                            })
                          }
                          className={`rounded-lg border px-3 py-2 text-left text-[12.5px] font-medium transition-colors ${
                            settings.effect === ef
                              ? "border-violet-500 bg-violet-600/25 text-white"
                              : "border-white/10 bg-[#151722] text-[#9ca3b8] hover:text-white"
                          }`}
                        >
                          {ef}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="rounded-xl border border-white/10 bg-[#0d0e14] p-4">
                    <label className="block text-[12px] font-semibold uppercase tracking-wider text-[#9ca3b8]">
                      2. Vector Drift Direction &amp; Color Accent
                    </label>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {VALID_DIRECTIONS.map((dir) => (
                        <button
                          key={dir}
                          type="button"
                          onClick={() =>
                            onUpdateSettings({
                              direction: dir,
                              meetingMode: "custom",
                            })
                          }
                          className={`rounded-lg border px-3 py-1.5 text-[12px] font-medium capitalize ${
                            settings.direction === dir
                              ? "border-violet-500 bg-violet-600 text-white"
                              : "border-white/10 bg-[#151722] text-[#9ca3b8]"
                          }`}
                        >
                          {dir}
                        </button>
                      ))}
                    </div>

                    <div className="mt-4 flex flex-wrap items-center gap-2">
                      {COLOR_SWATCHES.map((sw) => (
                        <button
                          key={sw.hex}
                          type="button"
                          onClick={() =>
                            onUpdateSettings({
                              colorAccent: sw.hex,
                              meetingMode: "custom",
                            })
                          }
                          aria-label={`Select color ${sw.label}`}
                          className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[11px] ${
                            settings.colorAccent.toLowerCase() === sw.hex
                              ? "border-white bg-white/15 text-white"
                              : "border-white/10 bg-[#151722] text-[#9ca3b8]"
                          }`}
                        >
                          <span
                            className="h-3 w-3 rounded-full"
                            style={{ backgroundColor: sw.hex }}
                          />
                          {sw.label}
                        </button>
                      ))}
                      <input
                        type="color"
                        aria-label="Custom hex color accent"
                        value={settings.colorAccent}
                        onChange={(e) =>
                          onUpdateSettings({
                            colorAccent: e.target.value,
                            meetingMode: "custom",
                          })
                        }
                        className="h-7 w-9 cursor-pointer rounded border border-white/20 bg-transparent"
                      />
                    </div>
                  </div>
                </div>

                {/* Parameter Sliders */}
                <div className="grid grid-cols-1 gap-5 rounded-xl border border-white/10 bg-[#0d0e14] p-5 sm:grid-cols-2 lg:grid-cols-3">
                  <StudioSlider
                    label="Particle Size"
                    value={settings.particleSize}
                    min={0.5}
                    max={3.0}
                    step={0.1}
                    display={`${settings.particleSize.toFixed(1)}×`}
                    onChange={(v) =>
                      onUpdateSettings({
                        particleSize: v,
                        meetingMode: "custom",
                      })
                    }
                  />
                  <StudioSlider
                    label="Particle / Block Density"
                    value={settings.density}
                    min={20}
                    max={100}
                    step={5}
                    display={`${settings.density}%`}
                    onChange={(v) =>
                      onUpdateSettings({ density: v, meetingMode: "custom" })
                    }
                  />
                  <StudioSlider
                    label="Animation Duration"
                    value={settings.duration}
                    min={0.5}
                    max={4.0}
                    step={0.1}
                    display={`${settings.duration.toFixed(1)} s`}
                    onChange={(v) =>
                      onUpdateSettings({ duration: v, meetingMode: "custom" })
                    }
                  />
                  <StudioSlider
                    label="Animation Speed"
                    value={settings.speed}
                    min={0.5}
                    max={2.5}
                    step={0.1}
                    display={`${settings.speed.toFixed(1)}×`}
                    onChange={(v) =>
                      onUpdateSettings({ speed: v, meetingMode: "custom" })
                    }
                  />
                  <StudioSlider
                    label="Effect Intensity"
                    value={settings.intensity}
                    min={10}
                    max={100}
                    step={5}
                    display={`${settings.intensity}%`}
                    onChange={(v) =>
                      onUpdateSettings({ intensity: v, meetingMode: "custom" })
                    }
                  />
                  <div className="flex flex-col justify-center gap-2">
                    <label className="flex items-center gap-2 text-[12.5px] text-[#c4c9db]">
                      <input
                        type="checkbox"
                        checked={settings.lowPowerMode}
                        onChange={(e) =>
                          onUpdateSettings({ lowPowerMode: e.target.checked })
                        }
                        className="h-4 w-4 accent-violet-500"
                      />
                      Low-Power optimization (caps density at 35%)
                    </label>
                    <label className="flex items-center gap-2 text-[12.5px] text-[#c4c9db]">
                      <input
                        type="checkbox"
                        checked={settings.sound}
                        onChange={(e) =>
                          onUpdateSettings({ sound: e.target.checked })
                        }
                        className="h-4 w-4 accent-violet-500"
                      />
                      Synthesize snap click sound
                    </label>
                  </div>
                </div>

                {/* Preset Manager */}
                <div className="rounded-xl border border-white/10 bg-[#0d0e14] p-5">
                  <h4 className="text-[15px] font-semibold text-white">
                    Preset Library ({presets.length} Presets)
                  </h4>
                  <p className="mt-1 text-[12px] text-[#9ca3b8]">
                    Save your current Effect Studio configuration as a reusable
                    preset, or duplicate/rename/delete existing presets.
                  </p>

                  {/* Save new preset form */}
                  <div className="mt-4 flex flex-wrap items-center gap-2.5">
                    <input
                      type="text"
                      placeholder="New preset name (e.g. Neon Exit)"
                      value={newPresetName}
                      onChange={(e) => setNewPresetName(e.target.value)}
                      className="rounded-lg border border-white/15 bg-[#151722] px-3 py-2 text-[12.5px] text-white placeholder-[#687089]"
                    />
                    <input
                      type="text"
                      placeholder="Short description"
                      value={newPresetDesc}
                      onChange={(e) => setNewPresetDesc(e.target.value)}
                      className="flex-1 rounded-lg border border-white/15 bg-[#151722] px-3 py-2 text-[12.5px] text-white placeholder-[#687089]"
                    />
                    <button
                      type="button"
                      onClick={() => {
                        if (!newPresetName.trim()) {
                          setValidationNotice("Please enter a preset name before saving.");
                          return;
                        }
                        onCreatePreset(newPresetName, newPresetDesc);
                        setNewPresetName("");
                        setNewPresetDesc("");
                        setValidationNotice("Saved new custom preset to local storage.");
                      }}
                      className="rounded-lg bg-emerald-600 px-4 py-2 text-[12.5px] font-semibold text-white hover:bg-emerald-500"
                    >
                      + Save Current as Preset
                    </button>
                  </div>

                  {/* Preset cards */}
                  <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">
                    {presets.map((p) => {
                      const isSelected = selectedPresetId === p.id;
                      const isEditing = editingPresetId === p.id;
                      return (
                        <div
                          key={p.id}
                          className={`rounded-xl border p-3.5 transition-colors ${
                            isSelected
                              ? "border-violet-500 bg-violet-600/15"
                              : "border-white/10 bg-[#151722]"
                          }`}
                        >
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0 flex-1">
                              {isEditing ? (
                                <div className="flex items-center gap-2">
                                  <input
                                    type="text"
                                    value={editingPresetName}
                                    onChange={(e) =>
                                      setEditingPresetName(e.target.value)
                                    }
                                    className="w-full rounded border border-violet-400 bg-[#0d0e14] px-2 py-1 text-[12.5px] text-white"
                                  />
                                  <button
                                    type="button"
                                    onClick={() => {
                                      onRenamePreset(p.id, editingPresetName);
                                      setEditingPresetId(null);
                                    }}
                                    className="rounded bg-emerald-600 px-2 py-1 text-[11px] font-semibold text-white"
                                  >
                                    Save
                                  </button>
                                </div>
                              ) : (
                                <div className="flex items-center gap-2">
                                  <span className="truncate font-semibold text-white">
                                    {p.name}
                                  </span>
                                  {p.isBuiltIn && (
                                    <span className="rounded bg-white/10 px-1.5 py-0.5 font-mono text-[9.5px] text-[#9ca3b8]">
                                      BUILT-IN
                                    </span>
                                  )}
                                </div>
                              )}
                              <p className="mt-1 text-[11.5px] text-[#9ca3b8]">
                                {p.description}
                              </p>
                              <div className="mt-2 font-mono text-[10.5px] text-violet-300">
                                {p.config.effect} · {p.config.direction} ·{" "}
                                {p.config.duration}s · {p.config.density}%
                              </div>
                            </div>
                            <span
                              className="h-4 w-4 shrink-0 rounded-full border border-white/20"
                              style={{ backgroundColor: p.config.colorAccent }}
                            />
                          </div>

                          <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-white/10 pt-2.5">
                            <button
                              type="button"
                              onClick={() => onSelectPreset(p)}
                              className="rounded bg-violet-600 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-violet-500"
                            >
                              Apply Preset
                            </button>
                            <button
                              type="button"
                              onClick={() => onDuplicatePreset(p.id)}
                              className="rounded border border-white/15 px-2.5 py-1 text-[11px] text-[#c4c9db] hover:border-white/30 hover:text-white"
                            >
                              Duplicate
                            </button>
                            {!p.isBuiltIn && (
                              <>
                                <button
                                  type="button"
                                  onClick={() => {
                                    setEditingPresetId(p.id);
                                    setEditingPresetName(p.name);
                                  }}
                                  className="rounded border border-white/15 px-2.5 py-1 text-[11px] text-[#c4c9db] hover:border-white/30 hover:text-white"
                                >
                                  Rename
                                </button>
                                <button
                                  type="button"
                                  onClick={() => onDeletePreset(p.id)}
                                  className="rounded border border-red-500/30 bg-red-500/10 px-2.5 py-1 text-[11px] text-red-300 hover:bg-red-500/20"
                                >
                                  Delete
                                </button>
                              </>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}

            {/* -------------------------------------------------- 3. GESTURE STUDIO */}
            {activeTab === "gestures" && (
              <div className="space-y-6">
                <div>
                  <h3 className="text-[18px] font-semibold text-white">
                    Gesture Studio &amp; Calibration
                  </h3>
                  <p className="mt-1 text-[13px] text-[#9ca3b8]">
                    Configure finger-snap detection thresholds, cooldown window,
                    accidental-trigger protection, and test the real landmark
                    evaluation algorithm.
                  </p>
                </div>

                <div className="grid grid-cols-1 gap-5 rounded-xl border border-white/10 bg-[#0d0e14] p-5 sm:grid-cols-2">
                  <StudioSlider
                    label="Snap Detection Sensitivity (Higher = Stricter)"
                    value={settings.sensitivity}
                    min={0}
                    max={100}
                    step={1}
                    display={`${settings.sensitivity} / 100`}
                    onChange={(v) =>
                      onUpdateSettings({
                        sensitivity: v,
                        gesture: { ...settings.gesture, sensitivity: v },
                      })
                    }
                  />
                  <StudioSlider
                    label="Trigger Cooldown Protection"
                    value={settings.gesture.cooldownMs}
                    min={500}
                    max={10000}
                    step={250}
                    display={`${(settings.gesture.cooldownMs / 1000).toFixed(2)} s`}
                    onChange={(v) =>
                      onUpdateSettings({
                        gesture: { ...settings.gesture, cooldownMs: v },
                      })
                    }
                  />
                  <StudioSlider
                    label="Calibrated Thumb-Middle Collapse Threshold"
                    value={settings.gesture.calibratedCollapseThresholdMm}
                    min={6}
                    max={25}
                    step={0.5}
                    display={`${settings.gesture.calibratedCollapseThresholdMm} mm`}
                    onChange={(v) =>
                      onUpdateSettings({
                        gesture: {
                          ...settings.gesture,
                          calibratedCollapseThresholdMm: v,
                        },
                      })
                    }
                  />

                  <div>
                    <label className="mb-1.5 block text-[12px] font-medium text-[#9ca3b8]">
                      Gesture-to-Action Mapping
                    </label>
                    <select
                      value={settings.gesture.actionMapping}
                      onChange={(e) =>
                        onUpdateSettings({
                          gesture: {
                            ...settings.gesture,
                            actionMapping: e.target.value as GestureAction,
                          },
                        })
                      }
                      className="w-full rounded-lg border border-white/15 bg-[#151722] px-3 py-2 text-[12.5px] text-white"
                    >
                      <option value="toggle-vanish">
                        Toggle Vanish / Restore
                      </option>
                      <option value="vanish-only">
                        Vanish Only (Manual Restore)
                      </option>
                      <option value="restore-only">Restore Only</option>
                      <option value="mute-only">Toggle Microphone Mute</option>
                    </select>
                  </div>

                  <label className="flex items-center gap-2.5 text-[12.5px] text-[#c4c9db]">
                    <input
                      type="checkbox"
                      checked={settings.gesture.accidentalTriggerProtection}
                      onChange={(e) =>
                        onUpdateSettings({
                          gesture: {
                            ...settings.gesture,
                            accidentalTriggerProtection: e.target.checked,
                          },
                        })
                      }
                      className="h-4 w-4 accent-violet-500"
                    />
                    Reject fast wrist waves (&gt;2.2 rad/s) &amp; reaching (&gt;40% bbox jump)
                  </label>

                  <label className="flex items-center gap-2.5 text-[12.5px] text-[#c4c9db]">
                    <input
                      type="checkbox"
                      checked={settings.gesture.requireAudioConfirm}
                      onChange={(e) =>
                        onUpdateSettings({
                          gesture: {
                            ...settings.gesture,
                            requireAudioConfirm: e.target.checked,
                          },
                        })
                      }
                      className="h-4 w-4 accent-violet-500"
                    />
                    Require 2.5–5.5 kHz acoustic transient confirmation
                  </label>
                </div>

                {/* Interactive Algorithm Verification & Calibration Harness */}
                <div className="rounded-xl border border-white/10 bg-[#0d0e14] p-5">
                  <h4 className="text-[15px] font-semibold text-white">
                    Gesture Detection Calibration &amp; Verification Harness
                  </h4>
                  <p className="mt-1 text-[12px] text-[#9ca3b8]">
                    Run real 21-landmark trajectories through{" "}
                    <code className="text-violet-300">SnapGestureDetector</code>{" "}
                    using your current sensitivity ({settings.sensitivity}) and
                    collapse threshold (
                    {settings.gesture.calibratedCollapseThresholdMm} mm) to
                    verify true positives and false-positive rejection:
                  </p>

                  <div className="mt-4 flex flex-wrap gap-2.5">
                    <button
                      type="button"
                      onClick={() => runGestureSimulation("valid-snap")}
                      className="rounded-lg bg-emerald-600/25 border border-emerald-500/40 px-3.5 py-2 text-[12px] font-semibold text-emerald-200 hover:bg-emerald-600/35"
                    >
                      Test Valid Finger Snap
                    </button>
                    <button
                      type="button"
                      onClick={() => runGestureSimulation("fast-wave")}
                      className="rounded-lg bg-amber-600/20 border border-amber-500/40 px-3.5 py-2 text-[12px] font-semibold text-amber-200 hover:bg-amber-600/30"
                    >
                      Test Hand Wave (False Positive Check)
                    </button>
                    <button
                      type="button"
                      onClick={() => runGestureSimulation("mug-reach")}
                      className="rounded-lg bg-amber-600/20 border border-amber-500/40 px-3.5 py-2 text-[12px] font-semibold text-amber-200 hover:bg-amber-600/30"
                    >
                      Test Mug Reach (BBox Delta Check)
                    </button>
                    <button
                      type="button"
                      onClick={() => runGestureSimulation("cooldown-double")}
                      className="rounded-lg bg-violet-600/20 border border-violet-500/40 px-3.5 py-2 text-[12px] font-semibold text-violet-200 hover:bg-violet-600/30"
                    >
                      Test Rapid Double-Trigger (Cooldown Check)
                    </button>
                  </div>

                  {calibrationResult && (
                    <div className="mt-4 rounded-xl border border-white/10 bg-[#151722] p-4 font-mono text-[12px]">
                      <div className="text-[#9ca3b8]">{calibrationLabel}</div>
                      <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
                        <div>
                          <span className="text-[#687089]">Triggered:</span>{" "}
                          <span
                            className={
                              calibrationResult.triggered
                                ? "font-bold text-emerald-400"
                                : "font-bold text-amber-400"
                            }
                          >
                            {String(calibrationResult.triggered).toUpperCase()}
                          </span>
                        </div>
                        <div>
                          <span className="text-[#687089]">Reason:</span>{" "}
                          <span className="text-white">
                            {calibrationResult.reason}
                          </span>
                        </div>
                        <div>
                          <span className="text-[#687089]">Thumb–Mid:</span>{" "}
                          <span className="text-white">
                            {calibrationResult.thumbMiddleDistance.toFixed(1)}{" "}
                            mm
                          </span>
                        </div>
                        <div>
                          <span className="text-[#687089]">Wrist ω:</span>{" "}
                          <span className="text-white">
                            {calibrationResult.wristOmega.toFixed(2)} rad/s
                          </span>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* -------------------------------------------------- 4. USAGE ANALYTICS */}
            {activeTab === "analytics" && (
              <div className="space-y-6">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h3 className="text-[18px] font-semibold text-white">
                      Personal Usage Analytics (100% Local)
                    </h3>
                    <p className="mt-1 text-[13px] text-[#9ca3b8]">
                      All metrics reflect real events recorded in this browser.
                      No video, audio, or browsing history is ever collected.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={onClearAnalytics}
                    className="rounded-lg border border-red-500/35 bg-red-500/15 px-3.5 py-2 text-[12px] font-semibold text-red-200 hover:bg-red-500/25"
                  >
                    Clear Analytics Data
                  </button>
                </div>

                <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                  <StatCard
                    label="Effect Activations"
                    value={String(analytics.totalActivations)}
                    sub="Measured local vanish triggers"
                  />
                  <StatCard
                    label="Restorations"
                    value={String(analytics.successfulRestorations)}
                    sub={`${analytics.emergencyRestorations} via Emergency Restore`}
                  />
                  <StatCard
                    label="Failed / Blocked"
                    value={String(
                      analytics.failedTriggers + analytics.cooldownBlocks,
                    )}
                    sub={`${analytics.cooldownBlocks} cooldown blocks`}
                  />
                  <StatCard
                    label="7-Day Total"
                    value={String(weekly.totalWeekActivations)}
                    sub={
                      weekly.mostUsedEffect
                        ? `Top effect: ${weekly.mostUsedEffect}`
                        : "No effects triggered yet"
                    }
                  />
                </div>

                {/* 7-day bar chart */}
                <div className="rounded-xl border border-white/10 bg-[#0d0e14] p-5">
                  <h4 className="text-[14px] font-semibold text-white">
                    7-Day Activation Summary
                  </h4>
                  <div className="mt-4 grid grid-cols-7 gap-3">
                    {weekly.days.map((d) => {
                      const maxDay = Math.max(
                        1,
                        ...weekly.days.map((x) => x.activations),
                      );
                      const pct = Math.round((d.activations / maxDay) * 100);
                      return (
                        <div
                          key={d.date}
                          className="flex flex-col items-center gap-1.5"
                        >
                          <div className="flex h-24 w-full items-end justify-center rounded-lg bg-[#151722] p-1.5">
                            <div
                              className="w-full rounded bg-violet-500 transition-all"
                              style={{ height: `${Math.max(6, pct)}%` }}
                            />
                          </div>
                          <span className="font-mono text-[11px] font-semibold text-white">
                            {d.activations}
                          </span>
                          <span className="text-[10.5px] text-[#9ca3b8]">
                            {d.label}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* Effect usage breakdown */}
                <div className="rounded-xl border border-white/10 bg-[#0d0e14] p-5">
                  <h4 className="text-[14px] font-semibold text-white">
                    Activations by Effect Type
                  </h4>
                  <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-5">
                    {VALID_EFFECTS.map((ef) => (
                      <div
                        key={ef}
                        className="rounded-lg border border-white/10 bg-[#151722] p-3"
                      >
                        <div className="font-mono text-[11px] text-[#9ca3b8]">
                          {ef}
                        </div>
                        <div className="mt-1 font-mono text-[20px] font-semibold text-white">
                          {analytics.effectCounts[ef] ?? 0}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {/* -------------------------------------------------- 5. DIAGNOSTICS */}
            {activeTab === "diagnostics" && (
              <div className="space-y-6">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h3 className="text-[18px] font-semibold text-white">
                      Performance &amp; Compatibility Diagnostics
                    </h3>
                    <p className="mt-1 text-[13px] text-[#9ca3b8]">
                      Real measured frame timing and runtime capability status.
                      No fabricated CPU usage metrics.
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() =>
                        onAddDiagnosticLog(
                          "info",
                          "MANUAL_CHECK",
                          `Diagnostic check: FPS=${liveMetrics.fps ?? "n/a"}, RenderMs=${liveMetrics.renderMs ?? "n/a"}, Effect=${settings.effect}`,
                        )
                      }
                      className="rounded-lg bg-violet-600 px-3.5 py-2 text-[12px] font-semibold text-white hover:bg-violet-500"
                    >
                      Record Diagnostic Snapshot
                    </button>
                    <button
                      type="button"
                      onClick={onClearDiagnostics}
                      className="rounded-lg border border-white/15 px-3.5 py-2 text-[12px] text-[#9ca3b8] hover:text-white"
                    >
                      Clear Log History
                    </button>
                  </div>
                </div>

                <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                  <StatCard
                    label="Measured Canvas FPS"
                    value={
                      liveMetrics.fps !== null
                        ? `${liveMetrics.fps} FPS`
                        : "Awaiting frames"
                    }
                    sub="Measured via requestAnimationFrame delta"
                  />
                  <StatCard
                    label="Frame Render Latency"
                    value={
                      liveMetrics.renderMs !== null
                        ? `${liveMetrics.renderMs} ms`
                        : "Awaiting frames"
                    }
                    sub="Measured per-frame 2D canvas draw time"
                  />
                  <StatCard
                    label="Active Particle / Block Count"
                    value={liveMetrics.particles.toLocaleString()}
                    sub={
                      settings.lowPowerMode
                        ? "Low-Power cap active (35%)"
                        : `${settings.density}% density setting`
                    }
                  />
                </div>

                {/* Honest Limitation & Interception Notice */}
                <div className="rounded-xl border border-amber-500/35 bg-amber-500/10 p-4 text-[12.5px] text-amber-100">
                  <div className="font-semibold text-amber-300">
                    Camera Stream &amp; WebRTC Interception Disclosure
                  </div>
                  <p className="mt-1 leading-relaxed">
                    In this web studio view, animations run in{" "}
                    <strong>Local Preview Mode</strong> on the calibration
                    canvas. When loaded as an unpacked Chrome extension on{" "}
                    <code className="text-white">meet.google.com</code>,{" "}
                    <code className="text-white">teams.microsoft.com</code>, or{" "}
                    <code className="text-white">zoom.us</code>, the content
                    script attaches a synchronized DOM canvas overlay over the
                    call video element and reports{" "}
                    <code className="text-white">dom-overlay</code> or{" "}
                    <code className="text-white">webrtc-sender</code> honestly.
                  </p>
                </div>

                {/* Diagnostic Log Table */}
                <div className="rounded-xl border border-white/10 bg-[#0d0e14] p-5">
                  <h4 className="text-[14px] font-semibold text-white">
                    Local Diagnostic Log ({diagnosticLogs.length} entries)
                  </h4>
                  {diagnosticLogs.length === 0 ? (
                    <p className="mt-3 text-[12.5px] text-[#687089]">
                      No diagnostic events logged yet.
                    </p>
                  ) : (
                    <div className="mt-3 max-h-60 space-y-2 overflow-y-auto font-mono text-[11.5px]">
                      {diagnosticLogs.map((log) => (
                        <div
                          key={log.id}
                          className="flex flex-wrap items-baseline gap-2 rounded border border-white/10 bg-[#151722] px-3 py-2"
                        >
                          <span className="text-[#687089]">
                            {log.timestamp.slice(11, 19)}
                          </span>
                          <span
                            className={`uppercase ${
                              log.level === "error"
                                ? "text-red-400"
                                : log.level === "warn"
                                  ? "text-amber-300"
                                  : "text-emerald-300"
                            }`}
                          >
                            [{log.level}]
                          </span>
                          <span className="text-violet-300">{log.code}</span>
                          <span className="text-white">{log.message}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* -------------------------------------------------- 6. PRIVACY CENTER */}
            {activeTab === "privacy" && (
              <div className="space-y-6">
                <div>
                  <h3 className="text-[18px] font-semibold text-white">
                    Privacy Center &amp; Data Controls
                  </h3>
                  <p className="mt-1 text-[13px] text-[#9ca3b8]">
                    Default-local architecture: camera frames, background
                    plates, and microphone audio transients are processed
                    exclusively inside your browser tab and never uploaded.
                  </p>
                </div>

                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                  <div className="rounded-xl border border-white/10 bg-[#0d0e14] p-5">
                    <h4 className="text-[14px] font-semibold text-emerald-300">
                      What Stays 100% Local
                    </h4>
                    <ul className="mt-2.5 space-y-2 text-[12.5px] text-[#c4c9db]">
                      <li>
                        • Webcam video frames, alpha mattes, and background
                        plates (ephemeral in-memory Canvas buffers only).
                      </li>
                      <li>
                        • Microphone 2.5–5.5 kHz RMS transient analysis
                        (ephemeral 512-sample Float32Array; never recorded).
                      </li>
                      <li>
                        • Effect Studio settings, custom presets, usage
                        counters, and diagnostic logs (stored in browser{" "}
                        <code>localStorage</code> /{" "}
                        <code>chrome.storage.sync</code>).
                      </li>
                    </ul>
                  </div>

                  <div className="rounded-xl border border-white/10 bg-[#0d0e14] p-5">
                    <h4 className="text-[14px] font-semibold text-violet-300">
                      Optional Cloud Features Status
                    </h4>
                    <div className="mt-2.5 flex items-center gap-2">
                      <span className="rounded bg-amber-500/20 px-2 py-0.5 font-mono text-[11px] font-semibold text-amber-300">
                        {cloudStatus.statusLabel}
                      </span>
                    </div>
                    <p className="mt-2 text-[12.5px] text-[#9ca3b8]">
                      {cloudStatus.reason}
                    </p>
                  </div>
                </div>

                {/* Data Deletion Controls */}
                <div className="rounded-xl border border-red-500/30 bg-[#0d0e14] p-5">
                  <h4 className="text-[14px] font-semibold text-white">
                    Immediate Local Data Deletion Controls
                  </h4>
                  <p className="mt-1 text-[12px] text-[#9ca3b8]">
                    Delete specific local records or wipe all Snap Vanish state
                    back to factory defaults.
                  </p>
                  <div className="mt-4 flex flex-wrap gap-3">
                    <button
                      type="button"
                      onClick={onClearAnalytics}
                      className="rounded-lg border border-white/15 bg-[#151722] px-3.5 py-2 text-[12px] text-white hover:border-white/30"
                    >
                      Delete Usage Analytics
                    </button>
                    <button
                      type="button"
                      onClick={onClearDiagnostics}
                      className="rounded-lg border border-white/15 bg-[#151722] px-3.5 py-2 text-[12px] text-white hover:border-white/30"
                    >
                      Delete Diagnostic Logs
                    </button>
                    <button
                      type="button"
                      onClick={onClearAllData}
                      className="rounded-lg border border-red-500/50 bg-red-600/20 px-4 py-2 text-[12px] font-semibold text-red-200 hover:bg-red-600/30"
                    >
                      Wipe All Local Data &amp; Reset Extension
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* -------------------------------------------------- 7. ACCOUNT, CLOUD & PLANS */}
            {activeTab === "account" && (
              <div className="space-y-6">
                <div>
                  <h3 className="text-[18px] font-semibold text-white">
                    Account, Cloud Sync &amp; Subscription Plans
                  </h3>
                  <p className="mt-1 text-[13px] text-[#9ca3b8]">
                    Honest entitlement and backend status. No simulated logins
                    or fake payment checkboxes.
                  </p>
                </div>

                {/* Backend Status Banner */}
                <div className="rounded-xl border border-amber-500/35 bg-amber-500/10 p-4">
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-amber-300">
                      Cloud Sync &amp; Billing Backend Status:{" "}
                      {cloudStatus.statusLabel}
                    </span>
                    <span className="font-mono text-[11px] text-amber-200">
                      Verification: {entitlements.verificationSource}
                    </span>
                  </div>
                  <p className="mt-1 text-[12.5px] text-amber-100/90">
                    {cloudStatus.reason}
                  </p>
                </div>

                {/* Auth Panel */}
                <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
                  <div className="rounded-xl border border-white/10 bg-[#0d0e14] p-5">
                    <h4 className="text-[15px] font-semibold text-white">
                      Supabase Cloud Account
                    </h4>
                    {authUser ? (
                      <div className="mt-3 space-y-3">
                        <div className="text-[13px] text-emerald-300">
                          Signed in as <strong>{authUser.email}</strong>
                        </div>
                        <button
                          type="button"
                          onClick={() => {
                            clearAuthSession();
                            setAuthUser(null);
                            setAuthStatusMsg("Signed out and cleared local session token.");
                          }}
                          className="rounded-lg border border-white/15 px-3.5 py-2 text-[12px] text-white"
                        >
                          Sign Out
                        </button>
                      </div>
                    ) : (
                      <form
                        className="mt-3 space-y-3"
                        onSubmit={async (e) => {
                          e.preventDefault();
                          const res = await authenticateWithCloud({
                            mode: authMode,
                            email: authEmail,
                            password: authPassword,
                          });
                          setAuthStatusMsg(`[${res.status}] ${res.message}`);
                          if (res.user) setAuthUser(res.user);
                        }}
                      >
                        <div className="flex gap-2">
                          <button
                            type="button"
                            onClick={() => setAuthMode("signin")}
                            className={`rounded px-2.5 py-1 text-[11.5px] ${
                              authMode === "signin"
                                ? "bg-violet-600 text-white"
                                : "bg-[#151722] text-[#9ca3b8]"
                            }`}
                          >
                            Sign In
                          </button>
                          <button
                            type="button"
                            onClick={() => setAuthMode("signup")}
                            className={`rounded px-2.5 py-1 text-[11.5px] ${
                              authMode === "signup"
                                ? "bg-violet-600 text-white"
                                : "bg-[#151722] text-[#9ca3b8]"
                            }`}
                          >
                            Create Account
                          </button>
                        </div>
                        <input
                          type="email"
                          placeholder="you@company.com"
                          value={authEmail}
                          onChange={(e) => setAuthEmail(e.target.value)}
                          className="w-full rounded-lg border border-white/15 bg-[#151722] px-3 py-2 text-[12.5px] text-white"
                        />
                        <input
                          type="password"
                          placeholder="Password (min 8 characters)"
                          value={authPassword}
                          onChange={(e) => setAuthPassword(e.target.value)}
                          className="w-full rounded-lg border border-white/15 bg-[#151722] px-3 py-2 text-[12.5px] text-white"
                        />
                        <button
                          type="submit"
                          className="w-full rounded-lg bg-violet-600 py-2 text-[12.5px] font-semibold text-white hover:bg-violet-500"
                        >
                          {authMode === "signin"
                            ? "Sign In via Supabase"
                            : "Register via Supabase"}
                        </button>
                        {authStatusMsg && (
                          <div className="rounded border border-white/10 bg-[#151722] p-2.5 text-[11.5px] text-amber-200">
                            {authStatusMsg}
                          </div>
                        )}
                      </form>
                    )}

                    {/* Deterministic Conflict Resolver Check */}
                    <div className="mt-4 border-t border-white/10 pt-3">
                      <button
                        type="button"
                        onClick={() => {
                          const result = resolvePresetSyncConflicts(
                            presets,
                            presets,
                          );
                          setSyncConflictMsg(
                            `Verified deterministic timestamp conflict resolver across ${result.merged.length} presets (${result.conflictsResolved} timestamp conflicts needed).`,
                          );
                        }}
                        className="text-[11.5px] text-violet-300 underline"
                      >
                        Verify Preset Sync Conflict Resolver
                      </button>
                      {syncConflictMsg && (
                        <p className="mt-1 text-[11px] text-[#9ca3b8]">
                          {syncConflictMsg}
                        </p>
                      )}
                    </div>
                  </div>

                  {/* Free vs Pro Plans */}
                  <div className="rounded-xl border border-white/10 bg-[#0d0e14] p-5">
                    <h4 className="text-[15px] font-semibold text-white">
                      Free &amp; Pro Plan Entitlements
                    </h4>
                    <div className="mt-3 space-y-3 text-[12.5px]">
                      <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3">
                        <div className="font-semibold text-emerald-300">
                          Free Local Plan (Active &amp; Unrestricted Locally)
                        </div>
                        <p className="mt-1 text-[#c4c9db]">
                          Includes Core Vanish/Restore, all 5 local visual
                          effects, Custom Effect Studio, Gesture Calibration,
                          Smart Meeting Modes, and up to{" "}
                          {entitlements.entitlements.maxLocalPresets} local
                          presets.
                        </p>
                      </div>
                      <div className="rounded-lg border border-violet-500/30 bg-violet-500/10 p-3">
                        <div className="font-semibold text-violet-300">
                          Pro Cloud Plan (Requires Backend Configuration)
                        </div>
                        <p className="mt-1 text-[#c4c9db]">
                          Adds encrypted cross-device Supabase preset sync and
                          team-shared presets. Checkout is{" "}
                          <strong>
                            {entitlements.billingConfigured
                              ? "CONFIGURED"
                              : "BLOCKED (VITE_BILLING_CHECKOUT_URL not set)"}
                          </strong>{" "}
                          to prevent fake client-side billing.
                        </p>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* -------------------------------------------------- 8. FEEDBACK & CHANGELOG */}
            {activeTab === "feedback" && (
              <div className="space-y-6">
                <div>
                  <h3 className="text-[18px] font-semibold text-white">
                    Feedback, Bug Reports &amp; Changelog (v
                    {CURRENT_EXTENSION_VERSION})
                  </h3>
                  <p className="mt-1 text-[13px] text-[#9ca3b8]">
                    Submit feedback or bug reports with optional consent-based
                    diagnostic snapshots, and review release notes.
                  </p>
                </div>

                <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
                  {/* Feedback Form */}
                  <form
                    className="space-y-3.5 rounded-xl border border-white/10 bg-[#0d0e14] p-5"
                    onSubmit={(e) => {
                      e.preventDefault();
                      setFbError(null);
                      setFbSuccess(null);
                      const res = submitFeedback({
                        category: fbCategory,
                        title: fbTitle,
                        description: fbDesc,
                        includeDiagnostics: fbIncludeDiag,
                        diagnosticSnapshot: fbIncludeDiag
                          ? {
                              measuredFps: liveMetrics.fps,
                              frameRenderMs: liveMetrics.renderMs,
                              activeParticleCount: liveMetrics.particles,
                              lowPowerActive: settings.lowPowerMode,
                            }
                          : undefined,
                      });
                      if (!res.ok) {
                        setFbError(res.error ?? "Invalid feedback input");
                        return;
                      }
                      setFeedbackList(res.all);
                      setFbTitle("");
                      setFbDesc("");
                      setFbIncludeDiag(false);
                      setFbSuccess(
                        "Saved report locally. You can export it as JSON to attach to a GitHub issue.",
                      );
                    }}
                  >
                    <h4 className="text-[15px] font-semibold text-white">
                      Report a Bug or Request a Feature
                    </h4>

                    <div>
                      <label className="mb-1 block text-[11.5px] text-[#9ca3b8]">
                        Category
                      </label>
                      <select
                        value={fbCategory}
                        onChange={(e) =>
                          setFbCategory(
                            e.target.value as
                              | "bug"
                              | "feature"
                              | "ux"
                              | "general",
                          )
                        }
                        className="w-full rounded-lg border border-white/15 bg-[#151722] px-3 py-2 text-[12.5px] text-white"
                      >
                        <option value="bug">Bug Report</option>
                        <option value="feature">Feature Request</option>
                        <option value="ux">UI / UX Improvement</option>
                        <option value="general">General Feedback</option>
                      </select>
                    </div>

                    <div>
                      <label className="mb-1 block text-[11.5px] text-[#9ca3b8]">
                        Summary Title
                      </label>
                      <input
                        type="text"
                        placeholder="Short summary..."
                        value={fbTitle}
                        onChange={(e) => setFbTitle(e.target.value)}
                        className="w-full rounded-lg border border-white/15 bg-[#151722] px-3 py-2 text-[12.5px] text-white"
                      />
                    </div>

                    <div>
                      <label className="mb-1 block text-[11.5px] text-[#9ca3b8]">
                        Details &amp; Steps to Reproduce
                      </label>
                      <textarea
                        rows={3}
                        placeholder="Describe what happened or what you would like to see..."
                        value={fbDesc}
                        onChange={(e) => setFbDesc(e.target.value)}
                        className="w-full rounded-lg border border-white/15 bg-[#151722] px-3 py-2 text-[12.5px] text-white"
                      />
                    </div>

                    <label className="flex items-start gap-2.5 text-[12px] text-[#9ca3b8]">
                      <input
                        type="checkbox"
                        checked={fbIncludeDiag}
                        onChange={(e) => setFbIncludeDiag(e.target.checked)}
                        className="mt-0.5 h-4 w-4 accent-violet-500"
                      />
                      <span>
                        Explicit Consent: Attach current performance snapshot
                        (FPS, frame render ms, active particle count). Never
                        includes camera images or audio.
                      </span>
                    </label>

                    {fbError && (
                      <div className="rounded bg-red-500/15 p-2.5 text-[12px] text-red-300">
                        {fbError}
                      </div>
                    )}
                    {fbSuccess && (
                      <div className="rounded bg-emerald-500/15 p-2.5 text-[12px] text-emerald-300">
                        {fbSuccess}
                      </div>
                    )}

                    <button
                      type="submit"
                      className="rounded-lg bg-violet-600 px-4 py-2 text-[12.5px] font-semibold text-white hover:bg-violet-500"
                    >
                      Save Feedback Report
                    </button>

                    {feedbackList.length > 0 && (
                      <div className="mt-4 space-y-2 border-t border-white/10 pt-3">
                        <div className="text-[12px] font-semibold text-white">
                          Recorded Local Reports ({feedbackList.length})
                        </div>
                        {feedbackList.map((item) => (
                          <div
                            key={item.id}
                            className="flex items-center justify-between rounded border border-white/10 bg-[#151722] px-3 py-2 text-[11.5px]"
                          >
                            <div className="truncate">
                              <span className="font-mono uppercase text-violet-300">
                                [{item.category}]
                              </span>{" "}
                              <span className="text-white">{item.title}</span>
                              {item.includeDiagnostics && (
                                <span className="ml-2 text-[10px] text-emerald-300">
                                  +diag
                                </span>
                              )}
                            </div>
                            <button
                              type="button"
                              onClick={() =>
                                setFeedbackList(
                                  deleteFeedbackSubmission(item.id),
                                )
                              }
                              className="ml-2 text-red-300 hover:underline"
                            >
                              Delete
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </form>

                  {/* Changelog */}
                  <div className="space-y-4 rounded-xl border border-white/10 bg-[#0d0e14] p-5">
                    <h4 className="text-[15px] font-semibold text-white">
                      Release Changelog
                    </h4>
                    {CHANGELOG_ENTRIES.map((entry) => (
                      <div
                        key={entry.version}
                        className="border-b border-white/10 pb-4 last:border-b-0"
                      >
                        <div className="flex items-center gap-2">
                          <span className="rounded bg-violet-600/30 px-2 py-0.5 font-mono text-[11px] font-semibold text-violet-200">
                            v{entry.version}
                          </span>
                          <span className="font-mono text-[11px] text-[#687089]">
                            {entry.date}
                          </span>
                        </div>
                        <div className="mt-1.5 font-semibold text-white">
                          {entry.title}
                        </div>
                        <ul className="mt-2 space-y-1 text-[12px] text-[#9ca3b8]">
                          {entry.highlights.map((h) => (
                            <li key={h}>• {h}</li>
                          ))}
                        </ul>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

function StatCard({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub: string;
}) {
  return (
    <div className="rounded-xl border border-white/10 bg-[#0d0e14] p-4">
      <div className="font-mono text-[10.5px] uppercase tracking-wider text-[#9ca3b8]">
        {label}
      </div>
      <div className="mt-1.5 font-mono text-[22px] font-semibold text-white">
        {value}
      </div>
      <div className="mt-1 text-[11.5px] text-[#687089]">{sub}</div>
    </div>
  );
}

function StudioSlider({
  label,
  value,
  min,
  max,
  step,
  display,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  display: string;
  onChange: (v: number) => void;
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <span className="text-[12px] font-medium text-[#c4c9db]">{label}</span>
        <span className="font-mono text-[12px] font-semibold text-violet-300">
          {display}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={label}
        onChange={(e) => onChange(Number(e.target.value))}
        className="mt-1.5"
      />
    </div>
  );
}
