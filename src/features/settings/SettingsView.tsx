import { useEffect, useRef, useState } from "react";
import {
  Camera,
  Cpu,
  Download,
  Hand,
  Info,
  Keyboard,
  Mic,
  RotateCcw,
  ShieldCheck,
  Sliders,
  Sparkles,
  Trash2,
  Upload,
  Volume2,
} from "lucide-react";
import {
  Badge,
  Button,
  Card,
  Kbd,
  RangeControl,
  SelectField,
  Switch,
} from "../../components/ui/DesignSystem";
import {
  BACKGROUND_METHODS_EXPLAINED,
  PLATFORM_COMPATIBILITY_MATRIX,
} from "../camera/backgroundReconstructor";
import {
  LiveAudioConfirmationEngine,
  enumerateAudioInputDevices,
} from "../audio/audioConfirmationEngine";
import {
  DETECTION_MODE_PROFILES,
  exportSettingsJson,
  importSettingsJson,
} from "../../lib/settings";
import type {
  CameraSettings,
  DetectionMode,
  DetectionTriggerMode,
  EffectPreset,
  GestureAction,
  HudPosition,
  SnapSettings,
} from "../../types/snapVanish";

export type SettingsSectionId =
  | "general"
  | "detection"
  | "camera"
  | "audio"
  | "animation"
  | "performance"
  | "privacy"
  | "shortcuts"
  | "about";

interface SettingsViewProps {
  settings: SnapSettings;
  presets: EffectPreset[];
  audioMonitor: {
    active: boolean;
    levelPercent: number;
    currentDb: number;
    floorDb: number;
  };
  onPatchSettings: (patch: Partial<SnapSettings>) => void;
  onReplaceAllSettings: (
    nextSettings: SnapSettings,
    nextPresets?: EffectPreset[],
  ) => void;
  onResetDefaults: () => void;
  onOpenCalibration: () => void;
  onOpenOnboarding: () => void;
  onOpenStudioTab: () => void;
  onClearLocalLogs: () => void;
  onTestShortcutAction: (action: "toggle" | "vanish" | "restore") => void;
}

const SECTIONS: Array<{
  id: SettingsSectionId;
  label: string;
  icon: typeof Sliders;
}> = [
  { id: "general", label: "General", icon: Sliders },
  { id: "detection", label: "Detection", icon: Hand },
  { id: "camera", label: "Camera", icon: Camera },
  { id: "audio", label: "Audio", icon: Mic },
  { id: "animation", label: "Animation", icon: Sparkles },
  { id: "performance", label: "Performance", icon: Cpu },
  { id: "privacy", label: "Privacy", icon: ShieldCheck },
  { id: "shortcuts", label: "Keyboard Shortcuts", icon: Keyboard },
  { id: "about", label: "About", icon: Info },
];

export default function SettingsView({
  settings,
  presets,
  audioMonitor,
  onPatchSettings,
  onReplaceAllSettings,
  onResetDefaults,
  onOpenCalibration,
  onOpenOnboarding,
  onOpenStudioTab,
  onClearLocalLogs,
  onTestShortcutAction,
}: SettingsViewProps) {
  const [activeSection, setActiveSection] =
    useState<SettingsSectionId>("general");
  const [videoDevices, setVideoDevices] = useState<
    Array<{ deviceId: string; label: string }>
  >([]);
  const [audioDevices, setAudioDevices] = useState<
    Array<{ deviceId: string; label: string }>
  >([]);
  const [importStatus, setImportStatus] = useState<{
    tone: "emerald" | "danger" | "amber";
    text: string;
  } | null>(null);
  const [audioTestFeedback, setAudioTestFeedback] = useState<string | null>(
    null,
  );
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    let mounted = true;
    const loadDevices = async () => {
      if (
        typeof navigator === "undefined" ||
        !navigator.mediaDevices?.enumerateDevices
      ) {
        return;
      }
      try {
        const all = await navigator.mediaDevices.enumerateDevices();
        if (!mounted) return;
        setVideoDevices(
          all
            .filter((d) => d.kind === "videoinput")
            .map((d, i) => ({
              deviceId: d.deviceId,
              label: d.label || `Camera Input #${i + 1}`,
            })),
        );
        const mics = await enumerateAudioInputDevices();
        if (mounted) setAudioDevices(mics);
      } catch {
        // Ignore if blocked before permission
      }
    };
    void loadDevices();
    return () => {
      mounted = false;
    };
  }, [activeSection]);

  const handleExportJson = () => {
    const json = exportSettingsJson(settings, presets);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `snap-vanish-settings-v2-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    setImportStatus({
      tone: "emerald",
      text: "Exported settings and custom presets to JSON.",
    });
  };

  const handleImportFile = async (file: File) => {
    const raw = await file.text();
    const res = importSettingsJson(raw);
    if (!res.ok) {
      setImportStatus({
        tone: "danger",
        text: res.error ?? "Invalid settings JSON file.",
      });
      return;
    }
    onReplaceAllSettings(res.settings, res.presets);
    setImportStatus({
      tone: res.issues.length > 0 ? "amber" : "emerald",
      text:
        res.issues.length > 0
          ? `Imported settings cleanly (${res.issues.length} out-of-range/legacy fields auto-sanitized).`
          : "Imported v2 settings and custom presets cleanly.",
    });
  };

  const handleDetectionModeSelect = (mode: DetectionMode) => {
    if (mode === "custom") {
      onPatchSettings({
        gesture: { ...settings.gesture, mode: "custom" },
      });
      return;
    }
    const profile = DETECTION_MODE_PROFILES[mode];
    onPatchSettings({
      sensitivity: profile.sensitivity,
      gesture: {
        ...settings.gesture,
        mode,
        sensitivity: profile.sensitivity,
        minHandConfidence: profile.minHandConfidence,
        landmarkSmoothing: profile.landmarkSmoothing,
        cooldownMs: profile.cooldownMs,
        calibratedCollapseThresholdMm: profile.calibratedCollapseThresholdMm,
      },
    });
  };

  const runAudioTransientTest = () => {
    const engine = new LiveAudioConfirmationEngine();
    const res = engine.runSyntheticTransientTest(settings.audio.sensitivityDb);
    setAudioTestFeedback(
      res.confirmed
        ? `Transient gate verified (+${res.jumpDb} dB above adaptive noise floor at threshold +${res.thresholdDb} dB).`
        : `Threshold (+${res.thresholdDb} dB) exceeded synthetic burst (+${res.jumpDb} dB). Lower sensitivity threshold for quieter snaps.`,
    );
  };

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
      {/* 9-Section Navigation Rail */}
      <Card padding="sm" className="h-fit lg:col-span-3">
        <div className="rail px-2.5 pb-2 pt-1 text-[#8b92a5]">
          SETTINGS (9 SECTIONS)
        </div>
        <nav aria-label="Settings sections" className="space-y-1">
          {SECTIONS.map((sec) => {
            const Icon = sec.icon;
            const active = activeSection === sec.id;
            return (
              <button
                key={sec.id}
                type="button"
                onClick={() => setActiveSection(sec.id)}
                className={`flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-left text-[13px] font-medium transition-colors ${
                  active
                    ? "bg-[#e0532c]/18 text-[#ff9d80]"
                    : "text-[#a1a6b5] hover:bg-white/[0.04] hover:text-white"
                }`}
              >
                <Icon className="h-4 w-4 shrink-0" />
                <span>{sec.label}</span>
              </button>
            );
          })}
        </nav>
      </Card>

      {/* Active Settings Section Content */}
      <Card padding="lg" className="space-y-6 lg:col-span-9">
        {/* 1. GENERAL */}
        {activeSection === "general" && (
          <div className="space-y-6">
            <div>
              <div className="rail text-[#ff9d80]">SECTION 01 · GENERAL</div>
              <h2 className="mt-1 text-[20px] font-semibold text-white">
                General Runtime &amp; Backup Controls
              </h2>
              <p className="mt-1 text-[13px] text-[#8b92a5]">
                Core extension toggles, meeting HUD preferences, and portable
                JSON configuration backup with schema validation.
              </p>
            </div>

            <div className="space-y-4 rounded-xl border border-white/[0.07] bg-[#181b23] p-4">
              <Switch
                label="Enable Snap Vanish Extension"
                description="Master runtime switch across toolbar popup, keyboard commands, and supported meeting tabs."
                checked={settings.enabled}
                onChange={(v) => onPatchSettings({ enabled: v })}
              />
              <div className="border-t border-white/[0.06] pt-4">
                <Switch
                  label="Auto-Arm When Joining Video Call"
                  description="Automatically initializes local detection when joining Google Meet, Microsoft Teams, or Zoom Web."
                  checked={settings.autoStartOnCall}
                  onChange={(v) => onPatchSettings({ autoStartOnCall: v })}
                />
              </div>
              <div className="border-t border-white/[0.06] pt-4">
                <Switch
                  label="Show Non-Intrusive Meeting HUD"
                  description="Displays a minimal corner status pill in supported meeting tabs so you always know whether your camera is live or vanished."
                  checked={settings.showCallHud}
                  onChange={(v) => onPatchSettings({ showCallHud: v })}
                />
              </div>
              <div className="border-t border-white/[0.06] pt-4">
                <SelectField
                  label="Meeting HUD Corner Placement"
                  value={settings.hudPosition}
                  onChange={(e) =>
                    onPatchSettings({
                      hudPosition: e.target.value as HudPosition,
                    })
                  }
                >
                  <option value="bottom-right">Bottom Right</option>
                  <option value="bottom-left">Bottom Left</option>
                  <option value="top-right">Top Right</option>
                </SelectField>
              </div>
              <div className="border-t border-white/[0.06] pt-4">
                <Switch
                  label="Local Acoustic Click Feedback"
                  description="Plays a crisp 90 ms local confirmation click in your headphones when vanish or restore triggers."
                  checked={settings.sound}
                  onChange={(v) => onPatchSettings({ sound: v })}
                />
              </div>
            </div>

            <div className="space-y-3 rounded-xl border border-white/[0.07] bg-[#181b23] p-4">
              <div className="text-[13.5px] font-semibold text-white">
                Configuration Export, Import &amp; Factory Reset
              </div>
              <p className="text-[12px] text-[#8b92a5]">
                Export your calibrated thresholds and custom particle presets to
                a portable JSON file, or import v1/v2 configuration files safely.
              </p>
              <div className="flex flex-wrap gap-2.5 pt-1">
                <Button variant="secondary" onClick={handleExportJson}>
                  <Download className="h-4 w-4" />
                  Export Settings JSON
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => fileInputRef.current?.click()}
                >
                  <Upload className="h-4 w-4" />
                  Import Settings JSON
                </Button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="application/json,.json"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void handleImportFile(f);
                    e.currentTarget.value = "";
                  }}
                />
                <Button variant="danger" onClick={onResetDefaults}>
                  <RotateCcw className="h-4 w-4" />
                  Reset All Settings to Defaults
                </Button>
              </div>
              {importStatus && (
                <div className="pt-1">
                  <Badge tone={importStatus.tone}>{importStatus.text}</Badge>
                </div>
              )}
            </div>
          </div>
        )}

        {/* 2. DETECTION */}
        {activeSection === "detection" && (
          <div className="space-y-6">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <div className="rail text-[#ff9d80]">SECTION 02 · DETECTION</div>
                <h2 className="mt-1 text-[20px] font-semibold text-white">
                  21-Point Hand Landmark &amp; Snap Kinematic Engine
                </h2>
                <p className="mt-1 text-[13px] text-[#8b92a5]">
                  Powered locally by MediaPipe HandLandmarker WASM with adaptive
                  landmark smoothing and multi-phase snap state verification.
                </p>
              </div>
              <Button variant="primary" onClick={onOpenCalibration}>
                <Sliders className="h-4 w-4" />
                Run 7-Step Calibration
              </Button>
            </div>

            <div className="rounded-xl border border-white/[0.07] bg-[#181b23] p-4">
              <Switch
                label="Enable Automatic Hand Snap Detection"
                description="Runs 21-point hand landmark inference on your local camera feed to trigger vanish/restore hands-free."
                checked={settings.gesture.enabled}
                onChange={(v) =>
                  onPatchSettings({
                    gesture: { ...settings.gesture, enabled: v },
                  })
                }
              />
            </div>

            <div>
              <div className="rail text-[#ff9d80]">DETECTION MODE</div>
              <p className="mt-1 text-[12px] text-[#8b92a5]">
                Sound alone never triggers a vanish in any mode. In Gesture and
                Manual modes the microphone is never opened for detection.
              </p>
              <div
                className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3"
                role="radiogroup"
                aria-label="Detection mode"
              >
                {(
                  [
                    {
                      id: "smart",
                      name: "Smart Mode",
                      desc: "Visual snap gesture confirmed by the acoustic snap transient. Fewest false triggers.",
                    },
                    {
                      id: "gesture-only",
                      name: "Gesture Mode",
                      desc: "Visual snap gesture only — no audio confirmation and the microphone stays closed.",
                    },
                    {
                      id: "manual",
                      name: "Manual Mode",
                      desc: "No automatic detection. Trigger from the popup, meeting HUD, or Alt+Shift+D.",
                    },
                  ] as Array<{
                    id: DetectionTriggerMode;
                    name: string;
                    desc: string;
                  }>
                ).map((m) => {
                  const selected = settings.gesture.detectionMode === m.id;
                  return (
                    <button
                      key={m.id}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      onClick={() =>
                        onPatchSettings({
                          gesture: {
                            ...settings.gesture,
                            detectionMode: m.id,
                            enabled:
                              m.id === "manual"
                                ? settings.gesture.enabled
                                : true,
                            requireAudioConfirm:
                              m.id === "smart"
                                ? true
                                : settings.gesture.requireAudioConfirm,
                          },
                        })
                      }
                      className={`rounded-xl border p-3.5 text-left transition-all ${
                        selected
                          ? "border-[#f0623a] bg-[#e0532c]/15"
                          : "border-white/10 bg-[#181b23] hover:border-white/20"
                      }`}
                    >
                      <div className="font-mono text-[11px] uppercase text-[#ff9d80]">
                        {m.name}
                      </div>
                      <p className="mt-1 text-[11.5px] text-[#9ca3b8]">
                        {m.desc}
                      </p>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {(
                ["beginner", "balanced", "precision", "custom"] as DetectionMode[]
              ).map((m) => {
                const selected = settings.gesture.mode === m;
                return (
                  <button
                    key={m}
                    type="button"
                    onClick={() => handleDetectionModeSelect(m)}
                    className={`rounded-xl border p-3.5 text-left transition-all ${
                      selected
                        ? "border-[#f0623a] bg-[#e0532c]/15"
                        : "border-white/10 bg-[#181b23] hover:border-white/20"
                    }`}
                  >
                    <div className="font-mono text-[11px] uppercase text-[#ff9d80]">
                      {m}
                    </div>
                    <p className="mt-1 text-[11.5px] text-[#9ca3b8]">
                      {m === "custom"
                        ? "Manual per-threshold tuning & calibrated collapse distance."
                        : DETECTION_MODE_PROFILES[m].tagline}
                    </p>
                  </button>
                );
              })}
            </div>

            <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
              <RangeControl
                label="Gesture Sensitivity"
                displayValue={`${settings.gesture.sensitivity}/100`}
                min={1}
                max={100}
                value={settings.gesture.sensitivity}
                hint="Controls collapse velocity and cocked-finger distance strictness"
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
                label="Minimum Hand Landmark Confidence"
                displayValue={`${Math.round(settings.gesture.minHandConfidence * 100)}%`}
                min={35}
                max={95}
                value={Math.round(settings.gesture.minHandConfidence * 100)}
                hint="Rejects blurry or occluded hand detections below this score"
                onChange={(v) =>
                  onPatchSettings({
                    gesture: {
                      ...settings.gesture,
                      mode: "custom",
                      minHandConfidence: v / 100,
                    },
                  })
                }
              />
              <RangeControl
                label="Landmark Temporal Smoothing"
                displayValue={`${Math.round(settings.gesture.landmarkSmoothing * 100)}%`}
                min={0}
                max={85}
                value={Math.round(settings.gesture.landmarkSmoothing * 100)}
                hint="Velocity-adaptive EMA filter to stabilize jitter without dulling snap speed"
                onChange={(v) =>
                  onPatchSettings({
                    gesture: {
                      ...settings.gesture,
                      mode: "custom",
                      landmarkSmoothing: v / 100,
                    },
                  })
                }
              />
              <RangeControl
                label="Cooldown Between Triggers"
                displayValue={`${(settings.gesture.cooldownMs / 1000).toFixed(1)} s`}
                min={500}
                max={8000}
                step={250}
                value={settings.gesture.cooldownMs}
                hint="Prevents double-trigger echoes immediately after a confirmed snap"
                onChange={(v) =>
                  onPatchSettings({
                    gesture: {
                      ...settings.gesture,
                      mode: "custom",
                      cooldownMs: v,
                    },
                  })
                }
              />
              <SelectField
                label="Confirmed Snap Action Mapping"
                value={settings.gesture.actionMapping}
                onChange={(e) =>
                  onPatchSettings({
                    gesture: {
                      ...settings.gesture,
                      actionMapping: e.target.value as GestureAction,
                    },
                  })
                }
              >
                <option value="toggle-vanish">
                  Toggle Vanish / Restore (Default)
                </option>
                <option value="vanish-only">Vanish Only</option>
                <option value="restore-only">Restore Camera Only</option>
                <option value="mute-only">Mute Microphone Only</option>
              </SelectField>

              <div className="rounded-xl border border-white/[0.07] bg-[#181b23] p-3.5">
                <Switch
                  label="Accidental Trigger Protection"
                  description="Rejects hand waves, face touches, and rigid wrist shakes."
                  checked={settings.gesture.accidentalTriggerProtection}
                  onChange={(v) =>
                    onPatchSettings({
                      gesture: {
                        ...settings.gesture,
                        accidentalTriggerProtection: v,
                      },
                    })
                  }
                />
              </div>
            </div>
          </div>
        )}

        {/* 3. CAMERA */}
        {activeSection === "camera" && (
          <div className="space-y-6">
            <div>
              <div className="rail text-[#ff9d80]">SECTION 03 · CAMERA</div>
              <h2 className="mt-1 text-[20px] font-semibold text-white">
                Camera Pipeline &amp; Background Reconstruction
              </h2>
              <p className="mt-1 text-[13px] text-[#8b92a5]">
                Configure video input selection, resolution, microphone mute
                pairing, and how your empty room background is reconstructed.
              </p>
            </div>

            <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
              <SelectField
                label="Preferred Video Input Device"
                value={settings.camera.preferredDeviceId}
                hint="Uses system default webcam until a specific device is selected"
                onChange={(e) =>
                  onPatchSettings({
                    camera: {
                      ...settings.camera,
                      preferredDeviceId: e.target.value,
                    },
                  })
                }
              >
                <option value="">System Default Camera</option>
                {videoDevices.map((d) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label}
                  </option>
                ))}
              </SelectField>

              <SelectField
                label="Target Processing Resolution"
                value={settings.camera.targetResolution}
                hint="720p HD balances crisp particle edges with low GPU overhead"
                onChange={(e) =>
                  onPatchSettings({
                    camera: {
                      ...settings.camera,
                      targetResolution: e.target
                        .value as CameraSettings["targetResolution"],
                    },
                  })
                }
              >
                <option value="640x360">640×360 (Ultra-Low CPU)</option>
                <option value="1280x720">1280×720 (Recommended HD)</option>
                <option value="1920x1080">1920×1080 (Full HD)</option>
              </SelectField>
            </div>

            <div className="space-y-4 rounded-xl border border-white/[0.07] bg-[#181b23] p-4">
              <Switch
                label="Mirror Local Camera Preview"
                description="Flips the local studio preview horizontally so hand movements feel natural like a mirror."
                checked={settings.camera.mirrorPreview}
                onChange={(v) =>
                  onPatchSettings({
                    camera: { ...settings.camera, mirrorPreview: v },
                  })
                }
              />
              <div className="border-t border-white/[0.06] pt-4">
                <Switch
                  label="Auto-Mute Call Microphone While Vanished"
                  description="Clicks the meeting platform's native mute toggle when vanishing and restores your prior mic state on return."
                  checked={settings.muteOnVanish}
                  onChange={(v) => onPatchSettings({ muteOnVanish: v })}
                />
              </div>
              <div className="border-t border-white/[0.06] pt-4">
                <Switch
                  label="Auto-Restore Live Camera When Leaving Call"
                  description="Ensures original hardware camera stream is restored whenever a meeting ends or reloads."
                  checked={settings.camera.autoRestoreOnLeave}
                  onChange={(v) =>
                    onPatchSettings({
                      camera: { ...settings.camera, autoRestoreOnLeave: v },
                    })
                  }
                />
              </div>
            </div>

            <div className="space-y-3">
              <div className="text-[13.5px] font-semibold text-white">
                Background Reconstruction Strategy
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {BACKGROUND_METHODS_EXPLAINED.map((info) => {
                  const selected = settings.camera.backgroundMode === info.id;
                  return (
                    <button
                      key={info.id}
                      type="button"
                      onClick={() =>
                        onPatchSettings({
                          camera: {
                            ...settings.camera,
                            backgroundMode: info.id,
                          },
                        })
                      }
                      className={`rounded-xl border p-4 text-left transition-all ${
                        selected
                          ? "border-[#f0623a] bg-[#e0532c]/14"
                          : "border-white/10 bg-[#181b23] hover:border-white/20"
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[13px] font-semibold text-white">
                          {info.title}
                        </span>
                        {selected && <Badge tone="ember">Active</Badge>}
                      </div>
                      <p className="mt-1.5 text-[11.5px] leading-relaxed text-[#a1a6b5]">
                        {info.mechanism}
                      </p>
                      <p className="mt-2 font-mono text-[10.5px] text-amber-300/90">
                        Limitation: {info.limitations}
                      </p>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        {/* 4. AUDIO */}
        {activeSection === "audio" && (
          <div className="space-y-6">
            <div>
              <div className="rail text-[#ff9d80]">SECTION 04 · AUDIO</div>
              <h2 className="mt-1 text-[20px] font-semibold text-white">
                Acoustic Snap Confirmation Engine
              </h2>
              <p className="mt-1 text-[13px] text-[#8b92a5]">
                Analyzes 1.8–4.2 kHz acoustic transients in volatile RAM to
                confirm physical finger snaps. Audio is never recorded, stored,
                or transmitted.
              </p>
            </div>

            <div className="space-y-4 rounded-xl border border-white/[0.07] bg-[#181b23] p-4">
              <Switch
                label="Enable Microphone Transient Confirmation"
                description="Allows Snap Vanish to monitor high-frequency snap transients against an adaptive room noise floor."
                checked={settings.audio.enabled}
                onChange={(v) =>
                  onPatchSettings({
                    audio: { ...settings.audio, enabled: v },
                  })
                }
              />
              <div className="border-t border-white/[0.06] pt-4">
                <Switch
                  label="Require Audio Confirmation for Hand Snaps"
                  description="When enabled, hand motion alone will not trigger vanish unless accompanied by a matching acoustic snap."
                  checked={settings.gesture.requireAudioConfirm}
                  disabled={!settings.audio.enabled}
                  onChange={(v) =>
                    onPatchSettings({
                      gesture: { ...settings.gesture, requireAudioConfirm: v },
                    })
                  }
                />
              </div>
              <div className="border-t border-white/[0.06] pt-4">
                <Switch
                  label="Allow Standalone Audio Trigger (Off-Camera Snap)"
                  description="Optional mode: triggers vanish from sharp snap transients even when your hand is outside the camera frame. Disabled by default to prevent desk-tap false positives."
                  checked={settings.audio.allowStandaloneAudioTrigger}
                  disabled={!settings.audio.enabled}
                  onChange={(v) =>
                    onPatchSettings({
                      audio: {
                        ...settings.audio,
                        allowStandaloneAudioTrigger: v,
                      },
                    })
                  }
                />
              </div>
            </div>

            <div className="rounded-xl border border-white/[0.07] bg-[#181b23] p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-[12.5px] font-medium text-[#e4e6ee]">
                  Live Bandpass Input Level (1.8–4.2 kHz)
                </span>
                <span className="font-mono text-[11.5px] text-[#9ca3b8]">
                  {audioMonitor.active
                    ? `Current: ${audioMonitor.currentDb} dBFS · Adaptive Floor: ${audioMonitor.floorDb} dBFS`
                    : "Mic monitor idle (starts automatically with Live Camera)"}
                </span>
              </div>
              <div className="mt-2.5 h-2.5 w-full overflow-hidden rounded-full bg-[#0e1016]">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-emerald-400 via-amber-400 to-[#f0623a] transition-all duration-100"
                  style={{ width: `${audioMonitor.levelPercent}%` }}
                />
              </div>
            </div>

            <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
              <SelectField
                label="Audio Input Device"
                value={settings.audio.preferredDeviceId}
                disabled={!settings.audio.enabled}
                onChange={(e) =>
                  onPatchSettings({
                    audio: {
                      ...settings.audio,
                      preferredDeviceId: e.target.value,
                    },
                  })
                }
              >
                <option value="">System Default Microphone</option>
                {audioDevices.map((m) => (
                  <option key={m.deviceId} value={m.deviceId}>
                    {m.label}
                  </option>
                ))}
              </SelectField>

              <RangeControl
                label="Acoustic Confirmation Window"
                displayValue={`${settings.audio.confirmWindowMs} ms`}
                min={100}
                max={500}
                step={20}
                disabled={!settings.audio.enabled}
                value={settings.audio.confirmWindowMs}
                hint="Max time gap between finger collapse and acoustic onset"
                onChange={(v) =>
                  onPatchSettings({
                    audio: { ...settings.audio, confirmWindowMs: v },
                  })
                }
              />

              <RangeControl
                label="Transient Sensitivity Threshold"
                displayValue={`+${settings.audio.sensitivityDb} dB`}
                min={6}
                max={28}
                step={1}
                disabled={!settings.audio.enabled}
                value={settings.audio.sensitivityDb}
                hint="Required spike above adaptive room noise floor (lower = more sensitive)"
                onChange={(v) =>
                  onPatchSettings({
                    audio: { ...settings.audio, sensitivityDb: v },
                  })
                }
              />

              <div className="flex flex-col justify-center gap-2 rounded-xl border border-white/[0.07] bg-[#181b23] p-4">
                <Button variant="secondary" onClick={runAudioTransientTest}>
                  <Volume2 className="h-4 w-4 text-[#f0623a]" />
                  Run Audio Confirmation Test
                </Button>
                {audioTestFeedback && (
                  <p className="text-[11.5px] text-emerald-300">
                    {audioTestFeedback}
                  </p>
                )}
              </div>
            </div>
          </div>
        )}

        {/* 5. ANIMATION */}
        {activeSection === "animation" && (
          <div className="space-y-6">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <div className="rail text-[#ff9d80]">SECTION 05 · ANIMATION</div>
                <h2 className="mt-1 text-[20px] font-semibold text-white">
                  Default Disintegration &amp; Reassembly Behavior
                </h2>
                <p className="mt-1 text-[13px] text-[#8b92a5]">
                  Adjust core transition defaults or open the full
                  Personalization Studio to create and manage custom presets.
                </p>
              </div>
              <Button variant="primary" onClick={onOpenStudioTab}>
                <Sparkles className="h-4 w-4" />
                Open Personalization Studio
              </Button>
            </div>

            <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
              <RangeControl
                label="Default Transition Duration"
                displayValue={`${settings.duration.toFixed(1)} s`}
                min={0.5}
                max={4.0}
                step={0.1}
                value={settings.duration}
                onChange={(v) => onPatchSettings({ duration: v })}
              />
              <RangeControl
                label="Motion Smoothness Curve"
                displayValue={`${settings.motionSmoothness}%`}
                min={0}
                max={100}
                step={5}
                value={settings.motionSmoothness}
                onChange={(v) => onPatchSettings({ motionSmoothness: v })}
              />
              <RangeControl
                label="Default Particle Density"
                displayValue={`${settings.density}%`}
                min={20}
                max={100}
                step={2}
                value={settings.density}
                onChange={(v) => onPatchSettings({ density: v })}
              />
              <RangeControl
                label="Animation Speed"
                displayValue={`${settings.speed.toFixed(1)}×`}
                min={0.5}
                max={2.5}
                step={0.1}
                value={settings.speed}
                onChange={(v) => onPatchSettings({ speed: v })}
              />
            </div>
          </div>
        )}

        {/* 6. PERFORMANCE */}
        {activeSection === "performance" && (
          <div className="space-y-6">
            <div>
              <div className="rail text-[#ff9d80]">SECTION 06 · PERFORMANCE</div>
              <h2 className="mt-1 text-[20px] font-semibold text-white">
                Laptop Battery, GPU &amp; Particle Pool Budgets
              </h2>
              <p className="mt-1 text-[13px] text-[#8b92a5]">
                Engineered for smooth real-time operation alongside WebRTC video
                encoding on everyday Windows and macOS laptops.
              </p>
            </div>

            <div className="space-y-4 rounded-xl border border-white/[0.07] bg-[#181b23] p-4">
              <Switch
                label="Low-Power Laptop Mode"
                description="Halves active particle draw budget, caps CV hand inference to 15 Hz, and skips secondary ember glow passes to conserve battery."
                checked={settings.lowPowerMode}
                onChange={(v) =>
                  onPatchSettings({
                    lowPowerMode: v,
                    performanceProfile: v ? "low-power" : "balanced",
                  })
                }
              />
              <div className="border-t border-white/[0.06] pt-4">
                <Switch
                  label="Pause Rendering &amp; Inference When Tab Is Hidden"
                  description="Hooks document visibilitychange to suspend non-essential canvas work while minimized."
                  checked={settings.pauseWhenHidden}
                  onChange={(v) => onPatchSettings({ pauseWhenHidden: v })}
                />
              </div>
            </div>

            <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
              <RangeControl
                label="Hand Landmark Inference Rate Cap"
                displayValue={`${settings.gesture.inferenceFpsLimit} Hz`}
                min={10}
                max={30}
                step={2}
                value={settings.gesture.inferenceFpsLimit}
                hint="24 Hz captures fast snaps cleanly while leaving GPU headroom for WebRTC"
                onChange={(v) =>
                  onPatchSettings({
                    gesture: { ...settings.gesture, inferenceFpsLimit: v },
                  })
                }
              />
              <RangeControl
                label="Maximum Pooled Particle Ceiling"
                displayValue={settings.maxParticles.toLocaleString()}
                min={4000}
                max={28000}
                step={1000}
                value={settings.maxParticles}
                hint="Pre-allocated typed particle pool size (takes effect on next frame capture)"
                onChange={(v) => onPatchSettings({ maxParticles: v })}
              />
            </div>
          </div>
        )}

        {/* 7. PRIVACY */}
        {activeSection === "privacy" && (
          <div className="space-y-6">
            <div>
              <div className="rail text-[#ff9d80]">SECTION 07 · PRIVACY</div>
              <h2 className="mt-1 text-[20px] font-semibold text-white">
                Verified Local-Only Privacy Controls
              </h2>
              <p className="mt-1 text-[13px] text-[#8b92a5]">
                Every privacy claim below corresponds directly to auditable
                source code in this repository.
              </p>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div className="rounded-xl border border-emerald-500/25 bg-emerald-500/10 p-3.5">
                <div className="font-mono text-[11px] text-emerald-300">
                  CAMERA &amp; MIC DATA
                </div>
                <div className="mt-1 text-[13px] font-semibold text-white">
                  RAM-Only · Never Recorded
                </div>
                <p className="mt-1 text-[11.5px] text-emerald-100/75">
                  No MediaRecorder, no cloud endpoints, no frame persistence.
                </p>
              </div>
              <div className="rounded-xl border border-emerald-500/25 bg-emerald-500/10 p-3.5">
                <div className="font-mono text-[11px] text-emerald-300">
                  ML MODEL ASSETS
                </div>
                <div className="mt-1 text-[13px] font-semibold text-white">
                  100% Bundled Locally
                </div>
                <p className="mt-1 text-[11.5px] text-emerald-100/75">
                  MediaPipe WASM &amp; TFLite load from chrome-extension:// URLs.
                </p>
              </div>
              <div className="rounded-xl border border-emerald-500/25 bg-emerald-500/10 p-3.5">
                <div className="font-mono text-[11px] text-emerald-300">
                  STORAGE SEPARATION
                </div>
                <div className="mt-1 text-[13px] font-semibold text-white">
                  Sync vs Local Isolated
                </div>
                <p className="mt-1 text-[11.5px] text-emerald-100/75">
                  Logs stay in chrome.storage.local and never enter sync.
                </p>
              </div>
            </div>

            <div className="space-y-4 rounded-xl border border-white/[0.07] bg-[#181b23] p-4">
              <Switch
                label="Strict Local-Only Enforcement"
                description="Blocks any optional remote sync endpoints so 100% of processing stays offline-capable."
                checked={settings.strictLocalOnly}
                onChange={(v) => onPatchSettings({ strictLocalOnly: v })}
              />
              <div className="border-t border-white/[0.06] pt-4">
                <Switch
                  label="Store Local Activity History Metadata"
                  description="Saves timestamps, preset names, and vanish counts strictly in local device storage. Never stores images or audio."
                  checked={settings.recordActivityHistory}
                  onChange={(v) =>
                    onPatchSettings({ recordActivityHistory: v })
                  }
                />
              </div>
              <div className="border-t border-white/[0.06] pt-4">
                <Switch
                  label="Store Local Diagnostic Ring Buffer"
                  description="Keeps the last 120 diagnostic state transitions locally to assist troubleshooting."
                  checked={settings.diagnosticLoggingEnabled}
                  onChange={(v) =>
                    onPatchSettings({ diagnosticLoggingEnabled: v })
                  }
                />
              </div>
            </div>

            <Button variant="danger" onClick={onClearLocalLogs}>
              <Trash2 className="h-4 w-4" />
              Purge Local Activity History &amp; Diagnostic Logs
            </Button>
          </div>
        )}

        {/* 8. KEYBOARD SHORTCUTS */}
        {activeSection === "shortcuts" && (
          <div className="space-y-6">
            <div>
              <div className="rail text-[#ff9d80]">
                SECTION 08 · KEYBOARD SHORTCUTS
              </div>
              <h2 className="mt-1 text-[20px] font-semibold text-white">
                Global Chrome Commands &amp; Emergency Fallback Keys
              </h2>
              <p className="mt-1 text-[13px] text-[#8b92a5]">
                Registered in <code className="font-mono text-white">manifest.json</code>{" "}
                under Chrome&apos;s native <code className="font-mono text-white">commands</code>{" "}
                API so shortcuts remain reliable even if camera lighting drops.
              </p>
            </div>

            <div className="divide-y divide-white/[0.07] rounded-xl border border-white/[0.07] bg-[#181b23]">
              {[
                {
                  title: "Toggle Snap Vanish Enabled / Standby",
                  keys: ["Alt", "Shift", "S"],
                  action: "toggle" as const,
                },
                {
                  title: "Trigger Manual Vanish / Return",
                  keys: ["Alt", "Shift", "D"],
                  action: "vanish" as const,
                },
                {
                  title: "Emergency Camera & Mic Restore",
                  keys: ["Alt", "Shift", "R"],
                  action: "restore" as const,
                },
              ].map((row) => (
                <div
                  key={row.action}
                  className="flex flex-wrap items-center justify-between gap-3 p-4"
                >
                  <div>
                    <div className="text-[13.5px] font-medium text-white">
                      {row.title}
                    </div>
                    <div className="mt-1 flex items-center gap-1.5">
                      {row.keys.map((k) => (
                        <Kbd key={k}>{k}</Kbd>
                      ))}
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => onTestShortcutAction(row.action)}
                  >
                    Test Action Now
                  </Button>
                </div>
              ))}
            </div>

            <p className="text-[12px] text-[#8b92a5]">
              To rebind global shortcuts in Chrome on Windows or macOS, visit{" "}
              <code className="rounded bg-white/5 px-1.5 py-0.5 font-mono text-[#ff9d80]">
                chrome://extensions/shortcuts
              </code>
              .
            </p>
          </div>
        )}

        {/* 9. ABOUT */}
        {activeSection === "about" && (
          <div className="space-y-6">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <div className="rail text-[#ff9d80]">SECTION 09 · ABOUT</div>
                <h2 className="mt-1 text-[20px] font-semibold text-white">
                  Snap Vanish 2.0.0 — Architecture &amp; Compatibility Matrix
                </h2>
                <p className="mt-1 text-[13px] text-[#8b92a5]">
                  Manifest V3 Chrome Extension · Local MediaPipe Tasks Vision
                  WASM · Pooled HTML5 Canvas Particle Engine.
                </p>
              </div>
              <Button variant="secondary" onClick={onOpenOnboarding}>
                Launch 8-Step Setup Guide
              </Button>
            </div>

            <div className="overflow-x-auto rounded-xl border border-white/[0.08]">
              <table className="w-full border-collapse text-left text-[12.5px]">
                <thead className="border-b border-white/[0.08] bg-[#181b23] font-mono text-[10.5px] uppercase text-[#8b92a5]">
                  <tr>
                    <th className="px-4 py-3">Platform</th>
                    <th className="px-4 py-3">Support Level</th>
                    <th className="px-4 py-3">Outgoing Stream Mechanism</th>
                    <th className="px-4 py-3">Fallback / Notes</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/[0.06] bg-[#13151c]">
                  {PLATFORM_COMPATIBILITY_MATRIX.map((row) => (
                    <tr key={row.id}>
                      <td className="px-4 py-3 font-medium text-white">
                        <div>{row.name}</div>
                        <div className="font-mono text-[10.5px] text-[#6c7284]">
                          {row.hostPatterns.join(", ")}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <Badge
                          tone={
                            row.classification === "Partially implemented"
                              ? "emerald"
                              : "amber"
                          }
                        >
                          {row.classification}
                        </Badge>
                      </td>
                      <td className="max-w-[34ch] px-4 py-3 text-[11.5px] text-[#c9cdd8]">
                        {row.outgoingStreamMethod}
                      </td>
                      <td className="max-w-[38ch] px-4 py-3 text-[11.5px] text-[#9ca3b8]">
                        {row.fallbackWorkflow}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}
