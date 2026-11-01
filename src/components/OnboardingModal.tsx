import { useState } from "react";
import {
  Camera,
  CheckCircle2,
  Globe,
  Hand,
  Mic,
  RotateCcw,
  ShieldCheck,
  Sliders,
  Sparkles,
  X,
} from "lucide-react";
import { Badge, Button, Kbd } from "./ui/DesignSystem";

type Props = {
  open: boolean;
  onComplete: () => void;
  onRequestLiveCamera?: () => void;
  onOpenCalibration?: () => void;
  onTriggerDemoVanish?: () => void;
  onTriggerEmergencyRestore?: () => void;
};

interface OnboardingStepDef {
  badge: string;
  title: string;
  body: string;
  detail: string;
  icon: typeof ShieldCheck;
  actionLabel?: string;
  actionId?: "camera" | "calibration" | "preview" | "restore";
}

const STEPS: OnboardingStepDef[] = [
  {
    badge: "STEP 1 OF 8 · WELCOME & PRIVACY",
    title: "Disintegrate out of any call — 100% locally.",
    body: "Snap Vanish 2.0 runs MediaPipe 21-point hand landmark inference, acoustic transient confirmation, and particle physics strictly inside your browser's local memory.",
    detail:
      "Verified guarantee: Zero video frames, zero audio recordings, and zero telemetry leave your computer. All WASM and TFLite models load directly from bundled extension files.",
    icon: ShieldCheck,
  },
  {
    badge: "STEP 2 OF 8 · CAMERA PERMISSION",
    title: "Grant local camera access when ready.",
    body: "To track your hand landmarks and capture your real room background plate, Chrome will prompt for camera permission on first live activation.",
    detail:
      "You can also explore the Effect Studio using the built-in calibration scene before enabling your physical webcam.",
    icon: Camera,
    actionLabel: "Enable Live Webcam Now (Optional)",
    actionId: "camera",
  },
  {
    badge: "STEP 3 OF 8 · MICROPHONE CONFIRMATION (OPTIONAL)",
    title: "Prevent accidental triggers with acoustic confirmation.",
    body: "When enabled, Snap Vanish checks for a short 1.8–4.2 kHz snap transient within 220 ms of finger collapse so talking with your hands never falsely triggers vanish.",
    detail:
      "Microphone confirmation is optional and can be toggled independently at any time in Settings → Audio. Audio is analyzed in volatile RAM and never recorded.",
    icon: Mic,
  },
  {
    badge: "STEP 4 OF 8 · 21-POINT HAND DETECTION TEST",
    title: "Frame your snapping hand in front of the lens.",
    body: "Hold your thumb and middle finger 35–65 cm from your webcam. Enable the 21-Pt Landmarks overlay on the viewport to inspect real-time joint tracking and confidence.",
    detail:
      "If your room lighting dims or your hand leaves the frame, the state machine resets safely without firing.",
    icon: Hand,
  },
  {
    badge: "STEP 5 OF 8 · GUIDED SNAP CALIBRATION",
    title: "Calibrate to your personal snap speed.",
    body: "Everyone snaps differently. Our 7-step calibration records 3 natural snaps, measures your collapse distance in palm-normalized millimeters, and recommends Beginner, Balanced, or Precision mode.",
    detail:
      "You can run or re-run calibration anytime from the Dashboard header or Settings → Detection.",
    icon: Sliders,
    actionLabel: "Open 7-Step Calibration After Setup",
    actionId: "calibration",
  },
  {
    badge: "STEP 6 OF 8 · DUST ANIMATION PREVIEW",
    title: "Choose from 6 signature disintegration styles.",
    body: "Switch between Classic Dust, Cinematic Disintegration, Fine Particles, Energy Burst, Gentle Fade, and Reverse Assembly — or craft custom physics in the Personalization Studio.",
    detail:
      "Particles are pooled in typed arrays and automatically pause when your tab is hidden to protect laptop battery life.",
    icon: Sparkles,
    actionLabel: "Trigger Live Disintegration Preview",
    actionId: "preview",
  },
  {
    badge: "STEP 7 OF 8 · EMERGENCY RESTORE GUARANTEE",
    title: "Instant camera recovery is always one key away.",
    body: "Press Alt+Shift+R or click Emergency Restore in the Dashboard, Popup, or Meeting HUD to unconditionally cancel animations, restore your live camera track, and unmute your mic.",
    detail:
      "Even if WebGL/WASM encounters an error, centralized ErrorService fails open to restore your real camera feed.",
    icon: RotateCcw,
    actionLabel: "Test Emergency Restore Now",
    actionId: "restore",
  },
  {
    badge: "STEP 8 OF 8 · SUPPORTED PLATFORMS & LIMITATIONS",
    title: "Transparent compatibility across conferencing apps.",
    body: "Google Meet and Microsoft Teams Web use standard WebRTC RTCPeerConnection senders, allowing Snap Vanish's MAIN-world bridge to swap your outgoing video track cleanly via RTCRtpSender.replaceTrack().",
    detail:
      "Zoom Web Client often uses custom WebAssembly media encoding where WebRTC replaceTrack is unavailable; on Zoom Web, local tile overlay works and OBS Virtual Camera is recommended for outgoing feed replacement.",
    icon: Globe,
  },
];

export default function OnboardingModal({
  open,
  onComplete,
  onRequestLiveCamera,
  onOpenCalibration,
  onTriggerDemoVanish,
  onTriggerEmergencyRestore,
}: Props) {
  const [step, setStep] = useState(0);
  const [actionFeedback, setActionFeedback] = useState<string | null>(null);

  if (!open) return null;

  const current = STEPS[step];
  const Icon = current.icon;
  const isLast = step === STEPS.length - 1;

  const runOptionalStepAction = () => {
    if (current.actionId === "camera") {
      onRequestLiveCamera?.();
      setActionFeedback("Requested live camera stream in main stage.");
    } else if (current.actionId === "calibration") {
      onComplete();
      onOpenCalibration?.();
    } else if (current.actionId === "preview") {
      onTriggerDemoVanish?.();
      setActionFeedback("Triggered live disintegration transition behind modal.");
    } else if (current.actionId === "restore") {
      onTriggerEmergencyRestore?.();
      setActionFeedback("Verified unconditional Emergency Restore.");
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="onboarding-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-md"
    >
      <div className="w-full max-w-xl overflow-hidden rounded-2xl border border-white/10 bg-[#12141b] text-[#f4f4f6] shadow-2xl">
        {/* Progress bar */}
        <div className="h-1 w-full bg-white/[0.06]">
          <div
            className="h-full bg-gradient-to-r from-[#e0532c] to-[#ff8a65] transition-all duration-300"
            style={{ width: `${((step + 1) / STEPS.length) * 100}%` }}
          />
        </div>

        <div className="flex items-center justify-between border-b border-white/[0.07] px-6 py-3.5">
          <span className="rail text-[#ff9d80]">{current.badge}</span>
          <button
            type="button"
            onClick={onComplete}
            aria-label="Skip setup guide"
            className="inline-flex items-center gap-1 rounded-lg px-2 py-1 font-mono text-[11px] text-[#8b92a5] hover:bg-white/5 hover:text-white"
          >
            Skip
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        <div className="space-y-4 p-6">
          <div className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-[#f0623a]/35 bg-[#e0532c]/15 text-[#ff9d80]">
            <Icon className="h-5 w-5" />
          </div>

          <h2
            id="onboarding-title"
            className="text-[22px] font-semibold leading-snug text-white"
          >
            {current.title}
          </h2>

          <p className="text-[13.5px] leading-relaxed text-[#b4b9c8]">
            {current.body}
          </p>

          <div className="rounded-xl border border-white/[0.07] bg-[#181b23] p-3.5 text-[12px] leading-relaxed text-[#8b92a5]">
            {current.detail}
          </div>

          {step === 6 && (
            <div className="flex items-center gap-2 text-[12px] text-[#c9cdd8]">
              <span>Emergency Shortcut:</span>
              <Kbd>Alt</Kbd>
              <span>+</span>
              <Kbd>Shift</Kbd>
              <span>+</span>
              <Kbd>R</Kbd>
            </div>
          )}

          {current.actionLabel && (
            <div className="pt-1">
              <Button variant="secondary" size="sm" onClick={runOptionalStepAction}>
                {current.actionLabel}
              </Button>
            </div>
          )}

          {actionFeedback && (
            <div>
              <Badge tone="emerald">
                <CheckCircle2 className="h-3 w-3" />
                {actionFeedback}
              </Badge>
            </div>
          )}
        </div>

        {/* Footer Controls */}
        <div className="flex items-center justify-between border-t border-white/[0.07] bg-[#161922] px-6 py-4">
          <div className="flex gap-1.5">
            {STEPS.map((s, idx) => (
              <button
                key={s.badge}
                type="button"
                aria-label={`Jump to step ${idx + 1}`}
                onClick={() => {
                  setActionFeedback(null);
                  setStep(idx);
                }}
                className={`h-1.5 rounded-full transition-all ${
                  idx === step
                    ? "w-6 bg-[#f0623a]"
                    : idx < step
                      ? "w-2 bg-emerald-400/70"
                      : "w-2 bg-white/15"
                }`}
              />
            ))}
          </div>

          <div className="flex items-center gap-2">
            {step > 0 && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setActionFeedback(null);
                  setStep((s) => s - 1);
                }}
              >
                Back
              </Button>
            )}
            <Button
              variant="primary"
              size="sm"
              onClick={() => {
                setActionFeedback(null);
                if (isLast) {
                  onComplete();
                } else {
                  setStep((s) => s + 1);
                }
              }}
            >
              {isLast ? "Finish Setup" : "Next Step"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
