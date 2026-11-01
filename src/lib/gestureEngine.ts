import type {
  DetectionMode,
  GesturePhase,
  GestureSettings,
} from "../types/snapVanish";
import { DEFAULT_SETTINGS, DETECTION_MODE_PROFILES } from "./settings";

export interface HandLandmark {
  x: number;
  y: number;
  z?: number;
}

export interface SnapCandidateEvaluation {
  triggered: boolean;
  candidate: boolean;
  phase: GesturePhase;
  confidence: number;
  reason:
    | "confirmed"
    | "disabled"
    | "low-confidence"
    | "invalid-landmarks"
    | "cooldown-active"
    | "fingers-not-extended"
    | "wrist-moving-too-fast"
    | "bbox-unstable"
    | "no-collapse-detected"
    | "awaiting-audio-confirm";
  thumbMiddleDistance: number;
  approachVelocityMmPerSec: number;
  wristOmega: number;
  bboxDelta: number;
  cooldownRemainingMs: number;
}

export const SNAP_CONSTANTS = {
  DEFAULT_TIP_NEAR_MM: 12,
  DEFAULT_TIP_FAR_MM: 45,
  COLLAPSE_WINDOW_MS: 140,
  MIN_APPROACH_VELOCITY_MM_S: 140,
  MAX_WRIST_OMEGA_RAD_S: 2.2,
  MAX_BBOX_AREA_DELTA: 0.4,
  TRACKING_LOSS_TIMEOUT_MS: 380,
  AUDIO_CONFIRM_WINDOW_MS: 220,
  AUDIO_MIN_DB_JUMP: 12,
  AUDIO_MAX_TRANSIENT_MS: 90,
  AUDIO_BAND_HZ: [2500, 5500] as const,
  REFERENCE_PALM_MM: 82,
};

export function dist3(a: HandLandmark, b: HandLandmark): number {
  return Math.hypot(a.x - b.x, a.y - b.y, (a.z ?? 0) - (b.z ?? 0));
}

/**
 * Converts MediaPipe worldLandmarks (meters) or normalized image landmarks ([0..1])
 * into consistent anatomical millimeters, while preserving inputs already in mm.
 */
export function normalizeLandmarksToMm(
  landmarks: HandLandmark[],
  worldLandmarks?: HandLandmark[] | null,
): HandLandmark[] {
  if (Array.isArray(worldLandmarks) && worldLandmarks.length >= 21) {
    const maxAbs = worldLandmarks.reduce(
      (m, p) => Math.max(m, Math.abs(p.x), Math.abs(p.y), Math.abs(p.z ?? 0)),
      0,
    );
    // MediaPipe worldLandmarks are in meters (coordinates < 1.0 m)
    const factor = maxAbs > 0 && maxAbs < 1.5 ? 1000 : 1;
    return worldLandmarks.map((p) => ({
      x: p.x * factor,
      y: p.y * factor,
      z: (p.z ?? 0) * factor,
    }));
  }

  if (!Array.isArray(landmarks) || landmarks.length < 21) {
    return landmarks;
  }

  const palmSpan = Math.hypot(
    landmarks[0].x - landmarks[9].x,
    landmarks[0].y - landmarks[9].y,
  );
  // Already in millimeter coordinate space (e.g. synthetic test frames where palmSpan >= 5)
  if (palmSpan >= 5) {
    return landmarks;
  }
  const safeSpan = Math.max(0.02, palmSpan);
  const scale = SNAP_CONSTANTS.REFERENCE_PALM_MM / safeSpan;
  return landmarks.map((p) => ({
    x: p.x * scale,
    y: p.y * scale,
    z: (p.z ?? 0) * scale,
  }));
}

/**
 * Velocity-adaptive exponential moving average filter for 21 hand landmarks.
 * Smooths resting camera noise while preserving high-speed finger snap collapse.
 */
export class LandmarkSmoother {
  private prev: HandLandmark[] | null = null;
  private prevTimestamp = 0;

  reset() {
    this.prev = null;
    this.prevTimestamp = 0;
  }

  smooth(
    rawMm: HandLandmark[],
    smoothingFactor: number,
    now = performance.now(),
  ): HandLandmark[] {
    const clampedAlpha = Math.max(0, Math.min(0.85, smoothingFactor));
    if (
      !this.prev ||
      this.prev.length !== rawMm.length ||
      clampedAlpha <= 0.01 ||
      now - this.prevTimestamp > SNAP_CONSTANTS.TRACKING_LOSS_TIMEOUT_MS
    ) {
      this.prev = rawMm.map((p) => ({ ...p }));
      this.prevTimestamp = now;
      return this.prev;
    }

    const dt = Math.max(0.004, (now - this.prevTimestamp) / 1000);
    this.prevTimestamp = now;

    const next: HandLandmark[] = new Array(rawMm.length);
    for (let i = 0; i < rawMm.length; i++) {
      const p = rawMm[i];
      const q = this.prev[i];
      const speedMmPerSec = dist3(p, q) / dt;
      // Reduce lag dynamically when finger tip moves rapidly (> 250 mm/s)
      const dynamicHistoryWeight =
        speedMmPerSec > 250 ? clampedAlpha * 0.12 : clampedAlpha;
      const wNew = 1 - dynamicHistoryWeight;
      next[i] = {
        x: q.x * dynamicHistoryWeight + p.x * wNew,
        y: q.y * dynamicHistoryWeight + p.y * wNew,
        z: (q.z ?? 0) * dynamicHistoryWeight + (p.z ?? 0) * wNew,
      };
    }
    this.prev = next;
    return next;
  }
}

export function computeBoundingBox(lm: HandLandmark[]) {
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  for (const p of lm) {
    if (p.x < x0) x0 = p.x;
    if (p.x > x1) x1 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.y > y1) y1 = p.y;
  }
  return { x0, x1, y0, y1 };
}

export function computeBoxArea(b: {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}): number {
  return Math.max(1e-6, (b.x1 - b.x0) * (b.y1 - b.y0));
}

interface HistorySample {
  d: number;
  now: number;
  extended: boolean;
  spread: number;
  omega: number;
  bboxDelta: number;
}

export function getSettingsForDetectionMode(
  mode: Exclude<DetectionMode, "custom">,
  current: GestureSettings = DEFAULT_SETTINGS.gesture,
): GestureSettings {
  const profile = DETECTION_MODE_PROFILES[mode];
  return {
    ...current,
    mode,
    sensitivity: profile.sensitivity,
    minHandConfidence: profile.minHandConfidence,
    landmarkSmoothing: profile.landmarkSmoothing,
    calibratedCollapseThresholdMm: profile.calibratedCollapseThresholdMm,
    cooldownMs: profile.cooldownMs,
  };
}

export class SnapGestureDetector {
  private history: HistorySample[] = [];
  private lastAngle: number | null = null;
  private lastAngleAt = 0;
  private lastBBox: { x0: number; x1: number; y0: number; y1: number } | null =
    null;
  private lastSeenHandAt = -Infinity;
  private lastTriggeredAt = -Infinity;
  private pendingVisualCandidateAt: number | null = null;
  private smoother = new LandmarkSmoother();
  private settings: GestureSettings;

  constructor(settings: GestureSettings) {
    this.settings = {
      ...DEFAULT_SETTINGS.gesture,
      ...settings,
    };
  }

  updateSettings(settings: Partial<GestureSettings>) {
    this.settings = {
      ...this.settings,
      ...settings,
    };
  }

  reset() {
    this.history = [];
    this.lastAngle = null;
    this.lastAngleAt = 0;
    this.lastBBox = null;
    this.lastSeenHandAt = -Infinity;
    this.lastTriggeredAt = -Infinity;
    this.pendingVisualCandidateAt = null;
    this.smoother.reset();
  }

  /**
   * Handles tracking loss when a frame contains no detected hand.
   */
  notifyNoHand(now = performance.now()): GesturePhase {
    if (now - this.lastSeenHandAt > SNAP_CONSTANTS.TRACKING_LOSS_TIMEOUT_MS) {
      this.history = [];
      this.lastAngle = null;
      this.lastBBox = null;
      this.smoother.reset();
    }
    if (now - this.lastTriggeredAt < this.settings.cooldownMs) {
      return "cooldown";
    }
    return "no-hand";
  }

  /**
   * Evaluates a 21-landmark hand frame with full state-machine progression,
   * confidence gating, optional smoothing, and optional acoustic confirmation gate.
   */
  evaluateLandmarks(
    rawLandmarks: HandLandmark[],
    now = performance.now(),
    options: {
      worldLandmarks?: HandLandmark[] | null;
      handConfidence?: number;
      enforceLiveAudioGate?: boolean;
      recentAudioOnsetAt?: number | null;
      audioConfirmWindowMs?: number;
      applySmoothing?: boolean;
    } = {},
  ): SnapCandidateEvaluation {
    const confidence = options.handConfidence ?? 1.0;

    if (!this.settings.enabled) {
      return {
        triggered: false,
        candidate: false,
        phase: "no-hand",
        confidence,
        reason: "disabled",
        thumbMiddleDistance: 0,
        approachVelocityMmPerSec: 0,
        wristOmega: 0,
        bboxDelta: 0,
        cooldownRemainingMs: 0,
      };
    }

    if (!Array.isArray(rawLandmarks) || rawLandmarks.length < 21) {
      return {
        triggered: false,
        candidate: false,
        phase: "no-hand",
        confidence: 0,
        reason: "invalid-landmarks",
        thumbMiddleDistance: 0,
        approachVelocityMmPerSec: 0,
        wristOmega: 0,
        bboxDelta: 0,
        cooldownRemainingMs: 0,
      };
    }

    const minConf = this.settings.minHandConfidence ?? 0.55;
    if (confidence < minConf) {
      return {
        triggered: false,
        candidate: false,
        phase: "no-hand",
        confidence,
        reason: "low-confidence",
        thumbMiddleDistance: 0,
        approachVelocityMmPerSec: 0,
        wristOmega: 0,
        bboxDelta: 0,
        cooldownRemainingMs: 0,
      };
    }

    // Reset stale trajectory if hand was lost between frames
    if (
      this.lastSeenHandAt > 0 &&
      now - this.lastSeenHandAt > SNAP_CONSTANTS.TRACKING_LOSS_TIMEOUT_MS
    ) {
      this.history = [];
      this.lastAngle = null;
      this.lastBBox = null;
      this.smoother.reset();
    }
    this.lastSeenHandAt = now;

    const mmLandmarks = normalizeLandmarksToMm(
      rawLandmarks,
      options.worldLandmarks,
    );
    const lm = options.applySmoothing
      ? this.smoother.smooth(
          mmLandmarks,
          this.settings.landmarkSmoothing ?? 0.35,
          now,
        )
      : mmLandmarks;

    const d = dist3(lm[4], lm[12]);

    const elapsedSinceTrigger = now - this.lastTriggeredAt;
    if (elapsedSinceTrigger < this.settings.cooldownMs) {
      return {
        triggered: false,
        candidate: false,
        phase: "cooldown",
        confidence,
        reason: "cooldown-active",
        thumbMiddleDistance: d,
        approachVelocityMmPerSec: 0,
        wristOmega: 0,
        bboxDelta: 0,
        cooldownRemainingMs: Math.max(
          0,
          Math.round(this.settings.cooldownMs - elapsedSinceTrigger),
        ),
      };
    }

    // Check if a pending visual snap candidate is waiting on live audio confirmation
    const confirmWin =
      options.audioConfirmWindowMs ?? SNAP_CONSTANTS.AUDIO_CONFIRM_WINDOW_MS;
    if (
      options.enforceLiveAudioGate &&
      this.settings.requireAudioConfirm &&
      this.pendingVisualCandidateAt !== null
    ) {
      if (now - this.pendingVisualCandidateAt <= confirmWin) {
        if (
          options.recentAudioOnsetAt !== null &&
          options.recentAudioOnsetAt !== undefined &&
          Math.abs(options.recentAudioOnsetAt - this.pendingVisualCandidateAt) <=
            confirmWin
        ) {
          this.pendingVisualCandidateAt = null;
          this.history = [];
          this.lastTriggeredAt = now;
          return {
            triggered: true,
            candidate: true,
            phase: "confirmed",
            confidence,
            reason: "confirmed",
            thumbMiddleDistance: d,
            approachVelocityMmPerSec: 0,
            wristOmega: 0,
            bboxDelta: 0,
            cooldownRemainingMs: this.settings.cooldownMs,
          };
        }
      } else {
        this.pendingVisualCandidateAt = null;
      }
    }

    // Strictness factor: sensitivity 100 -> strictest, sensitivity 0 -> most forgiving
    const strictness = Math.max(0, Math.min(1, this.settings.sensitivity / 100));
    const extensionRatio = 1.04 + strictness * 0.11;

    // Index finger (8 vs 6) and pinky/ring posture check during snap
    const indexExtended = dist3(lm[8], lm[0]) > dist3(lm[6], lm[0]) * extensionRatio;
    const pinkyExtended =
      dist3(lm[20], lm[0]) > dist3(lm[18], lm[0]) * (extensionRatio - 0.03);
    const extended =
      this.settings.mode === "beginner"
        ? indexExtended || pinkyExtended
        : indexExtended && pinkyExtended;
    const spread = dist3(lm[8], lm[20]);

    const bbox = computeBoundingBox(lm);
    const omega = this.computeWristAngularVelocity(lm, now);
    const bboxDelta = this.lastBBox
      ? Math.abs(computeBoxArea(bbox) - computeBoxArea(this.lastBBox)) /
        computeBoxArea(this.lastBBox)
      : 0;
    this.lastBBox = bbox;

    this.history.push({ d, now, extended, spread, omega, bboxDelta });
    if (this.history.length > 28) {
      this.history.shift();
    }

    const maxOmega =
      SNAP_CONSTANTS.MAX_WRIST_OMEGA_RAD_S * (1.32 - strictness * 0.5);
    const maxBboxDelta =
      SNAP_CONSTANTS.MAX_BBOX_AREA_DELTA * (1.32 - strictness * 0.5);

    if (this.settings.accidentalTriggerProtection) {
      if (omega > maxOmega) {
        return {
          triggered: false,
          candidate: false,
          phase: "hand-detected",
          confidence,
          reason: "wrist-moving-too-fast",
          thumbMiddleDistance: d,
          approachVelocityMmPerSec: 0,
          wristOmega: omega,
          bboxDelta,
          cooldownRemainingMs: 0,
        };
      }
      if (bboxDelta > maxBboxDelta) {
        return {
          triggered: false,
          candidate: false,
          phase: "hand-detected",
          confidence,
          reason: "bbox-unstable",
          thumbMiddleDistance: d,
          approachVelocityMmPerSec: 0,
          wristOmega: omega,
          bboxDelta,
          cooldownRemainingMs: 0,
        };
      }
    }

    if (!extended) {
      return {
        triggered: false,
        candidate: false,
        phase: "hand-detected",
        confidence,
        reason: "fingers-not-extended",
        thumbMiddleDistance: d,
        approachVelocityMmPerSec: 0,
        wristOmega: omega,
        bboxDelta,
        cooldownRemainingMs: 0,
      };
    }

    const farThreshold =
      SNAP_CONSTANTS.DEFAULT_TIP_FAR_MM * (0.78 + strictness * 0.3);
    const baseNear =
      this.settings.calibratedCollapseThresholdMm ||
      SNAP_CONSTANTS.DEFAULT_TIP_NEAR_MM;
    const nearThreshold = baseNear * (1.35 - strictness * 0.55);

    const farSample = this.history.find(
      (h) =>
        now - h.now <= SNAP_CONSTANTS.COLLAPSE_WINDOW_MS && h.d > farThreshold,
    );
    const isNear = d <= nearThreshold;

    const dtSec = farSample ? Math.max(0.008, (now - farSample.now) / 1000) : 0;
    const approachVelocity = farSample ? (farSample.d - d) / dtSec : 0;

    if (!farSample || !isNear || approachVelocity < SNAP_CONSTANTS.MIN_APPROACH_VELOCITY_MM_S) {
      const isCocked = d > farThreshold || Boolean(farSample);
      return {
        triggered: false,
        candidate: false,
        phase: isCocked ? "cocked-ready" : "hand-detected",
        confidence,
        reason: "no-collapse-detected",
        thumbMiddleDistance: d,
        approachVelocityMmPerSec: Math.max(0, approachVelocity),
        wristOmega: omega,
        bboxDelta,
        cooldownRemainingMs: 0,
      };
    }

    // Visual snap collapse verified! Check live audio confirmation if enforced
    if (options.enforceLiveAudioGate && this.settings.requireAudioConfirm) {
      const audioHit =
        options.recentAudioOnsetAt !== null &&
        options.recentAudioOnsetAt !== undefined &&
        Math.abs(now - options.recentAudioOnsetAt) <= confirmWin;

      if (!audioHit) {
        this.pendingVisualCandidateAt = now;
        return {
          triggered: false,
          candidate: true,
          phase: "awaiting-audio",
          confidence,
          reason: "awaiting-audio-confirm",
          thumbMiddleDistance: d,
          approachVelocityMmPerSec: approachVelocity,
          wristOmega: omega,
          bboxDelta,
          cooldownRemainingMs: 0,
        };
      }
    }

    this.pendingVisualCandidateAt = null;
    this.history = [];
    this.lastTriggeredAt = now;
    return {
      triggered: true,
      candidate: true,
      phase: "confirmed",
      confidence,
      reason: "confirmed",
      thumbMiddleDistance: d,
      approachVelocityMmPerSec: approachVelocity,
      wristOmega: omega,
      bboxDelta,
      cooldownRemainingMs: this.settings.cooldownMs,
    };
  }

  private computeWristAngularVelocity(lm: HandLandmark[], now: number): number {
    const a = Math.atan2(lm[0].y - lm[9].y, lm[0].x - lm[9].x);
    if (this.lastAngle === null) {
      this.lastAngle = a;
      this.lastAngleAt = now;
      return 0;
    }
    const dt = (now - this.lastAngleAt) / 1000 || 0.033;
    let da = a - this.lastAngle;
    if (da > Math.PI) da -= Math.PI * 2;
    if (da < -Math.PI) da += Math.PI * 2;
    this.lastAngle = a;
    this.lastAngleAt = now;
    return Math.abs(da / dt);
  }
}

/**
 * Acoustic transient confirmer that distinguishes a crisp <90ms snap transient
 * (>= sensitivityDb above adaptive room noise floor) from sustained speech or typing.
 */
export class AcousticSnapConfirmer {
  private floorDb = -60;
  private activeBurstStartAt: number | null = null;
  private lastConfirmedOnsetAt: number | null = null;

  reset() {
    this.floorDb = -60;
    this.activeBurstStartAt = null;
    this.lastConfirmedOnsetAt = null;
  }

  getLastConfirmedOnset(): number | null {
    return this.lastConfirmedOnsetAt;
  }

  /**
   * Evaluates a time-domain float sample buffer.
   * Returns the onset timestamp in ms if a valid short acoustic transient occurred.
   */
  evaluateSamples(
    samples: Float32Array,
    now = performance.now(),
    minDbJump: number = SNAP_CONSTANTS.AUDIO_MIN_DB_JUMP,
  ): {
    onsetAt: number | null;
    currentDb: number;
    floorDb: number;
    jumpDb: number;
  } {
    if (!samples || samples.length === 0) {
      return {
        onsetAt: null,
        currentDb: -100,
        floorDb: this.floorDb,
        jumpDb: 0,
      };
    }
    let sum = 0;
    for (let i = 0; i < samples.length; i++) {
      sum += samples[i] * samples[i];
    }
    const rms = Math.sqrt(sum / samples.length);
    const db = 20 * Math.log10(rms + 1e-9);

    const jump = db - this.floorDb;

    // Adapt noise floor slowly during quiet frames
    if (jump < 3) {
      this.floorDb += (db - this.floorDb) * 0.04;
    }

    if (jump >= minDbJump) {
      if (this.activeBurstStartAt === null) {
        this.activeBurstStartAt = now;
        this.lastConfirmedOnsetAt = now;
        return {
          onsetAt: now,
          currentDb: db,
          floorDb: this.floorDb,
          jumpDb: jump,
        };
      }
      const burstDuration = now - this.activeBurstStartAt;
      if (burstDuration > SNAP_CONSTANTS.AUDIO_MAX_TRANSIENT_MS) {
        // Sustained loud sound (e.g. speech/laughter), invalidate transient
        this.lastConfirmedOnsetAt = null;
        return {
          onsetAt: null,
          currentDb: db,
          floorDb: this.floorDb,
          jumpDb: jump,
        };
      }
      return {
        onsetAt: this.lastConfirmedOnsetAt,
        currentDb: db,
        floorDb: this.floorDb,
        jumpDb: jump,
      };
    } else {
      this.activeBurstStartAt = null;
      return {
        onsetAt: null,
        currentDb: db,
        floorDb: this.floorDb,
        jumpDb: jump,
      };
    }
  }
}

/**
 * Generates realistic 21-point hand landmark sequences for unit tests and
 * Gesture Calibration previews when no physical webcam is connected.
 */
export function createSyntheticHandFrame(options: {
  thumbMiddleDistMm: number;
  indexExtended?: boolean;
  pinkyExtended?: boolean;
  wristOffsetRad?: number;
  bboxScale?: number;
}): HandLandmark[] {
  const {
    thumbMiddleDistMm,
    indexExtended = true,
    pinkyExtended = true,
    wristOffsetRad = 0,
    bboxScale = 1,
  } = options;

  const lm: HandLandmark[] = Array.from({ length: 21 }, (_, idx) => ({
    x: idx * 2 * bboxScale,
    y: idx * 2 * bboxScale,
    z: 0,
  }));

  lm[0] = { x: 0, y: 0, z: 0 };
  lm[9] = {
    x: Math.cos(wristOffsetRad) * 40 * bboxScale,
    y: Math.sin(wristOffsetRad) * 40 * bboxScale,
    z: 0,
  };
  lm[4] = { x: 20, y: 20, z: 0 };
  lm[12] = { x: 20 + thumbMiddleDistMm, y: 20, z: 0 };
  lm[6] = { x: 0, y: 30 * bboxScale, z: 0 };
  lm[8] = { x: 0, y: (indexExtended ? 45 : 25) * bboxScale, z: 0 };
  lm[18] = { x: 30 * bboxScale, y: 0, z: 0 };
  lm[20] = { x: (pinkyExtended ? 45 : 25) * bboxScale, y: 0, z: 0 };

  return lm;
}
