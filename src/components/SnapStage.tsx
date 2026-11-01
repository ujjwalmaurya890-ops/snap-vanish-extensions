import { memo, useCallback, useEffect, useRef, useState } from "react";
import type { MutableRefObject } from "react";
import {
  Camera,
  CameraOff,
  Eye,
  Hand,
  ImagePlus,
  RotateCcw,
  Sparkles,
} from "lucide-react";
import {
  DustScene,
  createRenderOptions,
  playSnap,
  type Direction,
  type EffectRenderOptions,
  type EffectType,
} from "../lib/dust";
import { FramePerformanceTracker } from "../lib/diagnostics";
import {
  SnapGestureDetector,
  type HandLandmark,
} from "../lib/gestureEngine";
import {
  HandLandmarkService,
  drawHandLandmarksOverlay,
} from "../features/detection/handTracker";
import { BackgroundReconstructor } from "../features/camera/backgroundReconstructor";
import { LiveAudioConfirmationEngine } from "../features/audio/audioConfirmationEngine";
import { classifyMediaError } from "../services/errorService";
import type {
  AppErrorCode,
  DetectionDiagnosticsState,
  SnapSettings,
} from "../types/snapVanish";
import roomSrc from "../assets/room-empty.jpg";
import personSrc from "../assets/feed-person.jpg";

export type SnapStatus = "idle" | "vanishing" | "gone" | "returning";

type Props = {
  enabled: boolean;
  duration: number;
  direction: Direction;
  sensitivity: number;
  snapSignal: number;
  restoreSignal?: number;
  emergencySignal?: number;
  capturePlateSignal?: number;
  sound: boolean;
  effect?: EffectType;
  speed?: number;
  particleSize?: number;
  density?: number;
  colorAccent?: string;
  intensity?: number;
  motionSmoothness?: number;
  lowPowerMode?: boolean;
  pauseWhenHidden?: boolean;
  maxParticles?: number;
  fullSettings?: SnapSettings;
  liveCameraRequested?: boolean;
  onLiveCameraChange?: (active: boolean, resolution: string | null) => void;
  onAudioMonitorChange?: (active: boolean, levelPercent: number, currentDb: number, floorDb: number) => void;
  onDetectionDiagnostics?: (diag: DetectionDiagnosticsState) => void;
  onRaiseError?: (code: AppErrorCode, detail?: string) => void;
  onGestureTriggered?: (action: string) => void;
  onStatus: (s: SnapStatus) => void;
  onEmergencyRestore?: () => void;
  onMetrics?: (metrics: {
    fps: number | null;
    renderMs: number | null;
    particles: number;
  }) => void;
};

const STATUS_COPY: Record<SnapStatus, { label: string; tone: string }> = {
  idle: { label: "LIVE · FEED ACTIVE", tone: "text-emerald-300" },
  vanishing: {
    label: "VANISHING · DISINTEGRATING",
    tone: "text-[#ff9d80]",
  },
  gone: { label: "VANISHED · CLEAN PLATE ACTIVE", tone: "text-amber-300" },
  returning: {
    label: "RESTORING · REASSEMBLING",
    tone: "text-[#ff9d80]",
  },
};

const EFFECT_LABELS: Record<EffectType, string> = {
  dust: "CLASSIC DUST",
  "cinematic-disintegration": "CINEMATIC DISINTEGRATION",
  "fine-particles": "FINE PARTICLES",
  "pixel-dissolve": "VOXEL DISSOLVE",
  "digital-glitch": "DIGITAL GLITCH",
  "fade-out": "GENTLE FADE",
  "light-burst": "ENERGY BURST",
};

/** Telemetry publish cadence for FPS / render-ms / particle count. */
const METRICS_INTERVAL_MS = 500;

const RESOLUTION_MAP = {
  "640x360": { width: 640, height: 360 },
  "1280x720": { width: 1280, height: 720 },
  "1920x1080": { width: 1920, height: 1080 },
} as const;

function SnapStageImpl({
  enabled,
  duration,
  direction,
  sensitivity,
  snapSignal,
  restoreSignal = 0,
  emergencySignal = 0,
  capturePlateSignal = 0,
  sound,
  effect = "dust",
  speed = 1.0,
  particleSize = 1.0,
  density = 80,
  colorAccent = "#e0532c",
  intensity = 85,
  motionSmoothness = 70,
  lowPowerMode = false,
  pauseWhenHidden = true,
  maxParticles = 22000,
  fullSettings,
  liveCameraRequested = false,
  onLiveCameraChange,
  onAudioMonitorChange,
  onDetectionDiagnostics,
  onRaiseError,
  onGestureTriggered,
  onStatus,
  onEmergencyRestore,
  onMetrics,
}: Props) {
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const analysisCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const sceneRef = useRef<DustScene | null>(null);
  /**
   * `useRef(new X())` evaluates `new X()` on *every* render and throws the
   * instance away — five heavyweight objects (MediaPipe service, audio engine,
   * background reconstructor, perf tracker) were being constructed per render
   * while the webcam was live (~60×/s). Lazy initialisation fixes that.
   */
  const lazyRef = <T,>(ref: MutableRefObject<T | null>, make: () => T): T => {
    if (!ref.current) ref.current = make();
    return ref.current;
  };
  const bgReconstructorRef = useRef<BackgroundReconstructor | null>(null);
  const handServiceRef = useRef<HandLandmarkService | null>(null);
  const gestureDetectorRef = useRef<SnapGestureDetector | null>(null);
  const audioEngineRef = useRef<LiveAudioConfirmationEngine | null>(null);
  const perfRef = useRef<FramePerformanceTracker | null>(null);
  const stablePerf = lazyRef(perfRef, () => new FramePerformanceTracker());
  const stableAudioEngine = lazyRef(audioEngineRef, () => new LiveAudioConfirmationEngine());
  const stableHandService = lazyRef(handServiceRef, () => new HandLandmarkService());
  const stableBgReconstructor = lazyRef(
    bgReconstructorRef,
    () => new BackgroundReconstructor(320, 180),
  );

  /** Latest non-visual callbacks, read by the render loop without restarting it. */
  const cbRef = useRef({
    onStatus,
    onMetrics,
    onAudioMonitorChange,
    onDetectionDiagnostics,
    onGestureTriggered,
    onEmergencyRestore,
  });
  cbRef.current = {
    onStatus,
    onMetrics,
    onAudioMonitorChange,
    onDetectionDiagnostics,
    onGestureTriggered,
    onEmergencyRestore,
  };
  const audioClickCtxRef = useRef<AudioContext | null>(null);
  const wakeLoopRef = useRef<(() => void) | null>(null);

  const phaseRef = useRef<{
    p: SnapStatus;
    t0: number;
    from: number;
    to: number;
  }>({
    p: "idle",
    t0: 0,
    from: 0,
    to: 0,
  });

  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState<SnapStatus>("idle");
  const [count, setCount] = useState(0);
  const [measuredFps, setMeasuredFps] = useState<number | null>(null);
  const [measuredMs, setMeasuredMs] = useState<number | null>(null);
  const [liveCameraActive, setLiveCameraActive] = useState(false);
  const [cameraResolution, setCameraResolution] = useState<string | null>(null);
  const [showHandOverlay, setShowHandOverlay] = useState(true);
  const [plateCapturedBadge, setPlateCapturedBadge] = useState(false);
  const [modelLoadText, setModelLoadText] = useState<string | null>(null);

  const latestLandmarksRef = useRef<{
    landmarks: HandLandmark[] | null;
    isCandidate: boolean;
  }>({ landmarks: null, isCandidate: false });

  const settingsRef = useRef({
    duration,
    direction,
    effect,
    speed,
    particleSize,
    density,
    colorAccent,
    intensity,
    motionSmoothness,
    lowPowerMode,
    pauseWhenHidden,
    maxParticles,
    mirrorPreview: fullSettings?.camera.mirrorPreview ?? true,
    backgroundMode: fullSettings?.camera.backgroundMode ?? "temporal-plate",
    gesture: fullSettings?.gesture,
    audio: fullSettings?.audio,
  });
  settingsRef.current = {
    duration,
    direction,
    effect,
    speed,
    particleSize,
    density,
    colorAccent,
    intensity,
    motionSmoothness,
    lowPowerMode,
    pauseWhenHidden,
    maxParticles,
    mirrorPreview: fullSettings?.camera.mirrorPreview ?? true,
    backgroundMode: fullSettings?.camera.backgroundMode ?? "temporal-plate",
    gesture: fullSettings?.gesture,
    audio: fullSettings?.audio,
  };

  const soundRef = useRef(sound);
  soundRef.current = sound;

  /** Last values published to React state — suppresses no-op renders. */
  const lastPublishedRef = useRef<{
    fps: number | null;
    ms: number | null;
    count: number;
  }>({ fps: null, ms: null, count: -1 });

  // Keep gesture detector synced with settings
  useEffect(() => {
    if (!gestureDetectorRef.current) {
      gestureDetectorRef.current = new SnapGestureDetector(
        fullSettings?.gesture ?? {
          enabled: true,
          mode: "balanced",
          sensitivity,
          minHandConfidence: 0.62,
          landmarkSmoothing: 0.35,
          inferenceFpsLimit: 24,
          cooldownMs: 2000,
          requireAudioConfirm: true,
          accidentalTriggerProtection: true,
          calibratedCollapseThresholdMm: 12,
          actionMapping: "toggle-vanish",
        },
      );
    } else if (fullSettings?.gesture) {
      gestureDetectorRef.current.updateSettings(fullSettings.gesture);
    } else {
      gestureDetectorRef.current.updateSettings({ sensitivity });
    }
  }, [fullSettings?.gesture, sensitivity]);

  // Load static calibration studio scene
  useEffect(() => {
    let cancelled = false;
    const scene = new DustScene();
    sceneRef.current = scene;

    const load = (src: string) =>
      new Promise<HTMLImageElement | null>((resolve) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => resolve(null);
        img.src = src;
      });

    Promise.all([load(roomSrc), load(personSrc)]).then(([room, person]) => {
      if (cancelled) return;
      scene.build(room, person, settingsRef.current.maxParticles);
      setCount(scene.particleCount);
      setReady(true);
      wakeLoopRef.current?.();
    });

    return () => {
      cancelled = true;
    };
  }, []);

  const stopLiveCamera = useCallback(() => {
    const vid = videoRef.current;
    if (vid && vid.srcObject) {
      const stream = vid.srcObject as MediaStream;
      for (const track of stream.getTracks()) {
        try {
          track.stop();
        } catch {
          // Ignore
        }
      }
      vid.srcObject = null;
    }
    stableAudioEngine.stop();
    latestLandmarksRef.current = { landmarks: null, isCandidate: false };
    setLiveCameraActive(false);
    setCameraResolution(null);
    onLiveCameraChange?.(false, null);
    onAudioMonitorChange?.(false, 0, -90, -60);
    // Restore studio calibration bitmaps for preview mode
    const load = (src: string) =>
      new Promise<HTMLImageElement | null>((resolve) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => resolve(null);
        img.src = src;
      });
    void Promise.all([load(roomSrc), load(personSrc)]).then(([room, person]) => {
      sceneRef.current?.build(room, person, settingsRef.current.maxParticles);
      wakeLoopRef.current?.();
    });
  }, [onLiveCameraChange, onAudioMonitorChange]);

  const startLiveCamera = useCallback(async () => {
    if (
      typeof navigator === "undefined" ||
      !navigator.mediaDevices?.getUserMedia
    ) {
      onRaiseError?.("UNSUPPORTED_BROWSER", "navigator.mediaDevices unavailable");
      return;
    }

    try {
      const resTarget =
        RESOLUTION_MAP[fullSettings?.camera.targetResolution ?? "1280x720"];
      const videoConstraints: MediaTrackConstraints = {
        width: { ideal: resTarget.width },
        height: { ideal: resTarget.height },
      };
      if (fullSettings?.camera.preferredDeviceId) {
        videoConstraints.deviceId = {
          exact: fullSettings.camera.preferredDeviceId,
        };
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        video: videoConstraints,
        audio: false,
      });

      let vid = videoRef.current;
      if (!vid) {
        vid = document.createElement("video");
        vid.playsInline = true;
        vid.muted = true;
        videoRef.current = vid;
      }
      vid.srcObject = stream;
      await vid.play();

      const track = stream.getVideoTracks()[0];
      if (track) {
        track.addEventListener("ended", () => {
          stopLiveCamera();
          onRaiseError?.("CAMERA_DISCONNECTED", "Video track ended unexpectedly");
        });
      }

      const resLabel = `${vid.videoWidth || resTarget.width}×${vid.videoHeight || resTarget.height}`;
      setLiveCameraActive(true);
      setCameraResolution(resLabel);
      onLiveCameraChange?.(true, resLabel);

      // Start live audio confirmation monitor if enabled
      if (fullSettings?.audio.enabled && fullSettings?.gesture.requireAudioConfirm) {
        const audioRes = await stableAudioEngine.start({
          preferredDeviceId: fullSettings.audio.preferredDeviceId || undefined,
          sensitivityDb: fullSettings.audio.sensitivityDb,
          onDisconnected: () => {
            onRaiseError?.("MICROPHONE_DISCONNECTED");
          },
        });
        if (!audioRes.ok && audioRes.error) {
          onRaiseError?.(classifyMediaError(audioRes.error, "microphone"));
        }
      }

      // Initialize local MediaPipe HandLandmarker if automatic gesture detection is enabled
      if (fullSettings?.gesture.enabled !== false) {
        setModelLoadText("Loading local MediaPipe HandLandmarker…");
        const initRes = await stableHandService.initialize({
          minConfidence: fullSettings?.gesture.minHandConfidence ?? 0.62,
          enableSegmentation:
            fullSettings?.camera.backgroundMode === "ai-segmentation",
          onProgress: (pct, stage) => {
            setModelLoadText(pct < 100 ? `${stage} (${pct}%)` : null);
            onDetectionDiagnostics?.({
              modelStatus: pct < 100 ? "loading" : "ready",
              modelLoadProgress: pct,
              modelError: null,
              handDetected: false,
              handedness: null,
              landmarkConfidence: 0,
              gesturePhase: "no-hand",
              gestureCandidate: false,
              gestureConfirmed: false,
              audioConfirmed: false,
              audioCurrentDb: -90,
              audioFloorDb: -60,
              thumbMiddleDistanceMm: 0,
              approachVelocityMmPerSec: 0,
              wristOmegaRadPerSec: 0,
              cooldownRemainingMs: 0,
              inferenceMs: null,
              lastReason: stage,
              processingErrors: [],
            });
          },
        });
        if (!initRes.ok) {
          setModelLoadText(null);
          onRaiseError?.("MODEL_LOAD_FAILED", initRes.error);
        }
      }

      wakeLoopRef.current?.();
    } catch (err) {
      stopLiveCamera();
      onRaiseError?.(
        classifyMediaError(err, "camera"),
        err instanceof Error ? err.message : String(err),
      );
    }
  }, [
    fullSettings?.camera.targetResolution,
    fullSettings?.camera.preferredDeviceId,
    fullSettings?.camera.backgroundMode,
    fullSettings?.audio.enabled,
    fullSettings?.audio.preferredDeviceId,
    fullSettings?.audio.sensitivityDb,
    fullSettings?.gesture.enabled,
    fullSettings?.gesture.minHandConfidence,
    fullSettings?.gesture.requireAudioConfirm,
    onDetectionDiagnostics,
    onLiveCameraChange,
    onRaiseError,
    stopLiveCamera,
  ]);

  // Respond to external liveCameraRequested prop
  useEffect(() => {
    if (liveCameraRequested && !liveCameraActive) {
      void startLiveCamera();
    } else if (!liveCameraRequested && liveCameraActive) {
      stopLiveCamera();
    }
  }, [liveCameraRequested, liveCameraActive, startLiveCamera, stopLiveCamera]);

  // Capture explicit clean background plate when requested
  const captureCleanBackgroundPlate = useCallback(() => {
    const vid = videoRef.current;
    if (!vid || !liveCameraActive || vid.readyState < 2) return;
    if (!analysisCanvasRef.current) {
      analysisCanvasRef.current = document.createElement("canvas");
    }
    const ac = analysisCanvasRef.current;
    ac.width = 320;
    ac.height = 180;
    const actx = ac.getContext("2d");
    if (!actx) return;
    actx.drawImage(vid, 0, 0, ac.width, ac.height);
    const frame = actx.getImageData(0, 0, ac.width, ac.height);
    stableBgReconstructor.captureCleanPlate(frame);
    setPlateCapturedBadge(true);
  }, [liveCameraActive]);

  useEffect(() => {
    if (capturePlateSignal > 0) {
      captureCleanBackgroundPlate();
    }
  }, [capturePlateSignal, captureCleanBackgroundPlate]);

  const playClickSound = useCallback(() => {
    if (!soundRef.current) return;
    try {
      if (!audioClickCtxRef.current) {
        const AC =
          window.AudioContext ||
          (window as unknown as { webkitAudioContext: typeof AudioContext })
            .webkitAudioContext;
        audioClickCtxRef.current = new AC();
      }
      if (audioClickCtxRef.current.state === "suspended") {
        void audioClickCtxRef.current.resume();
      }
      playSnap(audioClickCtxRef.current);
    } catch {
      /* optional audio feedback */
    }
  }, []);

  const prepareLiveSceneSnapshot = useCallback(() => {
    const vid = videoRef.current;
    if (!liveCameraActive || !vid || vid.readyState < 2 || !sceneRef.current) {
      return;
    }
    if (!analysisCanvasRef.current) {
      analysisCanvasRef.current = document.createElement("canvas");
    }
    const ac = analysisCanvasRef.current;
    ac.width = 320;
    ac.height = 180;
    const actx = ac.getContext("2d");
    if (!actx) return;
    actx.drawImage(vid, 0, 0, ac.width, ac.height);
    const currentFrame = actx.getImageData(0, 0, ac.width, ac.height);
    const segMask =
      settingsRef.current.backgroundMode === "ai-segmentation"
        ? stableHandService.segmentVideoFrame(vid)
        : null;
    const { imageData: plate } =
      stableBgReconstructor.resolveBackgroundPlate(
        settingsRef.current.backgroundMode,
        currentFrame,
      );
    const alpha = stableBgReconstructor.computeForegroundAlpha(
      currentFrame,
      plate,
      segMask,
    );
    sceneRef.current.buildFromLiveVideo(vid, plate, alpha, {
      mirrored: settingsRef.current.mirrorPreview,
      maxParticles: settingsRef.current.maxParticles,
    });
  }, [liveCameraActive]);

  const fire = useCallback(
    (forcedDirection?: "vanish" | "restore") => {
      const ph = phaseRef.current;
      if (!enabledRef.current) return;
      if (ph.p === "vanishing" || ph.p === "returning") return;

      if (forcedDirection === "vanish" && ph.p === "gone") return;
      if (forcedDirection === "restore" && ph.p === "idle") return;

      const next: SnapStatus =
        forcedDirection === "restore"
          ? "returning"
          : forcedDirection === "vanish"
            ? "vanishing"
            : ph.p === "gone"
              ? "returning"
              : "vanishing";

      if (next === "vanishing" && liveCameraActive) {
        prepareLiveSceneSnapshot();
      }

      phaseRef.current = {
        p: next,
        t0: performance.now(),
        from: next === "vanishing" ? 0 : 1,
        to: next === "vanishing" ? 1 : 0,
      };
      setStatus(next);
      onStatus(next);
      playClickSound();
      wakeLoopRef.current?.();
    },
    [liveCameraActive, onStatus, playClickSound, prepareLiveSceneSnapshot],
  );

  const emergencyRestore = useCallback(() => {
    phaseRef.current = { p: "idle", t0: 0, from: 0, to: 0 };
    setStatus("idle");
    onStatus("idle");
    onEmergencyRestore?.();
    wakeLoopRef.current?.();
  }, [onStatus, onEmergencyRestore]);

  // Demand-driven + visibility-aware render & CV inference loop (zero idle CPU waste!)
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !ready) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let raf = 0;
    let running = false;
    let frameCounter = 0;
    let lastInferenceAt = 0;
    let lastMetricsPublishAt = 0;

    /** Reused every frame — the draw loop must not allocate. */
    const renderOptions: EffectRenderOptions = createRenderOptions();

    const drawSingleFrame = (now: number) => {
      const cfg = settingsRef.current;
      if (cfg.pauseWhenHidden && typeof document !== "undefined" && document.hidden) {
        running = false;
        return;
      }

      const renderStart = performance.now();
      const ph = phaseRef.current;
      const effectiveDur =
        Math.max(0.35, cfg.duration / Math.max(0.5, cfg.speed)) * 1000;

      let t = ph.to;
      let isAnimating = false;
      if (ph.p === "vanishing" || ph.p === "returning") {
        isAnimating = true;
        const k = Math.min(1, (renderStart - ph.t0) / effectiveDur);
        t = ph.from + (ph.to - ph.from) * k;
        if (k >= 1) {
          const next: SnapStatus = ph.p === "vanishing" ? "gone" : "idle";
          phaseRef.current = { p: next, t0: renderStart, from: ph.to, to: ph.to };
          t = ph.to;
          isAnimating = false;
          setStatus(next);
          cbRef.current.onStatus(next);
        }
      }

      // Live camera CV & background estimation when live video is active
      const liveVid = liveCameraActive ? videoRef.current : null;
      if (liveVid && liveVid.readyState >= 2 && ph.p === "idle") {
        const fpsCap = cfg.lowPowerMode
          ? Math.min(15, cfg.gesture?.inferenceFpsLimit ?? 15)
          : (cfg.gesture?.inferenceFpsLimit ?? 24);
        const minIntervalMs = 1000 / Math.max(10, fpsCap);

        // Poll live audio confirmation meter
        const audioSnap = cfg.audio?.enabled
          ? stableAudioEngine.poll(now)
          : null;
        if (audioSnap && frameCounter % 6 === 0) {
          cbRef.current.onAudioMonitorChange?.(
            audioSnap.active,
            audioSnap.levelPercent,
            audioSnap.currentDb,
            audioSnap.floorDb,
          );
        }

        // Optional standalone audio trigger when explicitly opted in by user
        if (
          cfg.audio?.enabled &&
          cfg.audio?.allowStandaloneAudioTrigger &&
          audioSnap?.lastTransientAt &&
          now - audioSnap.lastTransientAt < 90
        ) {
          fire();
        }

        if (now - lastInferenceAt >= minIntervalMs) {
          lastInferenceAt = now;

          // Update background plate buffer periodically
          if (frameCounter % 8 === 0) {
            if (!analysisCanvasRef.current) {
              analysisCanvasRef.current = document.createElement("canvas");
            }
            const ac = analysisCanvasRef.current;
            ac.width = 320;
            ac.height = 180;
            const actx = ac.getContext("2d");
            if (actx) {
              actx.drawImage(liveVid, 0, 0, 320, 180);
              stableBgReconstructor.ingestLiveFrame(
                actx.getImageData(0, 0, 320, 180),
              );
            }
          }

          if (
            cfg.gesture?.enabled !== false &&
            stableHandService.currentStatus === "ready"
          ) {
            const inf = stableHandService.detectVideoFrame(liveVid, now);
            const detector = gestureDetectorRef.current;
            if (inf.handDetected && inf.landmarks && detector) {
              const evalRes = detector.evaluateLandmarks(inf.landmarks, now, {
                worldLandmarks: inf.worldLandmarks,
                handConfidence: inf.confidence,
                applySmoothing: true,
                enforceLiveAudioGate: Boolean(
                  cfg.gesture?.requireAudioConfirm && audioSnap?.active,
                ),
                recentAudioOnsetAt: audioSnap?.lastTransientAt ?? null,
                audioConfirmWindowMs: cfg.audio?.confirmWindowMs ?? 220,
              });

              latestLandmarksRef.current = {
                landmarks: inf.landmarks,
                isCandidate: evalRes.candidate || evalRes.phase === "cocked-ready",
              };

              if (frameCounter % 4 === 0 || evalRes.triggered) {
                cbRef.current.onDetectionDiagnostics?.({
                  modelStatus: "ready",
                  modelLoadProgress: 100,
                  modelError: null,
                  handDetected: true,
                  handedness: inf.handedness,
                  landmarkConfidence: inf.confidence,
                  gesturePhase: evalRes.phase,
                  gestureCandidate: evalRes.candidate,
                  gestureConfirmed: evalRes.triggered,
                  audioConfirmed: Boolean(
                    audioSnap?.lastTransientAt &&
                      now - audioSnap.lastTransientAt <=
                        (cfg.audio?.confirmWindowMs ?? 220),
                  ),
                  audioCurrentDb: audioSnap?.currentDb ?? -90,
                  audioFloorDb: audioSnap?.floorDb ?? -60,
                  thumbMiddleDistanceMm: Number(
                    evalRes.thumbMiddleDistance.toFixed(1),
                  ),
                  approachVelocityMmPerSec: Math.round(
                    evalRes.approachVelocityMmPerSec,
                  ),
                  wristOmegaRadPerSec: Number(evalRes.wristOmega.toFixed(2)),
                  cooldownRemainingMs: evalRes.cooldownRemainingMs,
                  inferenceMs: inf.inferenceMs,
                  lastReason: evalRes.reason,
                  processingErrors: [],
                });
              }

              if (evalRes.triggered) {
                const mapping = cfg.gesture?.actionMapping ?? "toggle-vanish";
                cbRef.current.onGestureTriggered?.(mapping);
                if (mapping === "toggle-vanish") {
                  fire();
                } else if (mapping === "vanish-only") {
                  fire("vanish");
                } else if (mapping === "restore-only") {
                  fire("restore");
                }
              }
            } else if (detector) {
              const phase = detector.notifyNoHand(now);
              latestLandmarksRef.current = { landmarks: null, isCandidate: false };
              if (frameCounter % 10 === 0) {
                cbRef.current.onDetectionDiagnostics?.({
                  modelStatus: "ready",
                  modelLoadProgress: 100,
                  modelError: null,
                  handDetected: false,
                  handedness: null,
                  landmarkConfidence: 0,
                  gesturePhase: phase,
                  gestureCandidate: false,
                  gestureConfirmed: false,
                  audioConfirmed: false,
                  audioCurrentDb: audioSnap?.currentDb ?? -90,
                  audioFloorDb: audioSnap?.floorDb ?? -60,
                  thumbMiddleDistanceMm: 0,
                  approachVelocityMmPerSec: 0,
                  wristOmegaRadPerSec: 0,
                  cooldownRemainingMs: 0,
                  inferenceMs: inf.inferenceMs,
                  lastReason: "no-hand",
                  processingErrors: [],
                });
              }
            }
          }
        }
      }

      renderOptions.effect = cfg.effect;
      renderOptions.speed = cfg.speed;
      renderOptions.particleSize = cfg.particleSize;
      renderOptions.density = cfg.density;
      renderOptions.colorAccent = cfg.colorAccent;
      renderOptions.intensity = cfg.intensity;
      renderOptions.motionSmoothness = cfg.motionSmoothness;
      renderOptions.lowPowerMode = cfg.lowPowerMode;
      renderOptions.liveVideoSource = liveVid;
      renderOptions.mirrorLiveVideo = cfg.mirrorPreview;
      sceneRef.current?.render(ctx, t, cfg.direction, cfg.duration, renderOptions);

      // Draw 21-point hand landmark skeleton overlay when enabled on live camera
      if (
        liveCameraActive &&
        showHandOverlay &&
        ph.p === "idle" &&
        latestLandmarksRef.current.landmarks
      ) {
        drawHandLandmarksOverlay(
          ctx,
          latestLandmarksRef.current.landmarks,
          canvas.width,
          canvas.height,
          {
            mirrored: cfg.mirrorPreview,
            accentColor: cfg.colorAccent,
            isCandidate: latestLandmarksRef.current.isCandidate,
          },
        );
      }

      const renderEnd = performance.now();
      if (isAnimating || liveCameraActive) {
        stablePerf.recordFrame(renderStart, renderEnd);
        frameCounter += 1;
        // Telemetry is a *display* concern: publish at most twice a second and
        // only when the value actually changed. Publishing every 12th frame (or
        // worse, every frame while idle-but-live) re-rendered this 1 100-line
        // component — and its parent dashboard — at up to 60 Hz.
        if (renderEnd - lastMetricsPublishAt >= METRICS_INTERVAL_MS) {
          lastMetricsPublishAt = renderEnd;
          const fps = stablePerf.getMeasuredFps();
          const ms = stablePerf.getMeasuredRenderMs();
          const activeCount = sceneRef.current?.particleCount ?? 0;
          if (fps !== lastPublishedRef.current.fps) {
            lastPublishedRef.current.fps = fps;
            setMeasuredFps(fps);
          }
          if (ms !== lastPublishedRef.current.ms) {
            lastPublishedRef.current.ms = ms;
            setMeasuredMs(ms);
          }
          if (activeCount !== lastPublishedRef.current.count) {
            lastPublishedRef.current.count = activeCount;
            setCount(activeCount);
          }
          cbRef.current.onMetrics?.({ fps, renderMs: ms, particles: activeCount });
        }
      }

      if (isAnimating || liveCameraActive) {
        raf = requestAnimationFrame(drawSingleFrame);
      } else {
        running = false;
      }
    };

    const wake = () => {
      if (!running) {
        running = true;
        raf = requestAnimationFrame(drawSingleFrame);
      }
    };
    wakeLoopRef.current = wake;
    wake();

    const onVisibility = () => {
      if (!document.hidden) {
        stablePerf.reset();
        wake();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      running = false;
      cancelAnimationFrame(raf);
      document.removeEventListener("visibilitychange", onVisibility);
    };
    // Intentionally narrow: callbacks are read through `cbRef`, so a parent
    // re-render can no longer tear down and restart the rAF loop mid-transition
    // (previously every parent render cancelled the in-flight animation frame).
  }, [ready, liveCameraActive, showHandOverlay]);

  // Repaint resting static frame whenever visual parameters change
  useEffect(() => {
    wakeLoopRef.current?.();
  }, [
    effect,
    direction,
    duration,
    speed,
    particleSize,
    density,
    colorAccent,
    intensity,
    motionSmoothness,
    lowPowerMode,
  ]);

  // Complete cleanup of camera, microphone, AudioContext, and MediaPipe WASM on unmount
  useEffect(() => {
    // Resolve lazily at teardown: these instances only exist if the user actually
    // enabled the live webcam during this mount.
    return () => {
      const handSvc = handServiceRef.current;
      const audioEng = audioEngineRef.current;
      const vid = videoRef.current;
      if (vid && vid.srcObject) {
        for (const tr of (vid.srcObject as MediaStream).getTracks()) {
          try {
            tr.stop();
          } catch {
            // Ignore
          }
        }
      }
      audioEng?.stop();
      handSvc?.dispose();
      if (
        audioClickCtxRef.current &&
        audioClickCtxRef.current.state !== "closed"
      ) {
        void audioClickCtxRef.current.close().catch(() => {});
      }
    };
  }, []);

  // Keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || !e.shiftKey) return;
      if (e.code === "KeyS") {
        e.preventDefault();
        fire();
      } else if (e.code === "KeyD") {
        e.preventDefault();
        fire("vanish");
      } else if (e.code === "KeyR") {
        e.preventDefault();
        emergencyRestore();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fire, emergencyRestore]);

  useEffect(() => {
    if (snapSignal > 0) fire();
  }, [snapSignal, fire]);

  useEffect(() => {
    if (restoreSignal > 0) fire("restore");
  }, [restoreSignal, fire]);

  useEffect(() => {
    if (emergencySignal > 0) emergencyRestore();
  }, [emergencySignal, emergencyRestore]);

  const statusCopy = STATUS_COPY[status];

  return (
    <div className="overflow-hidden rounded-2xl border border-white/[0.08] bg-[#0e1015] shadow-[0_24px_60px_-25px_rgba(0,0,0,0.85)]">
      {/* Stage Top Telemetry Bar */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/[0.07] bg-[#13151c] px-4 py-2.5">
        <div className="flex flex-wrap items-center gap-2.5">
          <span
            className="h-2.5 w-2.5 rounded-full"
            style={{
              backgroundColor: enabled ? colorAccent : "#52525b",
              boxShadow: enabled ? `0 0 10px ${colorAccent}` : "none",
            }}
          />
          <span className="rail text-[#d4d7e0]">
            {liveCameraActive
              ? `LIVE CAM · ${cameraResolution ?? "HD"}`
              : "CALIBRATION STAGE · 1280×720"}{" "}
            · {EFFECT_LABELS[effect]}
          </span>
          {lowPowerMode && (
            <span className="rounded-full border border-amber-500/30 bg-amber-500/15 px-2 py-0.5 font-mono text-[10px] text-amber-300">
              LOW-POWER
            </span>
          )}
          {plateCapturedBadge && liveCameraActive && (
            <span className="rounded-full border border-emerald-500/30 bg-emerald-500/15 px-2 py-0.5 font-mono text-[10px] text-emerald-300">
              CLEAN PLATE LOCKED
            </span>
          )}
        </div>

        <div className="flex items-center gap-3">
          <span className="rail tnum text-[#8b92a5]">
            {measuredFps !== null
              ? `${measuredFps} FPS · ${measuredMs ?? "—"} MS`
              : "IDLE STANDBY (0% CPU)"}
          </span>
        </div>
      </div>

      {/* Main 16:9 Canvas Viewport */}
      <div className="relative bg-[#09090b]">
        <canvas
          ref={canvasRef}
          width={1280}
          height={720}
          className="block w-full"
          style={{ aspectRatio: "16 / 9" }}
          aria-label={`Camera disintegration viewport rendering ${EFFECT_LABELS[effect]}`}
        />

        {(!ready || modelLoadText) && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/70 backdrop-blur-sm">
            <div className="h-1 w-48 overflow-hidden rounded-full bg-white/10">
              <div className="h-full w-1/2 animate-pulse rounded-full bg-[#f0623a]" />
            </div>
            <span className="rail text-[#e4e6ee]">
              {modelLoadText ?? "INITIALIZING PARTICLE ENGINE…"}
            </span>
          </div>
        )}

        {/* Subtle optical framing reticles */}
        <div className="pointer-events-none absolute inset-0">
          <span className="absolute left-3 top-3 h-4 w-4 border-l border-t border-white/20" />
          <span className="absolute right-3 top-3 h-4 w-4 border-r border-t border-white/20" />
          <span className="absolute bottom-3 left-3 h-4 w-4 border-b border-l border-white/20" />
          <span className="absolute bottom-3 right-3 h-4 w-4 border-b border-r border-white/20" />
        </div>

        {/* Status HUD pill */}
        <div
          aria-live="polite"
          className="pointer-events-none absolute bottom-3.5 left-3.5 flex items-center gap-2"
        >
          <span
            className={`rail rounded-lg border border-white/10 bg-black/75 px-3 py-1.5 backdrop-blur-md ${statusCopy.tone}`}
          >
            {statusCopy.label}
          </span>
        </div>

        <div className="pointer-events-none absolute right-3.5 top-3.5 text-right">
          <div className="rail rounded-md bg-black/65 px-2.5 py-1 text-[#ff9d80] backdrop-blur-sm">
            100% LOCAL · 0 B EGRESS
          </div>
          <div className="rail tnum mt-1 text-white/60">
            {count ? count.toLocaleString() : "0"} PARTICLES
          </div>
        </div>
      </div>

      {/* Stage Transport & Camera Source Controls */}
      <div className="flex flex-wrap items-center justify-between gap-2.5 border-t border-white/[0.07] bg-[#13151c] px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => fire()}
            disabled={!enabled || status === "vanishing" || status === "returning"}
            className={`inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-[12.5px] font-semibold transition-all ${
              enabled && status !== "vanishing" && status !== "returning"
                ? "bg-gradient-to-b from-[#f0623a] to-[#d2451e] text-white shadow-[0_6px_18px_-6px_rgba(224,83,44,0.6)] hover:from-[#ff764f] hover:to-[#e0532c]"
                : "cursor-not-allowed bg-white/[0.06] text-white/35"
            }`}
          >
            <Sparkles className="h-4 w-4" />
            {!enabled
              ? "Extension Disabled"
              : status === "gone"
                ? "Snap to Return"
                : status === "idle"
                  ? "Vanish Now"
                  : "Transitioning…"}
          </button>

          <button
            type="button"
            onClick={emergencyRestore}
            className="inline-flex items-center gap-1.5 rounded-xl border border-red-500/35 bg-red-500/15 px-3.5 py-2.5 text-[12px] font-medium text-red-200 transition-colors hover:bg-red-500/25"
            title="Unconditionally restores live camera feed and unmutes microphone (Alt+Shift+R)"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            Emergency Restore
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => {
              if (liveCameraActive) {
                stopLiveCamera();
              } else {
                void startLiveCamera();
              }
            }}
            className={`inline-flex items-center gap-1.5 rounded-xl border px-3 py-2 text-[12px] font-medium transition-colors ${
              liveCameraActive
                ? "border-emerald-500/40 bg-emerald-500/15 text-emerald-200 hover:bg-emerald-500/25"
                : "border-white/10 bg-[#1c1f28] text-[#c9cdd8] hover:border-white/20 hover:text-white"
            }`}
          >
            {liveCameraActive ? (
              <>
                <CameraOff className="h-3.5 w-3.5" />
                Stop Live Webcam
              </>
            ) : (
              <>
                <Camera className="h-3.5 w-3.5" />
                Enable Live Webcam + Hand AI
              </>
            )}
          </button>

          {liveCameraActive && (
            <>
              <button
                type="button"
                onClick={captureCleanBackgroundPlate}
                className="inline-flex items-center gap-1.5 rounded-xl border border-white/10 bg-[#1c1f28] px-3 py-2 text-[12px] text-[#c9cdd8] hover:border-white/25 hover:text-white"
                title="Capture empty room background plate for cleanest vanish compositing"
              >
                <ImagePlus className="h-3.5 w-3.5" />
                Capture Clean Plate
              </button>
              <button
                type="button"
                onClick={() => setShowHandOverlay((v) => !v)}
                className={`inline-flex items-center gap-1.5 rounded-xl border px-3 py-2 text-[12px] ${
                  showHandOverlay
                    ? "border-[#f0623a]/40 bg-[#e0532c]/15 text-[#ff9d80]"
                    : "border-white/10 bg-[#1c1f28] text-[#9ca3b8]"
                }`}
                title="Toggle 21-point hand landmark skeleton overlay"
              >
                {showHandOverlay ? (
                  <Hand className="h-3.5 w-3.5" />
                ) : (
                  <Eye className="h-3.5 w-3.5" />
                )}
                21-Pt Landmarks
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Memoised: the parent dashboard re-renders on every settings keystroke and on
 * every audio-meter tick. Without `memo` each of those re-rendered this whole
 * stage tree (canvas element + telemetry bars + 6 buttons).
 */
const SnapStage = memo(SnapStageImpl);
export default SnapStage;
