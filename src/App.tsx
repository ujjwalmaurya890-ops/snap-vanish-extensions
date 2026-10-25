import { useCallback, useEffect, useState } from "react";
import SnapStage, { type SnapStatus } from "./components/SnapStage";
import VanishPopup from "./components/VanishPopup";
import Dashboard, { type DashboardTab } from "./components/Dashboard";
import OnboardingModal from "./components/OnboardingModal";
import {
  Footer,
  Header,
  Hero,
  Install,
  Pipeline,
  PrivacyBand,
  Rail,
  Reveal,
} from "./components/Sections";
import type {
  EffectPreset,
  MeetingModeId,
  SnapSettings,
} from "./types/snapVanish";
import {
  BUILT_IN_PRESETS,
  DEFAULT_SETTINGS,
  MEETING_MODES,
  createPresetFromSettings,
  deletePreset,
  duplicatePreset,
  loadPresets,
  loadSettingsSync,
  mergeAndValidateSettings,
  renamePreset,
  saveCustomPresets,
  saveSettings,
} from "./lib/settings";
import {
  clearAnalyticsData,
  loadAnalytics,
  recordAnalyticsEvent,
} from "./lib/analytics";
import {
  appendDiagnosticLog,
  clearDiagnosticLogs,
  loadDiagnosticLogs,
} from "./lib/diagnostics";
import {
  isExtensionRuntimeAvailable,
  sendExtensionMessage,
} from "./lib/messaging";
import { clearAllFeedback } from "./lib/feedbackAndChangelog";

export default function App() {
  const [settings, setSettings] = useState<SnapSettings>(() =>
    loadSettingsSync(),
  );
  const [presets, setPresets] = useState<EffectPreset[]>(() => loadPresets());
  const [selectedPresetId, setSelectedPresetId] = useState<string>(
    "preset-ember-dust",
  );
  const [analytics, setAnalytics] = useState(() => loadAnalytics());
  const [diagnosticLogs, setDiagnosticLogs] = useState(() =>
    loadDiagnosticLogs(),
  );
  const [snapSignal, setSnapSignal] = useState(0);
  const [emergencySignal, setEmergencySignal] = useState(0);
  const [status, setStatus] = useState<SnapStatus>("idle");
  const [dashboardTab, setDashboardTab] = useState<DashboardTab>("overview");
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  const [liveMetrics, setLiveMetrics] = useState<{
    fps: number | null;
    renderMs: number | null;
    particles: number;
  }>({
    fps: null,
    renderMs: null,
    particles: 0,
  });
  const [extensionBridgeConnected, setExtensionBridgeConnected] = useState(() =>
    isExtensionRuntimeAvailable(),
  );

  // Listen for cross-tab / popup BroadcastChannel updates
  useEffect(() => {
    setExtensionBridgeConnected(isExtensionRuntimeAvailable());
    if (typeof BroadcastChannel === "undefined") return;
    let ch: BroadcastChannel | null = null;
    try {
      ch = new BroadcastChannel("snap_vanish_channel");
      ch.onmessage = (ev) => {
        const msg = ev.data;
        if (!msg || typeof msg !== "object") return;
        if (msg.type === "SETTINGS_UPDATED") {
          setSettings(loadSettingsSync());
        } else if (msg.type === "PRESETS_UPDATED") {
          setPresets(loadPresets());
        } else if (msg.type === "ANALYTICS_UPDATED") {
          setAnalytics(loadAnalytics());
        }
      };
    } catch {
      // Ignore if BroadcastChannel is blocked
    }
    return () => {
      ch?.close();
    };
  }, []);

  const handleStatusChange = useCallback(
    (nextStatus: SnapStatus) => {
      setStatus((prev) => {
        if (prev !== nextStatus) {
          if (nextStatus === "vanishing") {
            setAnalytics(
              recordAnalyticsEvent({
                type: "vanish_activated",
                effect: settings.effect,
                source: "manual",
              }),
            );
          } else if (prev === "returning" && nextStatus === "idle") {
            setAnalytics(
              recordAnalyticsEvent({
                type: "restore_completed",
                effect: settings.effect,
                source: "manual",
              }),
            );
          }
        }
        return nextStatus;
      });
    },
    [settings.effect],
  );

  const handleUpdateSettings = useCallback((patch: Partial<SnapSettings>) => {
    setSettings((prev) => {
      const { sanitized } = mergeAndValidateSettings(prev, patch);
      void saveSettings(sanitized);
      if (isExtensionRuntimeAvailable()) {
        void sendExtensionMessage({
          type: "SETTINGS_CHANGED",
          payload: sanitized as unknown as Record<string, unknown>,
        });
      }
      return sanitized;
    });
  }, []);

  const handleResetSettings = useCallback(() => {
    const reset = structuredClone(DEFAULT_SETTINGS);
    setSettings(reset);
    void saveSettings(reset);
    setSelectedPresetId("preset-ember-dust");
    setDiagnosticLogs(
      appendDiagnosticLog({
        level: "info",
        code: "SETTINGS_RESET",
        message: "Restored settings to factory defaults.",
      }),
    );
  }, []);

  const handleSelectPreset = useCallback(
    (preset: EffectPreset) => {
      setSelectedPresetId(preset.id);
      handleUpdateSettings({
        ...preset.config,
        meetingMode: "custom",
      });
      setAnalytics(
        recordAnalyticsEvent({
          type: "preset_selected",
          presetId: preset.id,
          effect: preset.config.effect,
          source: "dashboard",
        }),
      );
    },
    [handleUpdateSettings],
  );

  const handleSelectMeetingMode = useCallback(
    (modeId: Exclude<MeetingModeId, "custom">) => {
      const mode = MEETING_MODES[modeId];
      if (!mode) return;
      handleUpdateSettings(mode.settingsPatch);
      setAnalytics(
        recordAnalyticsEvent({
          type: "mode_selected",
          modeId,
          effect: mode.settingsPatch.effect,
          source: "popup",
        }),
      );
    },
    [handleUpdateSettings],
  );

  const handleSnap = useCallback(() => {
    if (!settings.enabled) {
      setAnalytics(
        recordAnalyticsEvent({
          type: "trigger_failed",
          reason: "extension-disabled",
          source: "popup",
        }),
      );
      return;
    }
    setSnapSignal((n) => n + 1);
    if (isExtensionRuntimeAvailable()) {
      void sendExtensionMessage({ type: "SNAP_TOGGLE" });
    }
  }, [settings.enabled]);

  const handleEmergencyRestore = useCallback(() => {
    setEmergencySignal((n) => n + 1);
    setAnalytics(
      recordAnalyticsEvent({
        type: "emergency_restore",
        effect: settings.effect,
        source: "manual",
      }),
    );
    setDiagnosticLogs(
      appendDiagnosticLog(
        {
          level: "warn",
          code: "EMERGENCY_RESTORE",
          message: "User triggered unconditional emergency camera restoration.",
        },
        settings.diagnosticLoggingEnabled,
      ),
    );
    if (isExtensionRuntimeAvailable()) {
      void sendExtensionMessage({ type: "EMERGENCY_RESTORE" });
    }
  }, [settings.effect, settings.diagnosticLoggingEnabled]);

  const handleOpenDashboardSection = useCallback((tab?: string) => {
    if (tab) {
      setDashboardTab(tab as DashboardTab);
    }
    const el = document.getElementById("dashboard");
    el?.scrollIntoView({ behavior: "smooth" });
  }, []);

  const handleClearAllData = useCallback(() => {
    const reset = structuredClone(DEFAULT_SETTINGS);
    setSettings(reset);
    void saveSettings(reset);
    setPresets(saveCustomPresets(BUILT_IN_PRESETS));
    setAnalytics(clearAnalyticsData());
    setDiagnosticLogs(clearDiagnosticLogs());
    clearAllFeedback();
  }, []);

  return (
    <div className="relative min-h-screen bg-paper">
      <div className="grain" aria-hidden />

      <Header onOpenOnboarding={() => setOnboardingOpen(true)} />
      <Hero />

      {/* ---------------------------------------------------------- demo */}
      <section id="demo" className="border-b border-rule bg-paper-2/55">
        <div className="mx-auto grid max-w-[1280px] grid-cols-1 gap-x-10 px-6 py-16 md:grid-cols-[180px_1fr] md:px-10 md:py-24">
          <Rail>
            <div className="text-ember">LIVE DEMO</div>
            <div>5 EFFECT ENGINES</div>
            <div className="tnum">
              {liveMetrics.fps !== null ? `${liveMetrics.fps} FPS` : "CANVAS 2D"}
            </div>
            <div className="mt-6 h-px w-10 bg-rule" />
            <div className="leading-[1.9]">
              NOT A VIDEO
              <br />
              REAL PARTICLES
              <br />
              REVERSIBLE
            </div>
          </Rail>

          <div>
            <h2 className="max-w-[15ch] font-display text-[clamp(2.5rem,6vw,5rem)] leading-[0.92] tracking-[-0.022em]">
              Press snap and watch the room come back.
            </h2>
            <p className="mt-6 max-w-[56ch] text-[16px] leading-[1.62] text-ink-2">
              This is the actual multi-effect engine from the extension, running
              on the plate it composites behind you. Fire it with the button,
              the popup, or{" "}
              <span className="whitespace-nowrap font-mono text-[13px] text-ember">
                ALT + SHIFT + S
              </span>{" "}
              on your keyboard. Press{" "}
              <span className="whitespace-nowrap font-mono text-[13px] text-ember">
                ALT + SHIFT + R
              </span>{" "}
              at any moment for instant emergency restoration.
            </p>

            <div className="mt-11 grid grid-cols-1 gap-x-12 gap-y-12 xl:grid-cols-[1fr_360px]">
              <div>
                <SnapStage
                  enabled={settings.enabled}
                  duration={settings.duration}
                  direction={settings.direction}
                  sensitivity={settings.sensitivity}
                  sound={settings.sound}
                  effect={settings.effect}
                  speed={settings.speed}
                  particleSize={settings.particleSize}
                  density={settings.density}
                  colorAccent={settings.colorAccent}
                  intensity={settings.intensity}
                  lowPowerMode={settings.lowPowerMode}
                  snapSignal={snapSignal}
                  emergencySignal={emergencySignal}
                  onStatus={handleStatusChange}
                  onEmergencyRestore={() => {
                    setAnalytics(
                      recordAnalyticsEvent({
                        type: "emergency_restore",
                        effect: settings.effect,
                        source: "manual",
                      }),
                    );
                  }}
                  onMetrics={setLiveMetrics}
                />

                <div className="mt-8 grid grid-cols-2 gap-x-8 gap-y-6 sm:grid-cols-4">
                  {[
                    [
                      "Measured Render",
                      liveMetrics.renderMs !== null
                        ? `${liveMetrics.renderMs} ms`
                        : "Measuring…",
                    ],
                    [
                      "Measured FPS",
                      liveMetrics.fps !== null
                        ? `${liveMetrics.fps} fps`
                        : "Measuring…",
                    ],
                    ["Activations", `${analytics.totalActivations}`],
                    ["Local Egress", "0 B"],
                  ].map(([k, v]) => (
                    <div key={k} className="border-t border-rule pt-3">
                      <div className="rail text-ink-soft">{k}</div>
                      <div className="tnum mt-1 font-display text-[27px] leading-none">
                        {v}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Upgraded Premium Dark Popup */}
              <Reveal delay={0.1}>
                <div id="popup" className="xl:sticky xl:top-24">
                  <div className="rail mb-4 text-ink-soft">
                    FIG. 02 — EXTENSION POPUP (v2.0 DARK STUDIO)
                  </div>
                  <div className="origin-top-left transition-transform duration-300">
                    <VanishPopup
                      settings={settings}
                      presets={presets}
                      selectedPresetId={selectedPresetId}
                      onSelectPreset={handleSelectPreset}
                      onSelectMeetingMode={handleSelectMeetingMode}
                      onChange={handleUpdateSettings}
                      onSnap={handleSnap}
                      onEmergencyRestore={handleEmergencyRestore}
                      onOpenDashboard={handleOpenDashboardSection}
                      onOpenOnboarding={() => setOnboardingOpen(true)}
                      status={status}
                      extensionBridgeConnected={extensionBridgeConnected}
                    />
                  </div>
                  <p className="mt-6 max-w-[38ch] text-[13px] leading-[1.66] text-ink-2">
                    Every control in this popup is wired directly to the live
                    stage and synchronized with the{" "}
                    <a
                      href="#dashboard"
                      className="font-medium text-ember underline"
                    >
                      Companion Web Dashboard
                    </a>{" "}
                    below.
                  </p>
                </div>
              </Reveal>
            </div>
          </div>
        </div>
      </section>

      {/* Companion SaaS Web Dashboard */}
      <Dashboard
        activeTab={dashboardTab}
        onTabChange={setDashboardTab}
        settings={settings}
        onUpdateSettings={handleUpdateSettings}
        onResetSettings={handleResetSettings}
        presets={presets}
        selectedPresetId={selectedPresetId}
        onSelectPreset={handleSelectPreset}
        onCreatePreset={(name, desc) => {
          const updated = createPresetFromSettings(name, desc, settings);
          setPresets(updated);
          const newest = updated[updated.length - 1];
          if (newest) setSelectedPresetId(newest.id);
        }}
        onRenamePreset={(id, name, desc) => {
          setPresets(renamePreset(id, name, desc));
        }}
        onDuplicatePreset={(id) => {
          setPresets(duplicatePreset(id));
        }}
        onDeletePreset={(id) => {
          setPresets(deletePreset(id));
          if (selectedPresetId === id) {
            setSelectedPresetId("preset-ember-dust");
          }
        }}
        analytics={analytics}
        onClearAnalytics={() => setAnalytics(clearAnalyticsData())}
        diagnosticLogs={diagnosticLogs}
        onAddDiagnosticLog={(level, code, message) =>
          setDiagnosticLogs(
            appendDiagnosticLog(
              { level, code, message },
              settings.diagnosticLoggingEnabled,
            ),
          )
        }
        onClearDiagnostics={() => setDiagnosticLogs(clearDiagnosticLogs())}
        onClearAllData={handleClearAllData}
        stageStatus={status}
        onTriggerStage={handleSnap}
        onEmergencyRestore={handleEmergencyRestore}
        onOpenOnboarding={() => setOnboardingOpen(true)}
        liveMetrics={liveMetrics}
        extensionBridgeConnected={extensionBridgeConnected}
      />

      <Pipeline />
      <PrivacyBand />
      <Install />
      <Footer />

      <OnboardingModal
        open={onboardingOpen}
        settings={settings}
        onUpdateSettings={handleUpdateSettings}
        onTriggerTestEffect={handleSnap}
        onEmergencyRestore={handleEmergencyRestore}
        onComplete={() => setOnboardingOpen(false)}
      />
    </div>
  );
}
