import type { GestureSettings } from "../types/snapVanish";

export interface HandLandmark {
  x: number;
  y: number;
  z?: number;
}

export interface SnapCandidateEvaluation {
  triggered: boolean;
  reason:
    | "confirmed"
    | "disabled"
    | "invalid-landmarks"
    | "cooldown-active"
    | "fingers-not-extended"
    | "wrist-moving-too-fast"
    | "bbox-unstable"
    | "no-collapse-detected"
    | "awaiting-audio-confirm";
  thumbMiddleDistance: number;
  wristOmega: number;
  bboxDelta: number;
  cooldownRemainingMs: number;
}

export const SNAP_CONSTANTS = {
  DEFAULT_TIP_NEAR_MM: 12,
  DEFAULT_TIP_FAR_MM: 45,
  COLLAPSE_WINDOW_MS: 120,
  MAX_WRIST_OMEGA_RAD_S: 2.2,
  MAX_BBOX_AREA_DELTA: 0.4,
  AUDIO_CONFIRM_WINDOW_MS: 220,
  AUDIO_MIN_DB_JUMP: 12,
  AUDIO_MAX_TRANSIENT_MS: 90,
  AUDIO_BAND_HZ: [2500, 5500] as const,
};

export function dist3(a: HandLandmark, b: HandLandmark): number {
  return Math.hypot(a.x - b.x, a.y - b.y, (a.z ?? 0) - (b.z ?? 0));
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

export class SnapGestureDetector {
  private history: HistorySample[] = [];
  private lastAngle: number | null = null;
  private lastAngleAt = 0;
  private lastBBox: { x0: number; x1: number; y0: number; y1: number } | null =
    null;
  private lastTriggeredAt = -Infinity;
  private settings: GestureSettings;

  constructor(settings: GestureSettings) {
    this.settings = { ...settings };
  }

  updateSettings(settings: GestureSettings) {
    this.settings = { ...settings };
  }

  reset() {
    this.history = [];
    this.lastAngle = null;
    this.lastAngleAt = 0;
    this.lastBBox = null;
    this.lastTriggeredAt = -Infinity;
  }

  /**
   * Evaluates a 21-landmark hand frame.
   * Respects sensitivity ("Higher = stricter trigger"), cooldown, and accidental-trigger protection.
   */
  evaluateLandmarks(
    lm: HandLandmark[],
    now = performance.now(),
  ): SnapCandidateEvaluation {
    if (!this.settings.enabled) {
      return {
        triggered: false,
        reason: "disabled",
        thumbMiddleDistance: 0,
        wristOmega: 0,
        bboxDelta: 0,
        cooldownRemainingMs: 0,
      };
    }

    if (!Array.isArray(lm) || lm.length < 21) {
      return {
        triggered: false,
        reason: "invalid-landmarks",
        thumbMiddleDistance: 0,
        wristOmega: 0,
        bboxDelta: 0,
        cooldownRemainingMs: 0,
      };
    }

    const elapsedSinceTrigger = now - this.lastTriggeredAt;
    if (elapsedSinceTrigger < this.settings.cooldownMs) {
      return {
        triggered: false,
        reason: "cooldown-active",
        thumbMiddleDistance: dist3(lm[4], lm[12]),
        wristOmega: 0,
        bboxDelta: 0,
        cooldownRemainingMs: Math.max(
          0,
          Math.round(this.settings.cooldownMs - elapsedSinceTrigger),
        ),
      };
    }

    const d = dist3(lm[4], lm[12]);
    // Strictness factor: sensitivity 100 -> strictest, sensitivity 0 -> most permissive
    const strictness = Math.max(0, Math.min(1, this.settings.sensitivity / 100));
    const extensionRatio = 1.06 + strictness * 0.1;

    const extended =
      dist3(lm[8], lm[0]) > dist3(lm[6], lm[0]) * extensionRatio &&
      dist3(lm[20], lm[0]) > dist3(lm[18], lm[0]) * extensionRatio;
    const spread = dist3(lm[8], lm[20]);

    const bbox = computeBoundingBox(lm);
    const omega = this.computeWristAngularVelocity(lm, now);
    const bboxDelta = this.lastBBox
      ? Math.abs(computeBoxArea(bbox) - computeBoxArea(this.lastBBox)) /
        computeBoxArea(this.lastBBox)
      : 0;
    this.lastBBox = bbox;

    this.history.push({ d, now, extended, spread, omega, bboxDelta });
    if (this.history.length > 24) {
      this.history.shift();
    }

    const maxOmega =
      SNAP_CONSTANTS.MAX_WRIST_OMEGA_RAD_S * (1.3 - strictness * 0.5);
    const maxBboxDelta =
      SNAP_CONSTANTS.MAX_BBOX_AREA_DELTA * (1.3 - strictness * 0.5);

    if (this.settings.accidentalTriggerProtection) {
      if (omega > maxOmega) {
        return {
          triggered: false,
          reason: "wrist-moving-too-fast",
          thumbMiddleDistance: d,
          wristOmega: omega,
          bboxDelta,
          cooldownRemainingMs: 0,
        };
      }
      if (bboxDelta > maxBboxDelta) {
        return {
          triggered: false,
          reason: "bbox-unstable",
          thumbMiddleDistance: d,
          wristOmega: omega,
          bboxDelta,
          cooldownRemainingMs: 0,
        };
      }
    }

    if (!extended) {
      return {
        triggered: false,
        reason: "fingers-not-extended",
        thumbMiddleDistance: d,
        wristOmega: omega,
        bboxDelta,
        cooldownRemainingMs: 0,
      };
    }

    const farThreshold =
      SNAP_CONSTANTS.DEFAULT_TIP_FAR_MM * (0.8 + strictness * 0.3);
    // Higher sensitivity (strictness) requires fingers to close tighter (< nearThreshold)
    const baseNear =
      this.settings.calibratedCollapseThresholdMm ||
      SNAP_CONSTANTS.DEFAULT_TIP_NEAR_MM;
    const nearThreshold = baseNear * (1.35 - strictness * 0.55);

    const farSample = this.history.find(
      (h) =>
        now - h.now <= SNAP_CONSTANTS.COLLAPSE_WINDOW_MS && h.d > farThreshold,
    );
    const isNear = d <= nearThreshold;

    if (!farSample || !isNear) {
      return {
        triggered: false,
        reason: "no-collapse-detected",
        thumbMiddleDistance: d,
        wristOmega: omega,
        bboxDelta,
        cooldownRemainingMs: 0,
      };
    }

    this.history = [];
    this.lastTriggeredAt = now;
    return {
      triggered: true,
      reason: "confirmed",
      thumbMiddleDistance: d,
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
 * (>=12dB above adaptive room noise floor) from sustained speech or typing.
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

  /**
   * Evaluates a time-domain float sample buffer.
   * Returns the onset timestamp in ms if a valid short acoustic transient occurred.
   */
  evaluateSamples(
    samples: Float32Array,
    now = performance.now(),
    minDbJump: number = SNAP_CONSTANTS.AUDIO_MIN_DB_JUMP,
  ): { onsetAt: number | null; currentDb: number; floorDb: number; jumpDb: number } {
    if (!samples || samples.length === 0) {
      return { onsetAt: null, currentDb: -100, floorDb: this.floorDb, jumpDb: 0 };
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
 * Gesture Studio calibration previews.
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
    x: (idx * 2) * bboxScale,
    y: (idx * 2) * bboxScale,
    z: 0,
  }));

  // Landmark 0: Wrist at origin
  lm[0] = { x: 0, y: 0, z: 0 };
  // Landmark 9: Middle MCP (defines wrist angle)
  lm[9] = {
    x: Math.cos(wristOffsetRad) * 40 * bboxScale,
    y: Math.sin(wristOffsetRad) * 40 * bboxScale,
    z: 0,
  };

  // Landmark 4 (Thumb tip) & Landmark 12 (Middle tip)
  lm[4] = { x: 20, y: 20, z: 0 };
  lm[12] = { x: 20 + thumbMiddleDistMm, y: 20, z: 0 };

  // Landmark 6 (Index PIP) & Landmark 8 (Index tip)
  lm[6] = { x: 0, y: 30 * bboxScale, z: 0 };
  lm[8] = {
    x: 0,
    y: (indexExtended ? 45 : 25) * bboxScale,
    z: 0,
  };

  // Landmark 18 (Pinky PIP) & Landmark 20 (Pinky tip)
  lm[18] = { x: 30 * bboxScale, y: 0, z: 0 };
  lm[20] = {
    x: (pinkyExtended ? 45 : 25) * bboxScale,
    y: 0,
    z: 0,
  };

  return lm;
}
