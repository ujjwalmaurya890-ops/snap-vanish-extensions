import SnapMark from "./SnapMark";
import type { Direction, EffectType } from "../lib/dust";
import type {
  EffectPreset,
  MeetingModeId,
  SnapSettings,
} from "../types/snapVanish";
import { BUILT_IN_PRESETS, MEETING_MODES } from "../lib/settings";
import type { SnapStatus } from "./SnapStage";

export type Settings = SnapSettings;

type Props = {
  settings: SnapSettings;
  presets?: EffectPreset[];
  selectedPresetId?: string;
  onSelectPreset?: (preset: EffectPreset) => void;
  onSelectMeetingMode?: (modeId: Exclude<MeetingModeId, "custom">) => void;
  onChange: (patch: Partial<SnapSettings>) => void;
  onSnap: () => void;
  onEmergencyRestore?: () => void;
  onOpenDashboard?: (tab?: string) => void;
  onOpenOnboarding?: () => void;
  status: SnapStatus;
  extensionBridgeConnected?: boolean;
  errorMessage?: string | null;
};

const DIRECTIONS: { id: Direction; glyph: string; name: string }[] = [
  { id: "left", glyph: "←", name: "Left" },
  { id: "up", glyph: "↑", name: "Up" },
  { id: "right", glyph: "→", name: "Right" },
  { id: "down", glyph: "↓", name: "Down" },
  { id: "toward", glyph: "◎", name: "Camera" },
];

const EFFECT_OPTIONS: { id: EffectType; label: string }[] = [
  { id: "dust", label: "Dust Particles" },
  { id: "pixel-dissolve", label: "Pixel Dissolve" },
  { id: "digital-glitch", label: "Digital Glitch" },
  { id: "fade-out", label: "Studio Fade-Out" },
  { id: "light-burst", label: "Solar Light-Burst" },
];

const STATUS_BADGE: Record<
  SnapStatus,
  { text: string; classes: string }
> = {
  idle: {
    text: "LIVE",
    classes: "border-emerald-500/40 bg-emerald-500/15 text-emerald-300",
  },
  vanishing: {
    text: "VANISHING",
    classes: "border-amber-500/40 bg-amber-500/15 text-amber-300",
  },
  gone: {
    text: "VANISHED",
    classes: "border-violet-500/40 bg-violet-500/20 text-violet-200",
  },
  returning: {
    text: "RESTORING",
    classes: "border-amber-500/40 bg-amber-500/15 text-amber-300",
  },
};

export default function VanishPopup({
  settings,
  presets = BUILT_IN_PRESETS,
  selectedPresetId = "",
  onSelectPreset,
  onSelectMeetingMode,
  onChange,
  onSnap,
  onEmergencyRestore,
  onOpenDashboard,
  onOpenOnboarding,
  status,
  extensionBridgeConnected = false,
  errorMessage = null,
}: Props) {
  const micMuted =
    settings.muteOnVanish && (status === "vanishing" || status === "gone");
  const isTransitioning = status === "vanishing" || status === "returning";
  const badge = !settings.enabled
    ? {
        text: "DISABLED",
        classes: "border-slate-600/40 bg-slate-700/30 text-slate-400",
      }
    : STATUS_BADGE[status];

  return (
    <div
      className="w-[360px] select-none overflow-hidden rounded-[14px] border border-white/10 bg-[#0d0e14] font-sans text-[#f3f4f8] shadow-[0_30px_60px_-20px_rgba(0,0,0,0.75),0_10px_24px_-10px_rgba(124,58,237,0.25)]"
      role="region"
      aria-label="Snap Vanish Extension Popup"
    >
      {/* Header */}
      <div className="flex items-center gap-3 border-b border-white/10 bg-[#151722] px-4 py-3.5">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[8px] bg-gradient-to-br from-violet-600 to-[#d2451e] text-white shadow-inner">
          <SnapMark className="h-[18px] w-[18px]" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-[13.5px] font-semibold tracking-[-0.01em] text-white">
              Snap Vanish
            </span>
            <span
              className={`rounded-full border px-2 py-[1px] font-mono text-[9.5px] font-semibold tracking-[0.08em] ${badge.classes}`}
            >
              {badge.text}
            </span>
          </div>
          <div className="mt-0.5 truncate text-[11px] text-[#9ca3b8]">
            {extensionBridgeConnected
              ? "Chrome Extension Bridge · Active"
              : "Interactive Studio Preview · Local Storage"}
          </div>
        </div>
        <Toggle
          on={settings.enabled}
          onChange={(v) => onChange({ enabled: v })}
          label="Master extension switch"
        />
      </div>

      {/* Error / Recovery Alert */}
      {errorMessage && (
        <div
          role="alert"
          className="flex items-center justify-between gap-2 border-b border-red-500/30 bg-red-500/15 px-4 py-2 text-[11px] text-red-200"
        >
          <span className="truncate">{errorMessage}</span>
          {onEmergencyRestore && (
            <button
              type="button"
              onClick={onEmergencyRestore}
              className="shrink-0 rounded border border-red-400/40 px-2 py-0.5 font-medium text-red-100 hover:bg-red-500/25"
            >
              Recover
            </button>
          )}
        </div>
      )}

      {/* Primary Action + Emergency Restore */}
      <div className="px-4 pt-4">
        <div className="grid grid-cols-[1fr_auto] gap-2">
          <button
            type="button"
            onClick={onSnap}
            disabled={!settings.enabled || isTransitioning}
            className="flex items-center justify-center gap-2 rounded-[8px] bg-gradient-to-r from-violet-600 to-indigo-600 px-4 py-2.5 text-[13px] font-semibold text-white transition-all hover:from-violet-500 hover:to-indigo-500 disabled:cursor-not-allowed disabled:from-slate-800 disabled:to-slate-800 disabled:text-slate-500"
          >
            <SnapMark className="h-4 w-4" />
            {!settings.enabled
              ? "Extension Off"
              : status === "gone"
                ? "Restore Camera"
                : isTransitioning
                  ? "Transitioning…"
                  : "Vanish Now"}
          </button>
          <button
            type="button"
            onClick={onEmergencyRestore}
            className="rounded-[8px] border border-red-500/35 bg-red-500/15 px-3 py-2.5 text-[11.5px] font-semibold text-red-200 transition-colors hover:bg-red-500/25"
            title="Emergency Restore to live feed (Alt+Shift+R)"
          >
            Restore
          </button>
        </div>

        {/* Shortcut guidance */}
        <div className="mt-2.5 grid grid-cols-2 gap-x-3 gap-y-1 rounded-[7px] border border-white/10 bg-[#151722] px-2.5 py-2 text-[10.5px] text-[#9ca3b8]">
          <div className="flex items-center justify-between">
            <span>Toggle</span>
            <kbd className="rounded border border-white/10 bg-[#1c1f2e] px-1.5 py-0.5 font-mono text-[9.5px] text-white">
              Alt+Shift+S
            </kbd>
          </div>
          <div className="flex items-center justify-between">
            <span>Restore</span>
            <kbd className="rounded border border-white/10 bg-[#1c1f2e] px-1.5 py-0.5 font-mono text-[9.5px] text-white">
              Alt+Shift+R
            </kbd>
          </div>
        </div>
      </div>

      {/* Effect & Preset Selectors */}
      <div className="mt-3.5 grid grid-cols-2 gap-2.5 px-4">
        <div>
          <label
            htmlFor="popup-effect-select"
            className="mb-1 block text-[11px] font-medium text-[#9ca3b8]"
          >
            Effect Engine
          </label>
          <select
            id="popup-effect-select"
            value={settings.effect}
            disabled={!settings.enabled}
            onChange={(e) =>
              onChange({
                effect: e.target.value as EffectType,
                meetingMode: "custom",
              })
            }
            className="w-full rounded-[7px] border border-white/10 bg-[#151722] px-2.5 py-1.5 text-[11.5px] text-white disabled:opacity-45"
          >
            {EFFECT_OPTIONS.map((opt) => (
              <option key={opt.id} value={opt.id}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label
            htmlFor="popup-preset-select"
            className="mb-1 block text-[11px] font-medium text-[#9ca3b8]"
          >
            Saved Preset
          </label>
          <select
            id="popup-preset-select"
            value={selectedPresetId}
            disabled={!settings.enabled}
            onChange={(e) => {
              const found = presets.find((p) => p.id === e.target.value);
              if (found) {
                if (onSelectPreset) {
                  onSelectPreset(found);
                } else {
                  onChange({ ...found.config, meetingMode: "custom" });
                }
              }
            }}
            className="w-full rounded-[7px] border border-white/10 bg-[#151722] px-2.5 py-1.5 text-[11.5px] text-white disabled:opacity-45"
          >
            <option value="">Custom Configuration</option>
            {presets.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Smart Meeting Modes */}
      <div className="mt-3.5 px-4">
        <div className="mb-1.5 flex items-center justify-between">
          <span className="text-[11px] font-medium text-[#9ca3b8]">
            Smart Meeting Mode
          </span>
          <span className="font-mono text-[10px] uppercase tracking-wider text-violet-400">
            {settings.meetingMode}
          </span>
        </div>
        <div className="grid grid-cols-4 gap-1.5">
          {(
            ["professional", "creative", "minimal", "low-power"] as Exclude<
              MeetingModeId,
              "custom"
            >[]
          ).map((modeKey) => {
            const mode = MEETING_MODES[modeKey];
            const active = settings.meetingMode === modeKey;
            return (
              <button
                key={modeKey}
                type="button"
                disabled={!settings.enabled}
                onClick={() => {
                  if (onSelectMeetingMode) {
                    onSelectMeetingMode(modeKey);
                  } else {
                    onChange(mode.settingsPatch);
                  }
                }}
                className={`rounded-[6px] border px-1.5 py-1.5 text-[10.5px] font-medium transition-colors disabled:opacity-45 ${
                  active
                    ? "border-violet-500 bg-violet-600/25 text-violet-200"
                    : "border-white/10 bg-[#151722] text-[#9ca3b8] hover:border-white/20 hover:text-white"
                }`}
              >
                {mode.name}
              </button>
            );
          })}
        </div>
      </div>

      <div className="mx-4 my-3.5 h-px bg-white/10" />

      {/* Sliders */}
      <div className="space-y-3.5 px-4">
        <Slider
          label="Snap sensitivity"
          display={`${settings.sensitivity}`}
          min={0}
          max={100}
          value={settings.sensitivity}
          onChange={(v) =>
            onChange({
              sensitivity: v,
              gesture: { ...settings.gesture, sensitivity: v },
            })
          }
          disabled={!settings.enabled}
          caption="Higher = stricter finger-snap confirmation"
        />
        <Slider
          label="Effect duration"
          display={`${settings.duration.toFixed(1)} s`}
          min={0.5}
          max={4}
          step={0.1}
          value={settings.duration}
          onChange={(v) => onChange({ duration: v, meetingMode: "custom" })}
          disabled={!settings.enabled}
          caption="Disintegration + reassembly time"
        />
        <Slider
          label="Particle density"
          display={`${settings.lowPowerMode ? Math.min(35, settings.density) : settings.density}%`}
          min={20}
          max={100}
          step={5}
          value={settings.density}
          onChange={(v) => onChange({ density: v, meetingMode: "custom" })}
          disabled={!settings.enabled}
          caption={
            settings.lowPowerMode
              ? "Capped at 35% while Low-Power mode is active"
              : "Active particle & block density"
          }
        />
      </div>

      {/* Direction */}
      <div className="px-4 pt-3.5">
        <div className="mb-1.5 text-[11px] font-medium text-[#9ca3b8]">
          Drift direction
        </div>
        <div
          className="grid grid-cols-5 overflow-hidden rounded-[8px] border border-white/10"
          role="radiogroup"
          aria-label="Drift direction"
        >
          {DIRECTIONS.map((d) => {
            const active = settings.direction === d.id;
            return (
              <button
                key={d.id}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => onChange({ direction: d.id })}
                disabled={!settings.enabled}
                title={d.name}
                className={`flex flex-col items-center gap-0.5 border-r border-white/10 py-2 text-[11px] transition-colors last:border-r-0 disabled:opacity-45 ${
                  active
                    ? "bg-violet-600 text-white"
                    : "bg-[#151722] text-[#9ca3b8] hover:bg-[#1c1f2e] hover:text-white"
                }`}
              >
                <span className="text-[14px] leading-none">{d.glyph}</span>
                <span className="text-[9px] tracking-[0.04em]">{d.name}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Quick Toggles */}
      <div className="mt-3.5 space-y-2 border-t border-white/10 px-4 py-2.5">
        <label className="flex cursor-pointer items-center justify-between gap-2 text-[11px] text-[#9ca3b8]">
          <span>Play snap click &amp; require mic confirmation</span>
          <input
            type="checkbox"
            checked={settings.sound}
            disabled={!settings.enabled}
            onChange={(e) => onChange({ sound: e.target.checked })}
            className="h-3.5 w-3.5 accent-violet-500"
          />
        </label>
        <label className="flex cursor-pointer items-center justify-between gap-2 text-[11px] text-[#9ca3b8]">
          <span>Low-Power mode (laptop battery saver)</span>
          <input
            type="checkbox"
            checked={settings.lowPowerMode}
            disabled={!settings.enabled}
            onChange={(e) =>
              onChange({
                lowPowerMode: e.target.checked,
                meetingMode: e.target.checked ? "low-power" : "custom",
              })
            }
            className="h-3.5 w-3.5 accent-violet-500"
          />
        </label>
      </div>

      {/* Status & Advanced Dashboard Link */}
      <div className="flex items-center justify-between border-t border-white/10 bg-[#151722] px-4 py-2.5">
        <div className="flex items-center gap-2">
          <span
            className={`h-[7px] w-[7px] rounded-full ${
              micMuted ? "bg-[#e0532c]" : "bg-emerald-400"
            }`}
          />
          <span className="text-[11px] text-[#f3f4f8]">
            {micMuted ? "Mic muted" : "Mic live"}
          </span>
          <span className="text-[10px] text-[#687089]">· 0 B EGRESS</span>
        </div>

        <div className="flex items-center gap-2">
          {onOpenOnboarding && (
            <button
              type="button"
              onClick={onOpenOnboarding}
              className="text-[10.5px] font-medium text-[#9ca3b8] underline-offset-2 hover:text-white hover:underline"
            >
              Setup Guide
            </button>
          )}
          {onOpenDashboard && (
            <button
              type="button"
              onClick={() => onOpenDashboard("studio")}
              className="rounded bg-violet-500/20 px-2 py-1 text-[10.5px] font-semibold text-violet-300 transition-colors hover:bg-violet-500/30"
            >
              Studio &amp; Dashboard →
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function Toggle({
  on,
  onChange,
  label,
}: {
  on: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={() => onChange(!on)}
      className={`relative h-[22px] w-[38px] shrink-0 rounded-full border border-white/10 transition-colors ${
        on ? "bg-violet-600" : "bg-[#2b2f42]"
      }`}
    >
      <span
        className={`absolute top-[2px] h-4 w-4 rounded-full bg-white shadow transition-all ${
          on ? "left-[18px]" : "left-[2px]"
        }`}
      />
    </button>
  );
}

function Slider({
  label,
  display,
  min,
  max,
  step = 1,
  value,
  onChange,
  disabled,
  caption,
}: {
  label: string;
  display: string;
  min: number;
  max: number;
  step?: number;
  value: number;
  onChange: (v: number) => void;
  disabled?: boolean;
  caption: string;
}) {
  return (
    <div className={disabled ? "opacity-45" : ""}>
      <div className="flex items-baseline justify-between">
        <span className="text-[11px] font-medium text-[#9ca3b8]">{label}</span>
        <span className="font-mono text-[11px] font-semibold tabular-nums text-violet-300">
          {display}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        aria-label={label}
        onChange={(e) => onChange(Number(e.target.value))}
        className="mt-0.5"
      />
      <div className="text-[9.5px] tracking-[0.02em] text-[#687089]">
        {caption}
      </div>
    </div>
  );
}
