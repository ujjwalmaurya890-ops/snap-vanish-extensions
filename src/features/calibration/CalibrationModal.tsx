import { useCallback, useEffect, useRef, useState } from "react";
import {
  Camera,
  CheckCircle2,
  Hand,
  Mic,
  Sliders,
  Sparkles,
  Volume2,
  X,
} from "lucide-react";
import { Badge, Button } from "../../components/ui/DesignSystem";
import {
  HandLandmarkService,
  drawHandLandmarksOverlay,
} from "../detection/handTracker";
import { LiveAudioConfirmationEngine } from "../audio/audioConfirmationEngine";
import {
  SnapGestureDetector,
  createSyntheticHandFrame,
} from "../../lib/gestureEngine";
import type { DetectionMode, SnapSettings } from "../../types/snapVanish";

interface CalibrationModalProps {
  open: boolean;
  settings: SnapSettings;
  onSaveCalibration: (patch: {
    mode: DetectionMode;
    sensitivity: number;
    calibratedCollapseThresholdMm: number;
    requireAudioConfirm: boolean;
    audioSensitivityDb: number;
  }) => void;
  onClose: () => void;
}

const CALIBRATION_STEPS = [
  "1. Start Camera",
  "2. Frame Hand",
  "3. 3 Test Snaps",
  "4. Measure Kinematics",
  "5. Audio Confirm",
  "6. Recommendation",
  "7. Save Profile",
] as const;

export default function CalibrationModal({
  open,
  settings,
  onSaveCalibration,
  onClose,
}: CalibrationModalProps) {
  const [step, setStep] = useState(0);
  const [cameraActive, setCameraActive] = useState(false);
  const [cameraStarting, setCameraStarting] = useState(false);
  const cameraStartingRef = useRef(false);
  const cameraGenerationRef = useRef(0);
  const openRef = useRef(open);
  openRef.current = open;
  const [syntheticMode, setSyntheticMode] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [handInFrame, setHandInFrame] = useState(false);
  const [recordedSnaps, setRecordedSnaps] = useState<
    Array<{ minDistanceMm: number; velocityMmPerSec: number }>
  >([]);
  const [liveDistanceMm, setLiveDistanceMm] = useState<number>(36);
  const [audioTested, setAudioTested] = useState(false);
  const [audioPeakDeltaDb, setAudioPeakDeltaDb] = useState<number | null>(null);
  const [recommendedMode, setRecommendedMode] =
    useState<DetectionMode>("balanced");
  const [recommendedSensitivity, setRecommendedSensitivity] = useState(
    settings.gesture.sensitivity,
  );
  const [recommendedCollapseMm, setRecommendedCollapseMm] = useState(
    settings.gesture.calibratedCollapseThresholdMm,
  );
  const [requireAudio, setRequireAudio] = useState(
    settings.gesture.requireAudioConfirm,
  );

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const handServiceRef = useRef(new HandLandmarkService());
  const audioEngineRef = useRef(new LiveAudioConfirmationEngine());
  const detectorRef = useRef(
    new SnapGestureDetector({
      ...settings.gesture,
      requireAudioConfirm: false,
      cooldownMs: 700,
    }),
  );

  const stopHardware = useCallback(() => {
    cameraGenerationRef.current += 1;
    cameraStartingRef.current = false;
    setCameraStarting(false);
    handServiceRef.current.dispose();
    const vid = videoRef.current;
    if (vid && vid.srcObject) {
      for (const tr of (vid.srcObject as MediaStream).getTracks()) {
        try {
          tr.stop();
        } catch {
          // Ignore
        }
      }
      vid.srcObject = null;
    }
    audioEngineRef.current.stop();
    setCameraActive(false);
  }, []);

  useEffect(() => {
    if (!open) {
      stopHardware();
      setStep(0);
      setRecordedSnaps([]);
      setCameraError(null);
      setSyntheticMode(false);
      setAudioTested(false);
      setAudioPeakDeltaDb(null);
    }
  }, [open, stopHardware]);

  useEffect(() => {
    const svc = handServiceRef.current;
    return () => {
      stopHardware();
      svc.dispose();
    };
  }, [stopHardware]);

  const computeRecommendation = useCallback(
    (samples: Array<{ minDistanceMm: number; velocityMmPerSec: number }>) => {
      if (samples.length === 0) return;
      const avgMinDist =
        samples.reduce((acc, s) => acc + s.minDistanceMm, 0) / samples.length;
      const avgVel =
        samples.reduce((acc, s) => acc + s.velocityMmPerSec, 0) /
        samples.length;

      const calibratedMm = Math.max(
        7,
        Math.min(18, Math.round(avgMinDist * 1.15)),
      );
      let mode: DetectionMode = "balanced";
      let sens = 62;
      if (avgVel > 230 && calibratedMm <= 11) {
        mode = "precision";
        sens = 80;
      } else if (avgVel < 155 || calibratedMm >= 14) {
        mode = "beginner";
        sens = 42;
      }
      setRecommendedCollapseMm(calibratedMm);
      setRecommendedMode(mode);
      setRecommendedSensitivity(sens);
    },
    [],
  );

  const startCalibrationCamera = async () => {
    if (cameraStartingRef.current) return;
    setCameraError(null);
    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraError("Browser mediaDevices API unavailable. You can use Synthetic Kinematic Benchmark Mode below.");
      return;
    }
    const generation = ++cameraGenerationRef.current;
    cameraStartingRef.current = true;
    setCameraStarting(true);
    const isCurrent = () => generation === cameraGenerationRef.current && openRef.current;
    let stream: MediaStream | null = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 360 } }, audio: false,
      });
      if (!isCurrent()) { stream.getTracks().forEach((track) => track.stop()); return; }
      let vid = videoRef.current;
      if (!vid) {
        vid = document.createElement("video");
        vid.playsInline = true;
        vid.muted = true;
        videoRef.current = vid;
      }
      vid.srcObject = stream;
      await vid.play();
      if (!isCurrent()) {
        stream.getTracks().forEach((track) => track.stop());
        if (vid.srcObject === stream) vid.srcObject = null;
        return;
      }
      const res = await handServiceRef.current.initialize({ minConfidence: 0.55 });
      if (!isCurrent() || res.cancelled) return;
      if (!res.ok) {
        stopHardware();
        setCameraError(res.error ?? "MediaPipe HandLandmarker failed to load");
        return;
      }
      setCameraActive(true);
      setSyntheticMode(false);
      setStep(1);
    } catch (err) {
      stream?.getTracks().forEach((track) => track.stop());
      if (!isCurrent()) return;
      stopHardware();
      setCameraError(err instanceof Error ? err.message : "Camera permission denied or no camera hardware detected.");
    } finally {
      if (isCurrent()) { cameraStartingRef.current = false; setCameraStarting(false); }
    }
  };

  useEffect(() => {
    if (!open || !cameraActive) return;
    let raf = 0;
    const loop = (now: number) => {
      const vid = videoRef.current;
      const canvas = canvasRef.current;
      if (vid && canvas && vid.readyState >= 2) {
        const ctx = canvas.getContext("2d");
        if (ctx) {
          ctx.save();
          ctx.translate(canvas.width, 0);
          ctx.scale(-1, 1);
          ctx.drawImage(vid, 0, 0, canvas.width, canvas.height);
          ctx.restore();

          ctx.strokeStyle = handInFrame
            ? "rgba(16, 185, 129, 0.75)"
            : "rgba(240, 98, 58, 0.65)";
          ctx.lineWidth = 2;
          ctx.setLineDash([8, 6]);
          ctx.strokeRect(
            canvas.width * 0.25,
            canvas.height * 0.14,
            canvas.width * 0.5,
            canvas.height * 0.72,
          );
          ctx.setLineDash([]);

          if (handServiceRef.current.currentStatus === "ready") {
            const inf = handServiceRef.current.detectVideoFrame(vid, now);
            if (inf.handDetected && inf.landmarks) {
              setHandInFrame(true);
              const evalRes = detectorRef.current.evaluateLandmarks(
                inf.landmarks,
                now,
                {
                  worldLandmarks: inf.worldLandmarks,
                  handConfidence: inf.confidence,
                  enforceLiveAudioGate: false,
                },
              );
              setLiveDistanceMm(
                Number(evalRes.thumbMiddleDistance.toFixed(1)),
              );
              drawHandLandmarksOverlay(
                ctx,
                inf.landmarks,
                canvas.width,
                canvas.height,
                {
                  mirrored: true,
                  accentColor: "#f0623a",
                  isCandidate: evalRes.candidate,
                },
              );
              if (step === 2 && evalRes.triggered) {
                setRecordedSnaps((prev) => {
                  if (prev.length >= 3) return prev;
                  const next = [
                    ...prev,
                    {
                      minDistanceMm: Number(
                        evalRes.thumbMiddleDistance.toFixed(1),
                      ),
                      velocityMmPerSec: Math.round(
                        evalRes.approachVelocityMmPerSec,
                      ),
                    },
                  ];
                  if (next.length >= 3) {
                    computeRecommendation(next);
                  }
                  return next;
                });
              }
            } else {
              setHandInFrame(false);
              detectorRef.current.notifyNoHand(now);
            }
          }
        }
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [open, cameraActive, step, handInFrame, computeRecommendation]);

  const runSyntheticSnapSample = () => {
    const det = new SnapGestureDetector({
      ...settings.gesture,
      requireAudioConfirm: false,
      cooldownMs: 100,
    });
    const baseNow = 1000 + recordedSnaps.length * 1000;
    det.evaluateLandmarks(
      createSyntheticHandFrame({ thumbMiddleDistMm: 46, wristOffsetRad: 0 }),
      baseNow,
    );
    det.evaluateLandmarks(
      createSyntheticHandFrame({ thumbMiddleDistMm: 34, wristOffsetRad: 0.08 }),
      baseNow + 40,
    );
    const hit = det.evaluateLandmarks(
      createSyntheticHandFrame({ thumbMiddleDistMm: 9.2, wristOffsetRad: 0.22 }),
      baseNow + 95,
    );
    const next = [
      ...recordedSnaps,
      {
        minDistanceMm: Number(hit.thumbMiddleDistance.toFixed(1)),
        velocityMmPerSec: Math.max(195, Math.round(hit.approachVelocityMmPerSec)),
      },
    ].slice(0, 3);
    setRecordedSnaps(next);
    if (next.length >= 3) {
      computeRecommendation(next);
    }
  };

  const runAudioVerification = () => {
    const res = audioEngineRef.current.runSyntheticTransientTest(
      settings.audio.sensitivityDb,
    );
    setAudioTested(res.confirmed);
    setAudioPeakDeltaDb(res.jumpDb);
  };

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="calibration-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-md"
    >
      <div className="w-full max-w-2xl overflow-hidden rounded-2xl border border-white/10 bg-[#12141b] text-[#f4f4f6] shadow-2xl">
        <div className="flex items-center justify-between border-b border-white/[0.08] bg-[#161922] px-6 py-4">
          <div className="flex items-center gap-2.5">
            <Sliders className="h-4 w-4 text-[#f0623a]" />
            <span id="calibration-title" className="text-[14px] font-semibold">
              Guided 7-Step Snap Gesture Calibration
            </span>
            {syntheticMode && (
              <Badge tone="amber">Synthetic Benchmark Mode</Badge>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close calibration modal"
            className="rounded-lg p-1.5 text-[#8b92a5] hover:bg-white/5 hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="grid grid-cols-7 gap-1 border-b border-white/[0.06] bg-[#0e1016] px-6 py-2.5">
          {CALIBRATION_STEPS.map((label, idx) => (
            <div
              key={label}
              className={`truncate rounded px-1.5 py-1 text-center font-mono text-[10px] ${
                idx === step
                  ? "bg-[#e0532c]/20 font-semibold text-[#ff9d80]"
                  : idx < step
                    ? "text-emerald-400"
                    : "text-[#585e70]"
              }`}
            >
              {label}
            </div>
          ))}
        </div>

        <div className="space-y-5 p-6">
          {cameraActive && step >= 1 && step <= 3 && (
            <div className="relative overflow-hidden rounded-xl border border-white/10 bg-black">
              <canvas
                ref={canvasRef}
                width={640}
                height={360}
                className="block w-full"
                style={{ aspectRatio: "16 / 9" }}
              />
              <div className="absolute bottom-2.5 left-2.5 flex items-center gap-2 rounded-lg bg-black/75 px-3 py-1 font-mono text-[11px]">
                <span
                  className={
                    handInFrame ? "text-emerald-300" : "text-amber-300"
                  }
                >
                  {handInFrame ? "21 LANDMARKS LOCKED" : "PLACE HAND IN GUIDE"}
                </span>
                <span className="text-white/40">·</span>
                <span className="text-[#ff9d80]">
                  Thumb–Middle: {liveDistanceMm} mm
                </span>
              </div>
            </div>
          )}

          {step === 0 && (
            <div className="space-y-4">
              <h3 className="text-[18px] font-semibold">
                Step 1 — Start Local Camera Preview
              </h3>
              <p className="text-[13px] leading-relaxed text-[#a1a6b5]">
                Calibration measures your actual hand geometry, thumb-to-middle
                tip collapse distance, and approach velocity locally inside
                WebAssembly. Calibration frames are processed locally, not uploaded by the extension.
              </p>
              {cameraError && (
                <div className="rounded-xl border border-amber-500/35 bg-amber-500/10 p-3.5 text-[12.5px] text-amber-200">
                  <div className="font-semibold">Camera Notice</div>
                  <div className="mt-1 text-amber-200/85">{cameraError}</div>
                </div>
              )}
              <div className="flex flex-wrap gap-3 pt-1">
                <Button variant="primary" onClick={startCalibrationCamera} disabled={cameraStarting}>
                  <Camera className="h-4 w-4" />
                  {cameraStarting ? "Starting camera…" : "Start Live Camera Preview"}
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => {
                    stopHardware();
                    setSyntheticMode(true);
                    setHandInFrame(true);
                    setStep(1);
                  }}
                >
                  Use Synthetic Kinematic Benchmark
                </Button>
              </div>
            </div>
          )}

          {step === 1 && (
            <div className="space-y-4">
              <h3 className="text-[18px] font-semibold">
                Step 2 — Position Hand Clearly Inside Framing Guide
              </h3>
              <p className="text-[13px] text-[#a1a6b5]">
                Hold your snapping hand comfortably 35–65 cm from the lens with
                your thumb and middle finger visible. Ensure even front lighting
                so all 21 landmarks lock cleanly.
              </p>
              <div className="flex items-center justify-between rounded-xl border border-white/10 bg-[#181b24] p-3.5">
                <div className="flex items-center gap-2.5 text-[13px]">
                  <Hand className="h-4 w-4 text-[#f0623a]" />
                  <span>
                    {syntheticMode
                      ? "Synthetic 21-point hand model ready"
                      : handInFrame
                        ? "Hand detected inside calibration region"
                        : "Waiting for hand inside dashed guide…"}
                  </span>
                </div>
                <Badge tone={handInFrame ? "emerald" : "amber"}>
                  {handInFrame ? "LOCKED" : "WAITING"}
                </Badge>
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="ghost" onClick={() => setStep(0)}>
                  Back
                </Button>
                <Button
                  variant="primary"
                  disabled={!handInFrame && !syntheticMode}
                  onClick={() => setStep(2)}
                >
                  Continue to 3 Test Snaps
                </Button>
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-[18px] font-semibold">
                  Step 3 — Perform 3 Natural Finger Snaps
                </h3>
                <Badge tone={recordedSnaps.length >= 3 ? "emerald" : "ember"}>
                  {recordedSnaps.length} / 3 SNAPS RECORDED
                </Badge>
              </div>
              <p className="text-[13px] text-[#a1a6b5]">
                Press thumb and middle finger together, then snap briskly. Pause
                briefly (~1 second) between each snap.
              </p>
              <div className="grid grid-cols-3 gap-3">
                {[0, 1, 2].map((idx) => {
                  const sample = recordedSnaps[idx];
                  return (
                    <div
                      key={idx}
                      className={`rounded-xl border p-3.5 ${
                        sample
                          ? "border-emerald-500/35 bg-emerald-500/10"
                          : "border-white/10 bg-[#181b24]"
                      }`}
                    >
                      <div className="font-mono text-[10.5px] uppercase text-[#8b92a5]">
                        Snap #{idx + 1}
                      </div>
                      {sample ? (
                        <div className="mt-1 space-y-0.5 font-mono text-[12px] text-emerald-200">
                          <div>Min Dist: {sample.minDistanceMm} mm</div>
                          <div>Vel: {sample.velocityMmPerSec} mm/s</div>
                        </div>
                      ) : (
                        <div className="mt-2 text-[12px] text-[#6c7284]">
                          Awaiting snap…
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
              {syntheticMode && recordedSnaps.length < 3 && (
                <Button variant="secondary" onClick={runSyntheticSnapSample}>
                  <Sparkles className="h-4 w-4 text-[#f0623a]" />
                  Record Synthetic Snap Sample #{recordedSnaps.length + 1}
                </Button>
              )}
              <div className="flex justify-end gap-2">
                <Button variant="ghost" onClick={() => setStep(1)}>
                  Back
                </Button>
                <Button
                  variant="primary"
                  disabled={recordedSnaps.length < 3}
                  onClick={() => setStep(3)}
                >
                  Inspect Kinematic Measurements
                </Button>
              </div>
            </div>
          )}

          {step === 3 && (
            <div className="space-y-4">
              <h3 className="text-[18px] font-semibold">
                Step 4 — Kinematic Collapse &amp; Velocity Analysis
              </h3>
              <p className="text-[13px] text-[#a1a6b5]">
                Your 3 test snaps have been analyzed across normalized palm
                millimeters and approach speed:
              </p>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                <div className="rounded-xl border border-white/10 bg-[#181b24] p-3.5">
                  <div className="rail text-[#8b92a5]">Avg Collapse Dist</div>
                  <div className="mt-1 font-mono text-[20px] font-semibold text-[#ff9d80]">
                    {(
                      recordedSnaps.reduce((a, b) => a + b.minDistanceMm, 0) /
                      Math.max(1, recordedSnaps.length)
                    ).toFixed(1)}{" "}
                    mm
                  </div>
                </div>
                <div className="rounded-xl border border-white/10 bg-[#181b24] p-3.5">
                  <div className="rail text-[#8b92a5]">Avg Approach Speed</div>
                  <div className="mt-1 font-mono text-[20px] font-semibold text-emerald-300">
                    {Math.round(
                      recordedSnaps.reduce(
                        (a, b) => a + b.velocityMmPerSec,
                        0,
                      ) / Math.max(1, recordedSnaps.length),
                    )}{" "}
                    mm/s
                  </div>
                </div>
                <div className="rounded-xl border border-white/10 bg-[#181b24] p-3.5">
                  <div className="rail text-[#8b92a5]">Calibrated Gate</div>
                  <div className="mt-1 font-mono text-[20px] font-semibold text-white">
                    {recommendedCollapseMm} mm
                  </div>
                </div>
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="ghost" onClick={() => setStep(2)}>
                  Back
                </Button>
                <Button variant="primary" onClick={() => setStep(4)}>
                  Next: Optional Audio Confirmation
                </Button>
              </div>
            </div>
          )}

          {step === 4 && (
            <div className="space-y-4">
              <h3 className="text-[18px] font-semibold">
                Step 5 — Acoustic Transient Confirmation (Optional)
              </h3>
              <p className="text-[13px] text-[#a1a6b5]">
                Acoustic confirmation checks for a crisp 1.8–4.2 kHz snap peak
                within {settings.audio.confirmWindowMs} ms of hand motion to
                help reduce accidental triggers. Accuracy varies with sound and
                lighting. Audio is analyzed locally, not recorded by the extension.
              </p>
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-white/10 bg-[#181b24] p-4">
                <div className="flex items-center gap-3">
                  <Mic className="h-5 w-5 text-[#f0623a]" />
                  <div>
                    <div className="text-[13px] font-medium">
                      Require Acoustic Confirmation Gate
                    </div>
                    <div className="text-[11.5px] text-[#8b92a5]">
                      {audioTested
                        ? `Verified transient detector (+${audioPeakDeltaDb} dB above adaptive floor)`
                        : "Recommended for meetings where you gesture frequently"}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={runAudioVerification}
                  >
                    <Volume2 className="h-3.5 w-3.5" />
                    Test Transient Gate
                  </Button>
                  <Button
                    size="sm"
                    variant={requireAudio ? "primary" : "ghost"}
                    onClick={() => setRequireAudio((v) => !v)}
                  >
                    {requireAudio ? "Enabled" : "Disabled"}
                  </Button>
                </div>
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="ghost" onClick={() => setStep(3)}>
                  Back
                </Button>
                <Button variant="primary" onClick={() => setStep(5)}>
                  View Recommended Profile
                </Button>
              </div>
            </div>
          )}

          {step === 5 && (
            <div className="space-y-4">
              <h3 className="text-[18px] font-semibold">
                Step 6 — Recommended Detection Profile
              </h3>
              <p className="text-[13px] text-[#a1a6b5]">
                Based on your snap kinematics, Snap Vanish recommends the
                following settings (you can fine-tune before saving):
              </p>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                {(["beginner", "balanced", "precision"] as DetectionMode[]).map(
                  (m) => (
                    <button
                      key={m}
                      type="button"
                      onClick={() => setRecommendedMode(m)}
                      className={`rounded-xl border p-3.5 text-left transition-colors ${
                        recommendedMode === m
                          ? "border-[#f0623a] bg-[#e0532c]/15"
                          : "border-white/10 bg-[#181b24] hover:border-white/20"
                      }`}
                    >
                      <div className="font-mono text-[11px] uppercase text-[#ff9d80]">
                        {m}
                      </div>
                      <div className="mt-1 text-[12px] text-[#c9cdd8]">
                        {m === "beginner"
                          ? "Forgiving distance & velocity"
                          : m === "balanced"
                            ? "Ideal everyday call reliability"
                            : "Strict anti-false-positive gate"}
                      </div>
                    </button>
                  ),
                )}
              </div>
              <div className="rounded-xl border border-white/10 bg-[#181b24] p-4">
                <div className="flex justify-between text-[12.5px]">
                  <span>Recommended Strictness / Sensitivity</span>
                  <span className="font-mono text-[#ff9d80]">
                    {recommendedSensitivity} / 100
                  </span>
                </div>
                <input
                  type="range"
                  min={15}
                  max={95}
                  value={recommendedSensitivity}
                  onChange={(e) =>
                    setRecommendedSensitivity(Number(e.target.value))
                  }
                  className="mt-2"
                />
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="ghost" onClick={() => setStep(4)}>
                  Back
                </Button>
                <Button variant="primary" onClick={() => setStep(6)}>
                  Proceed to Save
                </Button>
              </div>
            </div>
          )}

          {step === 6 && (
            <div className="space-y-4">
              <div className="flex items-center gap-2.5 text-emerald-300">
                <CheckCircle2 className="h-5 w-5" />
                <h3 className="text-[18px] font-semibold text-white">
                  Step 7 — Save Calibrated Profile
                </h3>
              </div>
              <div className="grid grid-cols-2 gap-3 rounded-xl border border-white/10 bg-[#181b24] p-4 font-mono text-[12px]">
                <div>
                  <span className="text-[#8b92a5]">Detection Mode:</span>{" "}
                  <span className="uppercase text-[#ff9d80]">
                    {recommendedMode}
                  </span>
                </div>
                <div>
                  <span className="text-[#8b92a5]">Sensitivity:</span>{" "}
                  <span>{recommendedSensitivity}/100</span>
                </div>
                <div>
                  <span className="text-[#8b92a5]">Collapse Gate:</span>{" "}
                  <span>{recommendedCollapseMm} mm</span>
                </div>
                <div>
                  <span className="text-[#8b92a5]">Audio Gate:</span>{" "}
                  <span>{requireAudio ? "Required" : "Optional"}</span>
                </div>
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="ghost" onClick={() => setStep(5)}>
                  Back
                </Button>
                <Button
                  variant="primary"
                  onClick={() => {
                    stopHardware();
                    onSaveCalibration({
                      mode: recommendedMode,
                      sensitivity: recommendedSensitivity,
                      calibratedCollapseThresholdMm: recommendedCollapseMm,
                      requireAudioConfirm: requireAudio,
                      audioSensitivityDb: settings.audio.sensitivityDb,
                    });
                    onClose();
                  }}
                >
                  Save Calibrated Profile
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
