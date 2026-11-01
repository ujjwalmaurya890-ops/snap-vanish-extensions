import { RotateCcw, Settings, Sparkles } from "lucide-react";
import { SnapMark } from "./SnapMark";
import type { SnapStatus } from "./SnapStage";
import type { EffectPreset } from "../types/snapVanish";

type Props = {
  enabled: boolean;
  setEnabled: (v: boolean) => void;
  sensitivity: number;
  setSensitivity: (v: number) => void;
  audioConfirm: boolean;
  setAudioConfirm: (v: boolean) => void;
  activePresetId: string;
  presets: EffectPreset[];
  onSelectPreset: (preset: EffectPreset) => void;
  status: SnapStatus;
  activePlatform?: string;
  onSnap: () => void;
  onEmergencyRestore: () => void;
  onOpenSettings?: () => void;
};

/**
 * Interactive preview of the compact Chrome Extension Toolbar Popup
 * (`extension/popup/popup.html`), sharing exact controls and visual language.
 */
export default function VanishPopup({
  enabled,
  setEnabled,
  sensitivity,
  setSensitivity,
  audioConfirm,
  setAudioConfirm,
  activePresetId,
  presets,
  onSelectPreset,
  status,
  activePlatform = "Google Meet (Ready)",
  onSnap,
  onEmergencyRestore,
  onOpenSettings,
}: Props) {
  const busy = status === "vanishing" || status === "returning";

  return (
    <div
      aria-label="Snap Vanish Chrome toolbar popup preview"
      className="mx-auto w-full max-w-[336px] overflow-hidden rounded-2xl border border-white/[0.1] bg-[#111319] text-[#f4f4f6] shadow-[0_24px_60px_-20px_rgba(0,0,0,0.85)]"
    >
      <div className="flex items-center justify-between border-b border-white/[0.08] bg-[#161922] px-4 py-3">
        <div className="flex items-center gap-2.5">
          <SnapMark size={20} />
          <div>
            <div className="text-[13px] font-semibold leading-tight text-white">
              Snap Vanish
            </div>
            <div className="font-mono text-[10px] text-[#8b92a5]">
              v2.0 · MV3 LOCAL AI
            </div>
          </div>
        </div>

        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label="Enable Snap Vanish extension"
          onClick={() => setEnabled(!enabled)}
          className={`relative h-6 w-11 rounded-full border transition-colors ${
            enabled
              ? "border-[#f0623a]/60 bg-[#e0532c]"
              : "border-white/10 bg-[#252833]"
          }`}
        >
          <span
            className={`absolute top-[2px] h-[18px] w-[18px] rounded-full bg-white transition-transform ${
              enabled ? "translate-x-[21px]" : "translate-x-[2px]"
            }`}
          />
        </button>
      </div>

      <div className="flex items-center justify-between border-b border-white/[0.06] bg-[#0d0f14] px-4 py-2 font-mono text-[10.5px]">
        <span className="flex items-center gap-1.5">
          <span
            className={`h-2 w-2 rounded-full ${
              !enabled
                ? "bg-zinc-500"
                : status === "gone"
                  ? "bg-amber-400"
                  : "bg-emerald-400"
            }`}
          />
          <span className="uppercase text-[#d4d7e0]">
            {!enabled
              ? "Paused"
              : status === "gone"
                ? "Vanished"
                : status === "idle"
                  ? "Armed · Ready"
                  : "Transitioning"}
          </span>
        </span>
        <span className="truncate text-[#8b92a5]">{activePlatform}</span>
      </div>

      <div className="space-y-3.5 p-4">
        <div>
          <label
            htmlFor="popup-preset-select"
            className="block font-mono text-[10px] uppercase tracking-wider text-[#8b92a5]"
          >
            Active Effect Preset
          </label>
          <select
            id="popup-preset-select"
            value={activePresetId}
            disabled={!enabled}
            onChange={(e) => {
              const found = presets.find((p) => p.id === e.target.value);
              if (found) onSelectPreset(found);
            }}
            className="mt-1 w-full rounded-xl border border-white/10 bg-[#1a1d26] px-3 py-2 text-[12.5px] text-white disabled:opacity-45"
          >
            {presets.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
            {activePresetId === "custom" && (
              <option value="custom">Custom Studio Profile</option>
            )}
          </select>
        </div>

        <div>
          <div className="flex justify-between text-[12px]">
            <span className="text-[#c9cdd8]">Snap Sensitivity</span>
            <span className="font-mono text-[#ff9d80]">{sensitivity}/100</span>
          </div>
          <input
            type="range"
            min={1}
            max={100}
            value={sensitivity}
            disabled={!enabled}
            aria-label="Popup snap sensitivity"
            onChange={(e) => setSensitivity(Number(e.target.value))}
            className="mt-1"
          />
        </div>

        <div className="flex items-center justify-between rounded-xl border border-white/[0.06] bg-[#171a22] px-3 py-2">
          <span className="text-[12px] text-[#c9cdd8]">
            Acoustic Snap Confirm
          </span>
          <button
            type="button"
            disabled={!enabled}
            onClick={() => setAudioConfirm(!audioConfirm)}
            className={`rounded-md px-2 py-0.5 font-mono text-[10.5px] ${
              audioConfirm
                ? "bg-emerald-500/20 text-emerald-300"
                : "bg-white/5 text-[#8b92a5]"
            }`}
          >
            {audioConfirm ? "ON" : "OFF"}
          </button>
        </div>

        <div className="grid grid-cols-2 gap-2 pt-1">
          <button
            type="button"
            onClick={onSnap}
            disabled={!enabled || busy}
            className={`inline-flex items-center justify-center gap-1.5 rounded-xl px-3 py-2.5 text-[12px] font-semibold transition-all ${
              enabled && !busy
                ? "bg-gradient-to-b from-[#f0623a] to-[#d2451e] text-white hover:from-[#ff764f] hover:to-[#e0532c]"
                : "cursor-not-allowed bg-white/5 text-white/35"
            }`}
          >
            <Sparkles className="h-3.5 w-3.5" />
            {status === "gone" ? "Return" : "Test Vanish"}
          </button>

          <button
            type="button"
            onClick={onEmergencyRestore}
            className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-red-500/35 bg-red-500/15 px-3 py-2.5 text-[12px] font-medium text-red-200 hover:bg-red-500/25"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            Restore
          </button>
        </div>
      </div>

      <div className="flex items-center justify-between border-t border-white/[0.07] bg-[#161922] px-4 py-2.5">
        <span className="font-mono text-[10px] text-[#6c7284]">
          Alt+Shift+D · Alt+Shift+R
        </span>
        {onOpenSettings && (
          <button
            type="button"
            onClick={onOpenSettings}
            className="inline-flex items-center gap-1 font-mono text-[10.5px] text-[#ff9d80] hover:underline"
          >
            <Settings className="h-3 w-3" />
            Dashboard &amp; Settings
          </button>
        )}
      </div>
    </div>
  );
}
