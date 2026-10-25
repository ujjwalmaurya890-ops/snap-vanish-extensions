import { useEffect, useState } from "react";
import SnapMark from "./SnapMark";
import type { EffectType, SnapSettings } from "../types/snapVanish";
import {
  checkMediaDevicesSupport,
  checkWebGL2Support,
  queryMediaPermissions,
} from "../lib/diagnostics";

interface OnboardingModalProps {
  open: boolean;
  settings: SnapSettings;
  onUpdateSettings: (patch: Partial<SnapSettings>) => void;
  onTriggerTestEffect: () => void;
  onEmergencyRestore: () => void;
  onComplete: () => void;
}

const STEPS = [
  { id: 1, title: "Welcome to Snap Vanish" },
  { id: 2, title: "Permissions & Local Privacy" },
  { id: 3, title: "System Capability Check" },
  { id: 4, title: "Controls & Shortcuts" },
  { id: 5, title: "Test Your Effect" },
  { id: 6, title: "Emergency Restoration" },
] as const;

export default function OnboardingModal({
  open,
  settings,
  onUpdateSettings,
  onTriggerTestEffect,
  onEmergencyRestore,
  onComplete,
}: OnboardingModalProps) {
  const [step, setStep] = useState(0);
  const [capabilities, setCapabilities] = useState<{
    webgl2: boolean;
    mediaDevices: boolean;
    camera: string;
    microphone: string;
    checked: boolean;
  }>({
    webgl2: false,
    mediaDevices: false,
    camera: "unknown",
    microphone: "unknown",
    checked: false,
  });
  const [testFired, setTestFired] = useState(false);

  useEffect(() => {
    if (!open) return;
    let mounted = true;
    queryMediaPermissions().then((perms) => {
      if (!mounted) return;
      setCapabilities({
        webgl2: checkWebGL2Support(),
        mediaDevices: checkMediaDevicesSupport(),
        camera: perms.camera,
        microphone: perms.microphone,
        checked: true,
      });
    });
    return () => {
      mounted = false;
    };
  }, [open, step]);

  if (!open) return null;

  const currentStep = STEPS[step];

  const handleFinish = () => {
    onUpdateSettings({ onboardingCompleted: true });
    onComplete();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="onboarding-title"
    >
      <div className="w-full max-w-[600px] overflow-hidden rounded-2xl border border-white/15 bg-[#0d0e14] text-[#f3f4f8] shadow-2xl">
        {/* Top bar */}
        <div className="flex items-center justify-between border-b border-white/10 bg-[#151722] px-6 py-4">
          <div className="flex items-center gap-3">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-violet-600 to-[#d2451e] text-white">
              <SnapMark className="h-4 w-4" />
            </span>
            <div>
              <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-violet-400">
                FIRST-RUN SETUP · STEP {step + 1} OF {STEPS.length}
              </div>
              <h2
                id="onboarding-title"
                className="text-[16px] font-semibold text-white"
              >
                {currentStep.title}
              </h2>
            </div>
          </div>
          <button
            type="button"
            onClick={handleFinish}
            className="rounded-lg border border-white/10 px-3 py-1.5 text-[11.5px] text-[#9ca3b8] transition-colors hover:border-white/25 hover:text-white"
          >
            Skip Setup
          </button>
        </div>

        {/* Step progress bar */}
        <div className="grid grid-cols-6 gap-1 bg-[#151722] px-6 pb-3">
          {STEPS.map((s, idx) => (
            <button
              key={s.id}
              type="button"
              onClick={() => setStep(idx)}
              aria-label={`Go to step ${idx + 1}: ${s.title}`}
              className={`h-1.5 rounded-full transition-colors ${
                idx <= step ? "bg-violet-500" : "bg-white/10"
              }`}
            />
          ))}
        </div>

        {/* Body */}
        <div className="min-h-[290px] px-6 py-6 text-[13.5px] leading-[1.6] text-[#c4c9db]">
          {step === 0 && (
            <div className="space-y-4">
              <p className="text-[15px] text-white">
                Snap Vanish lets you exit and re-enter your camera frame with
                reversible particle, dissolve, glitch, fade, and light-burst
                animations.
              </p>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                {[
                  [
                    "100% Local Engine",
                    "All particle physics, background plates, and audio transient checks execute inside your browser tab.",
                  ],
                  [
                    "Reversible Physics",
                    "Every effect is evaluated analytically so triggering again reassembles your frame smoothly.",
                  ],
                  [
                    "Multi-Trigger Control",
                    "Trigger via manual popup button, keyboard shortcuts, or calibrated finger-snap detection.",
                  ],
                ].map(([title, desc]) => (
                  <div
                    key={title}
                    className="rounded-xl border border-white/10 bg-[#151722] p-3.5"
                  >
                    <div className="font-semibold text-violet-300">{title}</div>
                    <p className="mt-1 text-[12px] text-[#9ca3b8]">{desc}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {step === 1 && (
            <div className="space-y-4">
              <p>
                Snap Vanish follows strict least-privilege permissions. We do
                not request background browsing history, tabs permissions, or
                offscreen documents.
              </p>
              <div className="space-y-2.5">
                {[
                  [
                    "activeTab",
                    "Required only to send Vanish/Restore commands from the popup or keyboard shortcuts to your active meeting tab.",
                  ],
                  [
                    "storage",
                    "Saves your custom effect presets, sensitivity calibration, and meeting mode preferences locally.",
                  ],
                  [
                    "Host Permissions (Meet, Teams, Zoom)",
                    "Attaches the visual effect canvas overlay and mute synchronization inside supported web call tabs.",
                  ],
                ].map(([perm, why]) => (
                  <div
                    key={perm}
                    className="rounded-xl border border-white/10 bg-[#151722] p-3"
                  >
                    <div className="font-mono text-[12px] font-semibold text-emerald-300">
                      {perm}
                    </div>
                    <div className="mt-0.5 text-[12.5px] text-[#9ca3b8]">
                      {why}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="space-y-4">
              <p>
                We inspected your current browser environment to verify which
                capabilities are available right now:
              </p>
              <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                <div className="flex items-center justify-between rounded-xl border border-white/10 bg-[#151722] p-3.5">
                  <span>HTML5 2D / WebGL2 Canvas</span>
                  <span
                    className={`rounded px-2 py-0.5 font-mono text-[11px] ${
                      capabilities.webgl2
                        ? "bg-emerald-500/20 text-emerald-300"
                        : "bg-amber-500/20 text-amber-300"
                    }`}
                  >
                    {capabilities.webgl2 ? "SUPPORTED" : "2D FALLBACK"}
                  </span>
                </div>
                <div className="flex items-center justify-between rounded-xl border border-white/10 bg-[#151722] p-3.5">
                  <span>MediaDevices API</span>
                  <span
                    className={`rounded px-2 py-0.5 font-mono text-[11px] ${
                      capabilities.mediaDevices
                        ? "bg-emerald-500/20 text-emerald-300"
                        : "bg-amber-500/20 text-amber-300"
                    }`}
                  >
                    {capabilities.mediaDevices ? "AVAILABLE" : "UNAVAILABLE"}
                  </span>
                </div>
                <div className="flex items-center justify-between rounded-xl border border-white/10 bg-[#151722] p-3.5">
                  <span>Camera Permission Status</span>
                  <span className="rounded bg-white/10 px-2 py-0.5 font-mono text-[11px] uppercase text-white">
                    {capabilities.camera}
                  </span>
                </div>
                <div className="flex items-center justify-between rounded-xl border border-white/10 bg-[#151722] p-3.5">
                  <span>Microphone Permission Status</span>
                  <span className="rounded bg-white/10 px-2 py-0.5 font-mono text-[11px] uppercase text-white">
                    {capabilities.microphone}
                  </span>
                </div>
              </div>
              <p className="text-[12px] text-[#9ca3b8]">
                Note: Even without granting camera/microphone permissions on this
                dashboard page, the interactive studio preview and all 5 visual
                effects work immediately using the local calibration plate.
              </p>
            </div>
          )}

          {step === 3 && (
            <div className="space-y-4">
              <p>
                You can trigger or restore your camera at any time using manual
                buttons, keyboard shortcuts, or calibrated finger-snap gestures:
              </p>
              <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                {[
                  ["Alt + Shift + S", "Toggle Vanish / Restore"],
                  ["Alt + Shift + D", "Instant Vanish (bypass gesture)"],
                  ["Alt + Shift + M", "Toggle Microphone Mute only"],
                  ["Alt + Shift + R", "Emergency Restore to Live Feed"],
                ].map(([kbd, desc]) => (
                  <div
                    key={kbd}
                    className="flex items-center justify-between rounded-xl border border-white/10 bg-[#151722] p-3"
                  >
                    <span className="text-[12.5px] text-white">{desc}</span>
                    <kbd className="rounded border border-white/15 bg-[#1c1f2e] px-2 py-1 font-mono text-[11px] text-violet-300">
                      {kbd}
                    </kbd>
                  </div>
                ))}
              </div>
            </div>
          )}

          {step === 4 && (
            <div className="space-y-4">
              <p>
                Choose your preferred default visual effect and fire a live test
                animation on the stage:
              </p>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {(
                  [
                    ["dust", "Dust Particles"],
                    ["pixel-dissolve", "Pixel Dissolve"],
                    ["digital-glitch", "Digital Glitch"],
                    ["fade-out", "Studio Fade-Out"],
                    ["light-burst", "Solar Light-Burst"],
                  ] as [EffectType, string][]
                ).map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => onUpdateSettings({ effect: id })}
                    className={`rounded-xl border px-3 py-2.5 text-left text-[12.5px] font-medium transition-colors ${
                      settings.effect === id
                        ? "border-violet-500 bg-violet-600/25 text-white"
                        : "border-white/10 bg-[#151722] text-[#9ca3b8] hover:text-white"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>

              <div className="flex flex-wrap items-center gap-3 rounded-xl border border-violet-500/30 bg-violet-500/10 p-4">
                <button
                  type="button"
                  onClick={() => {
                    setTestFired(true);
                    onTriggerTestEffect();
                  }}
                  className="rounded-lg bg-violet-600 px-4 py-2 text-[12.5px] font-semibold text-white hover:bg-violet-500"
                >
                  Trigger Test Effect Now
                </button>
                <span className="text-[12px] text-violet-200">
                  {testFired
                    ? "Test signal sent to the live stage! Click again to reverse."
                    : "Click to test disintegration & reassembly on the stage behind this dialog."}
                </span>
              </div>
            </div>
          )}

          {step === 5 && (
            <div className="space-y-4">
              <div className="rounded-xl border border-red-500/35 bg-red-500/10 p-4">
                <div className="font-semibold text-red-200">
                  Emergency Restoration Guarantee
                </div>
                <p className="mt-1 text-[12.5px] text-red-100/85">
                  If an effect ever triggers at the wrong moment during a
                  meeting, pressing{" "}
                  <kbd className="rounded bg-black/40 px-1.5 py-0.5 font-mono text-[11px]">
                    Alt + Shift + R
                  </kbd>{" "}
                  or clicking any <strong>Emergency Restore</strong> button
                  immediately cancels all active animations, removes overlays,
                  unmutes audio, and returns your camera state to{" "}
                  <strong>LIVE</strong>.
                </p>
                <button
                  type="button"
                  onClick={onEmergencyRestore}
                  className="mt-3 rounded-lg border border-red-400/50 bg-red-500/25 px-4 py-2 text-[12px] font-semibold text-red-100 hover:bg-red-500/35"
                >
                  Test Emergency Restore Now
                </button>
              </div>
              <p className="text-[12.5px] text-[#9ca3b8]">
                You are ready to use Snap Vanish. You can reopen this guide at
                any time from the Popup or Web Dashboard.
              </p>
            </div>
          )}
        </div>

        {/* Footer navigation */}
        <div className="flex items-center justify-between border-t border-white/10 bg-[#151722] px-6 py-4">
          <button
            type="button"
            disabled={step === 0}
            onClick={() => setStep((s) => Math.max(0, s - 1))}
            className="rounded-lg border border-white/10 px-4 py-2 text-[12.5px] font-medium text-[#9ca3b8] hover:border-white/25 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
          >
            ← Previous
          </button>

          <div className="flex items-center gap-2.5">
            {step < STEPS.length - 1 ? (
              <button
                type="button"
                onClick={() => setStep((s) => Math.min(STEPS.length - 1, s + 1))}
                className="rounded-lg bg-violet-600 px-5 py-2 text-[12.5px] font-semibold text-white hover:bg-violet-500"
              >
                Next Step →
              </button>
            ) : (
              <button
                type="button"
                onClick={handleFinish}
                className="rounded-lg bg-emerald-600 px-5 py-2 text-[12.5px] font-semibold text-white hover:bg-emerald-500"
              >
                Finish Setup ✓
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
