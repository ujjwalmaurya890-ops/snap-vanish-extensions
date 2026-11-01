import { useState } from "react";
import { Copy, Plus, Sparkles, Trash2 } from "lucide-react";
import {
  Badge,
  Button,
  Card,
  RangeControl,
  SelectField,
} from "../../components/ui/DesignSystem";
import type {
  Direction,
  EffectPreset,
  EffectType,
  SnapSettings,
} from "../../types/snapVanish";

interface PersonalizationStudioProps {
  settings: SnapSettings;
  presets: EffectPreset[];
  activePresetId: string;
  onPatchSettings: (patch: Partial<SnapSettings>) => void;
  onSelectPreset: (preset: EffectPreset) => void;
  onSavePreset: (name: string, description: string) => void;
  onDuplicatePreset: (preset: EffectPreset) => void;
  onDeletePreset: (id: string) => void;
  onPreviewEffect: () => void;
}

const ACCENT_SWATCHES = [
  { hex: "#d2451e", label: "Warm Ember" },
  { hex: "#f0623a", label: "Solar Copper" },
  { hex: "#f59e0b", label: "Amber Glow" },
  { hex: "#e5e7eb", label: "Silver Ash" },
  { hex: "#10b981", label: "Emerald" },
  { hex: "#38bdf8", label: "Ice Cyan" },
];

const EFFECT_OPTIONS: Array<{
  value: EffectType;
  label: string;
  summary: string;
}> = [
  {
    value: "dust",
    label: "Classic Dust",
    summary: "Balanced organic dust + polygon fragments with coherent curl.",
  },
  {
    value: "cinematic-disintegration",
    label: "Cinematic Disintegration",
    summary: "Dramatic ember-rimmed fracture sweep with rotational shards.",
  },
  {
    value: "fine-particles",
    label: "Fine Particles",
    summary: "High-count micro-grain mist with smooth laminar dispersion.",
  },
  {
    value: "light-burst",
    label: "Energy Burst",
    summary: "Warm radial kinetic release with luminous core bloom.",
  },
  {
    value: "fade-out",
    label: "Gentle Fade",
    summary: "Subtle low-distraction dissolve ideal for executive meetings.",
  },
  {
    value: "pixel-dissolve",
    label: "Voxel Dissolve",
    summary: "Crisp quantized geometric tile lift with clean edges.",
  },
  {
    value: "digital-glitch",
    label: "Digital Glitch",
    summary: "Horizontal scanline shear and chromatic displacement.",
  },
];

export default function PersonalizationStudio({
  settings,
  presets,
  activePresetId,
  onPatchSettings,
  onSelectPreset,
  onSavePreset,
  onDuplicatePreset,
  onDeletePreset,
  onPreviewEffect,
}: PersonalizationStudioProps) {
  const [newName, setNewName] = useState("");
  const [newDesc, setNewDesc] = useState("");

  const handleSave = () => {
    const trimmed = newName.trim();
    if (!trimmed) return;
    onSavePreset(
      trimmed,
      newDesc.trim() || `${settings.effect} · ${settings.duration.toFixed(1)}s`,
    );
    setNewName("");
    setNewDesc("");
  };

  return (
    <div className="space-y-6">
      <Card padding="lg">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="rail text-[#ff9d80]">PERSONALIZATION STUDIO</div>
            <h2 className="mt-1 text-[20px] font-semibold text-white">
              Particle Physics &amp; Preset Library
            </h2>
            <p className="mt-1 max-w-[62ch] text-[13px] text-[#9ca3b8]">
              Every parameter updates the pooled canvas particle engine in real
              time. Built-in presets cover all 6 signature disintegration styles,
              and custom presets persist cleanly in Chrome storage.
            </p>
          </div>
          <Button variant="primary" onClick={onPreviewEffect}>
            <Sparkles className="h-4 w-4" />
            Test Transition on Stage
          </Button>
        </div>

        {/* Presets Grid */}
        <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {presets.map((preset) => {
            const active = activePresetId === preset.id;
            return (
              <div
                key={preset.id}
                className={`group flex flex-col justify-between rounded-xl border p-3.5 transition-all ${
                  active
                    ? "border-[#f0623a]/70 bg-[#e0532c]/12 shadow-[0_0_24px_-10px_rgba(240,98,58,0.5)]"
                    : "border-white/[0.08] bg-[#181b23] hover:border-white/[0.18]"
                }`}
              >
                <button
                  type="button"
                  onClick={() => onSelectPreset(preset)}
                  className="text-left"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex items-center gap-2 text-[13.5px] font-semibold text-white">
                      <span
                        className="h-2.5 w-2.5 rounded-full"
                        style={{ backgroundColor: preset.config.colorAccent }}
                      />
                      {preset.name}
                    </span>
                    {preset.isBuiltIn ? (
                      <Badge tone={active ? "ember" : "neutral"}>Built-in</Badge>
                    ) : (
                      <Badge tone="emerald">Custom</Badge>
                    )}
                  </div>
                  <p className="mt-1.5 line-clamp-2 text-[11.5px] leading-relaxed text-[#8b92a5]">
                    {preset.description}
                  </p>
                </button>

                <div className="mt-3 flex items-center justify-between border-t border-white/[0.06] pt-2.5 font-mono text-[10.5px] text-[#6c7284]">
                  <span>
                    {preset.config.duration.toFixed(1)}s · {preset.config.density}%
                  </span>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => onDuplicatePreset(preset)}
                      title="Duplicate preset"
                      aria-label={`Duplicate ${preset.name}`}
                      className="rounded p-1 text-[#8b92a5] hover:bg-white/10 hover:text-white"
                    >
                      <Copy className="h-3.5 w-3.5" />
                    </button>
                    {!preset.isBuiltIn && (
                      <button
                        type="button"
                        onClick={() => onDeletePreset(preset.id)}
                        title="Delete custom preset"
                        aria-label={`Delete ${preset.name}`}
                        className="rounded p-1 text-red-400 hover:bg-red-500/15 hover:text-red-200"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </Card>

      {/* Parameter Controls + Save Custom Preset */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        <Card padding="lg" className="space-y-5 lg:col-span-8">
          <div className="rail text-[#ff9d80]">FINE-GRAINED PARTICLE CONTROLS</div>

          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
            <SelectField
              label="Disintegration Renderer"
              value={settings.effect}
              hint={
                EFFECT_OPTIONS.find((o) => o.value === settings.effect)?.summary
              }
              onChange={(e) =>
                onPatchSettings({
                  effect: e.target.value as EffectType,
                  meetingMode: "custom",
                })
              }
            >
              {EFFECT_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </SelectField>

            <SelectField
              label="Drift Vector Direction"
              value={settings.direction}
              hint="Primary dispersion trajectory for fine dust and shards"
              onChange={(e) =>
                onPatchSettings({
                  direction: e.target.value as Direction,
                  meetingMode: "custom",
                })
              }
            >
              <option value="right">Rightward Thermal Wind</option>
              <option value="left">Leftward Crosswind</option>
              <option value="up">Vertical Thermal Lift</option>
              <option value="down">Downward Ash Fall</option>
              <option value="toward">Radial Outward (Toward Lens)</option>
            </SelectField>
          </div>

          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
            <RangeControl
              label="Particle Density"
              displayValue={`${settings.density}%`}
              min={20}
              max={100}
              step={2}
              value={settings.density}
              hint="Controls active ratio of pooled foreground particles"
              onChange={(v) =>
                onPatchSettings({ density: v, meetingMode: "custom" })
              }
            />
            <RangeControl
              label="Transition Duration"
              displayValue={`${settings.duration.toFixed(1)} s`}
              min={0.5}
              max={4.0}
              step={0.1}
              value={settings.duration}
              hint="Total sweep time from intact live feed to clean room plate"
              onChange={(v) =>
                onPatchSettings({ duration: v, meetingMode: "custom" })
              }
            />
            <RangeControl
              label="Animation Speed Multiplier"
              displayValue={`${settings.speed.toFixed(1)}×`}
              min={0.5}
              max={2.5}
              step={0.1}
              value={settings.speed}
              hint="Scales particle velocity and fracture wave propagation"
              onChange={(v) =>
                onPatchSettings({ speed: v, meetingMode: "custom" })
              }
            />
            <RangeControl
              label="Particle &amp; Shard Size"
              displayValue={`${settings.particleSize.toFixed(1)}×`}
              min={0.5}
              max={3.0}
              step={0.1}
              value={settings.particleSize}
              hint="Balances fine atmospheric dust against larger polygon shards"
              onChange={(v) =>
                onPatchSettings({ particleSize: v, meetingMode: "custom" })
              }
            />
            <RangeControl
              label="Turbulence &amp; Curl Intensity"
              displayValue={`${settings.intensity}%`}
              min={10}
              max={100}
              step={5}
              value={settings.intensity}
              hint="Controls vortex curl amplitude and shard angular velocity"
              onChange={(v) =>
                onPatchSettings({ intensity: v, meetingMode: "custom" })
              }
            />
            <RangeControl
              label="Motion Smoothness (Easing)"
              displayValue={`${settings.motionSmoothness}%`}
              min={0}
              max={100}
              step={5}
              value={settings.motionSmoothness}
              hint="0% snappy ballistic launch · 100% silky S-curve accel/decel"
              onChange={(v) =>
                onPatchSettings({
                  motionSmoothness: v,
                  meetingMode: "custom",
                })
              }
            />
          </div>

          <div className="border-t border-white/[0.06] pt-4">
            <div className="mb-2.5 flex items-center justify-between">
              <span className="text-[12.5px] font-medium text-[#c9cdd8]">
                Fracture Rim &amp; Ember Accent Color
              </span>
              <span className="font-mono text-[12px] uppercase text-[#ff9d80]">
                {settings.colorAccent}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-2.5">
              {ACCENT_SWATCHES.map((sw) => {
                const selected =
                  settings.colorAccent.toLowerCase() === sw.hex.toLowerCase();
                return (
                  <button
                    key={sw.hex}
                    type="button"
                    onClick={() =>
                      onPatchSettings({
                        colorAccent: sw.hex,
                        meetingMode: "custom",
                      })
                    }
                    className={`inline-flex items-center gap-2 rounded-xl border px-3 py-1.5 text-[12px] transition-all ${
                      selected
                        ? "border-white/50 bg-white/10 text-white"
                        : "border-white/10 bg-[#181b23] text-[#9ca3b8] hover:border-white/25"
                    }`}
                  >
                    <span
                      className="h-3 w-3 rounded-full"
                      style={{ backgroundColor: sw.hex }}
                    />
                    {sw.label}
                  </button>
                );
              })}
              <label className="inline-flex cursor-pointer items-center gap-2 rounded-xl border border-white/10 bg-[#181b23] px-3 py-1.5 text-[12px] text-[#c9cdd8] hover:border-white/25">
                <input
                  type="color"
                  value={settings.colorAccent}
                  aria-label="Custom accent hex color"
                  onChange={(e) =>
                    onPatchSettings({
                      colorAccent: e.target.value,
                      meetingMode: "custom",
                    })
                  }
                  className="h-4 w-5 cursor-pointer border-0 bg-transparent p-0"
                />
                Custom Hex
              </label>
            </div>
          </div>
        </Card>

        <Card padding="lg" className="space-y-4 lg:col-span-4">
          <div className="rail text-[#ff9d80]">SAVE CUSTOM PRESET</div>
          <h3 className="text-[16px] font-semibold text-white">
            Store Current Physics Profile
          </h3>
          <p className="text-[12.5px] leading-relaxed text-[#8b92a5]">
            Save your current renderer, drift direction, density, smoothness, and
            ember rim color so you can switch to it with one click from the
            Dashboard or Chrome Toolbar Popup.
          </p>

          <div className="space-y-3 pt-1">
            <div>
              <label
                htmlFor="preset-name-input"
                className="block text-[12px] font-medium text-[#c9cdd8]"
              >
                Preset Name
              </label>
              <input
                id="preset-name-input"
                type="text"
                maxLength={40}
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="e.g., Warm Obsidian Drift"
                className="mt-1 w-full rounded-xl border border-white/10 bg-[#181b23] px-3 py-2 text-[13px] text-white placeholder-[#5e6478] focus:border-[#f0623a]"
              />
            </div>

            <div>
              <label
                htmlFor="preset-desc-input"
                className="block text-[12px] font-medium text-[#c9cdd8]"
              >
                Short Description (Optional)
              </label>
              <input
                id="preset-desc-input"
                type="text"
                maxLength={120}
                value={newDesc}
                onChange={(e) => setNewDesc(e.target.value)}
                placeholder="Smooth ember sweep for daily standups"
                className="mt-1 w-full rounded-xl border border-white/10 bg-[#181b23] px-3 py-2 text-[13px] text-white placeholder-[#5e6478] focus:border-[#f0623a]"
              />
            </div>

            <Button
              variant="primary"
              className="w-full"
              disabled={!newName.trim()}
              onClick={handleSave}
            >
              <Plus className="h-4 w-4" />
              Save Custom Preset
            </Button>
          </div>
        </Card>
      </div>
    </div>
  );
}
