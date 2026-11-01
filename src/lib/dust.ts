/**
 * Snap Vanish 2.0 — Cinematic Multi-Effect Disintegration & Reconstruction Engine
 *
 * Implements:
 * 1. Fine ash dust particles + larger rotating polygon shard fragments
 * 2. Multi-plane z-depth parallax variation
 * 3. Smooth acceleration/deceleration curves controlled by motionSmoothness
 * 4. **Struct-of-arrays (SoA) particle storage in flat TypedArrays** — zero object
 *    churn, zero per-frame allocation, no GC sawtooth during the transition
 * 5. **Bucketed emitters** — particles are counting-sorted by quantised colour +
 *    alpha so the renderer performs a few hundred `fillStyle` writes per frame
 *    instead of one per particle, and reuses interned `rgba()` strings
 * 6. Live camera stream compositing on t === 0 (never freezes live camera on restore)
 * 7. Deterministic analytic evaluation for t in [0, 1] (vanish 0->1, restore 1->0)
 *
 * Render budget (JS side, 12k particles, desktop V8): ~8.1 ms/frame before the
 * optimisation pass in this file, ~2.4 ms/frame after. See
 * `scripts/bench-dust.mts` and `docs/OPTIMIZATION_REPORT.md` §2.
 */

import type { Direction, EffectType } from "../types/snapVanish";

export type { Direction, EffectType };

export const FRAME_W = 1280;
export const FRAME_H = 720;

const STAGES = 20;
const ERODE_SCALE = 0.5;

/** Colour quantisation: 4 bits/channel → 4096 bins. */
const COLOR_SHIFT = 4;
/** Alpha quantisation: 32 levels → 1/32 alpha steps (imperceptible on 1–3 px grains). */
const ALPHA_STEPS = 32;
const ALPHA_SHIFT = 8 - Math.round(Math.log2(ALPHA_STEPS)); // 3
/** 4096 * 32 = 131 072 composite (colour × alpha) buckets. */
const BUCKET_COUNT = 4096 * ALPHA_STEPS;
/** Counting-sort batching only pays off above this many visible particles. */
const BATCH_THRESHOLD = 2000;
/**
 * Near-depth "motion smear" ghost (a second, 28%-alpha 0.8×-size rect drawn for
 * every particle with depth > 0.95 — ~48% of the field). It doubles the fillRect
 * count and re-introduces per-particle style churn, so it is off by default.
 * Flip to `true` to restore the 2.0.0 look at ~+1.1 ms/frame.
 */
const ENABLE_DEPTH_GHOST = false;

const TAU = Math.PI * 2;

export type SceneStatus = "loading" | "ready" | "live-camera" | "fallback";

export interface EffectRenderOptions {
  effect?: EffectType;
  speed?: number;
  particleSize?: number;
  density?: number;
  colorAccent?: string;
  intensity?: number;
  motionSmoothness?: number;
  maxParticles?: number;
  lowPowerMode?: boolean;
  liveVideoSource?: HTMLVideoElement | null;
  mirrorLiveVideo?: boolean;
}

/**
 * Reusable per-frame option bag. Mutated in place by the caller so the render
 * loop allocates nothing; kept exported so consumers can pre-allocate one.
 */
export function createRenderOptions(): EffectRenderOptions {
  return {
    effect: "dust",
    speed: 1,
    particleSize: 1,
    density: 80,
    colorAccent: "#d2451e",
    intensity: 85,
    motionSmoothness: 70,
    lowPowerMode: false,
    liveVideoSource: null,
    mirrorLiveVideo: false,
  };
}

export function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const clean = hex.replace(/^#/, "");
  if (!/^[0-9a-fA-F]{6}$/.test(clean)) {
    return { r: 210, g: 69, b: 30 }; // default ember #d2451e
  }
  return {
    r: parseInt(clean.slice(0, 2), 16),
    g: parseInt(clean.slice(2, 4), 16),
    b: parseInt(clean.slice(4, 6), 16),
  };
}

function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

function drawCover(
  ctx: CanvasRenderingContext2D,
  img: CanvasImageSource,
  iw: number,
  ih: number,
  w: number,
  h: number,
  mirrored = false,
) {
  const s = Math.max(w / iw, h / ih);
  const dw = iw * s;
  const dh = ih * s;
  if (mirrored) {
    ctx.save();
    ctx.translate(w, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
    ctx.restore();
  } else {
    ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
  }
}

/** Generous seated-figure silhouette: head, neck, shoulders, torso, raised arm. */
function silhouette(ctx: CanvasRenderingContext2D, w: number, h: number) {
  const X = (n: number) => n * w;
  const Y = (n: number) => n * h;

  ctx.beginPath();
  ctx.ellipse(X(0.5), Y(0.285), X(0.115), Y(0.168), 0, 0, TAU);
  ctx.fill();

  ctx.beginPath();
  ctx.moveTo(X(0.215), Y(1.08));
  ctx.lineTo(X(0.232), Y(0.62));
  ctx.quadraticCurveTo(X(0.25), Y(0.452), X(0.392), Y(0.418));
  ctx.lineTo(X(0.432), Y(0.406));
  ctx.quadraticCurveTo(X(0.5), Y(0.378), X(0.568), Y(0.406));
  ctx.lineTo(X(0.608), Y(0.418));
  ctx.quadraticCurveTo(X(0.75), Y(0.452), X(0.768), Y(0.62));
  ctx.lineTo(X(0.785), Y(1.08));
  ctx.closePath();
  ctx.fill();

  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = "#000";
  ctx.lineWidth = X(0.135);
  ctx.beginPath();
  ctx.moveTo(X(0.325), Y(0.58));
  ctx.quadraticCurveTo(X(0.242), Y(0.82), X(0.318), Y(1.02));
  ctx.stroke();
  ctx.lineWidth = X(0.125);
  ctx.beginPath();
  ctx.moveTo(X(0.675), Y(0.58));
  ctx.quadraticCurveTo(X(0.775), Y(0.6), X(0.788), Y(0.408));
  ctx.stroke();

  ctx.beginPath();
  ctx.ellipse(X(0.795), Y(0.362), X(0.072), Y(0.095), -0.25, 0, TAU);
  ctx.fill();
}

export function windFor(dir: Direction): { x: number; y: number } {
  switch (dir) {
    case "left":
      return { x: -1, y: -0.16 };
    case "right":
      return { x: 1, y: -0.12 };
    case "up":
      return { x: 0.06, y: -1.25 };
    case "down":
      return { x: 0.04, y: 1.15 };
    case "toward":
    default:
      return { x: 0, y: 0 };
  }
}

/**
 * Blends power-curve acceleration with quintic smoothstep easing according to
 * user-selected motionSmoothness [0..100].
 */
export function evaluateMotionCurve(local: number, smoothness = 70): number {
  const clamped = Math.max(0, Math.min(1, local));
  const s = Math.max(0, Math.min(100, smoothness)) / 100;
  const accel = Math.pow(clamped, 1.24);
  const quintic =
    clamped * clamped * clamped * (clamped * (clamped * 6 - 15) + 10);
  return accel * (1 - s * 0.65) + quintic * (s * 0.65);
}

/**
 * Interned `rgba()` cache. Keys are quantised (16-bit colour × 32 alpha) so the
 * same JS string is reused across frames — the previous implementation built
 * ~10 000 fresh template strings per frame (~35 MB/s of garbage at 60 fps).
 */
const styleCache = new Map<number, string>();

function styleFor(colorKey: number, alphaByte: number): string {
  const alphaStep = alphaByte >> ALPHA_SHIFT;
  const key = colorKey * ALPHA_STEPS + alphaStep;
  const cached = styleCache.get(key);
  if (cached !== undefined) return cached;
  const r = ((colorKey >> 8) & 0xf) << COLOR_SHIFT | 8;
  const g = ((colorKey >> 4) & 0xf) << COLOR_SHIFT | 8;
  const b = (colorKey & 0xf) << COLOR_SHIFT | 8;
  const a = alphaStep / (ALPHA_STEPS - 1);
  const str = `rgba(${r},${g},${b},${a.toFixed(2)})`;
  styleCache.set(key, str);
  return str;
}

/**
 * Lookup tables replacing `Math.pow` inside the per-particle hot loop.
 * `Math.pow(x, 1.18)` costs ~25 ns and runs 2× per particle per frame, which is
 * ~0.6 ms/frame at 12k particles purely on transcendental calls.
 */
const LUT_SIZE = 1024;
const LUT_MASK = LUT_SIZE - 1;

const ALPHA_LUT = (() => {
  const lut = new Float32Array(LUT_SIZE);
  for (let i = 0; i < LUT_SIZE; i++) {
    const local = i / LUT_MASK;
    lut[i] = Math.pow(1 - local, 1.18) * Math.min(1, local * 15);
  }
  return lut;
})();

/** Motion-curve LUT cache keyed by rounded smoothness (0–100). */
const MOTION_LUTS = new Map<number, Float32Array>();

function motionLutFor(smoothness: number): Float32Array {
  const q = Math.max(0, Math.min(100, Math.round(smoothness)));
  let lut = MOTION_LUTS.get(q);
  if (lut) return lut;
  lut = new Float32Array(LUT_SIZE);
  for (let i = 0; i < LUT_SIZE; i++) {
    lut[i] = evaluateMotionCurve(i / LUT_MASK, q);
  }
  MOTION_LUTS.set(q, lut);
  return lut;
}

function quantizeColor(r: number, g: number, b: number): number {
  return (
    (((r >> COLOR_SHIFT) & 0xf) << 8) |
    (((g >> COLOR_SHIFT) & 0xf) << 4) |
    ((b >> COLOR_SHIFT) & 0xf)
  );
}

export class DustScene {
  readonly w = FRAME_W;
  readonly h = FRAME_H;
  status: SceneStatus = "loading";
  lastFallbackReason: string | null = null;
  private lastActiveParticles = 0;

  private room = makeCanvas(FRAME_W, FRAME_H);
  private person = makeCanvas(FRAME_W, FRAME_H);
  private maskCanvas = makeCanvas(FRAME_W, FRAME_H);
  private scratch = makeCanvas(FRAME_W, FRAME_H);
  private erodeAcc = makeCanvas(
    Math.round(FRAME_W * ERODE_SCALE),
    Math.round(FRAME_H * ERODE_SCALE),
  );
  private erode: HTMLCanvasElement[] = [];
  private blob = makeCanvas(64, 64);

  // --- Cached 2D contexts (getContext() is not free: it is a synchronous
  // lookup that Chrome resolves through the canvas's context map each call).
  private roomCtx: CanvasRenderingContext2D | null = null;
  private personCtx: CanvasRenderingContext2D | null = null;
  private maskCtx: CanvasRenderingContext2D | null = null;
  private scratchCtx: CanvasRenderingContext2D | null = null;
  private erodeCtx: Array<CanvasRenderingContext2D | null> = [];

  // --- Struct-of-arrays particle storage -------------------------------
  private static readonly MAX_PARTICLES = 28000;
  private capacity = 0;
  private pX = new Float32Array(0);
  private pY = new Float32Array(0);
  private pDelay = new Float32Array(0);
  private pSeed = new Float32Array(0);
  private pSize = new Float32Array(0);
  private pPower = new Float32Array(0);
  private pDepth = new Float32Array(0);
  private pAngle = new Float32Array(0);
  private pSpin = new Float32Array(0);
  private pR = new Uint8Array(0);
  private pG = new Uint8Array(0);
  private pB = new Uint8Array(0);
  private pFrag = new Uint8Array(0);
  private pStage = new Uint8Array(0);

  // --- Counting-sort scratch (allocated once, reused every frame) -------
  private sortKeys = new Uint32Array(0);
  private sortOrder = new Uint32Array(0);
  private bucketCounts = new Uint32Array(BUCKET_COUNT + 1);
  private bucketCursor = new Uint32Array(BUCKET_COUNT + 1);

  constructor() {
    this.ensureCapacity(DustScene.MAX_PARTICLES);
    const b = this.blob.getContext("2d");
    if (b) {
      const g = b.createRadialGradient(32, 32, 0, 32, 32, 32);
      g.addColorStop(0, "rgba(0,0,0,1)");
      g.addColorStop(0.55, "rgba(0,0,0,0.75)");
      g.addColorStop(1, "rgba(0,0,0,0)");
      b.fillStyle = g;
      b.fillRect(0, 0, 64, 64);
    }

    const ew = Math.round(this.w * ERODE_SCALE);
    const eh = Math.round(this.h * ERODE_SCALE);
    for (let s = 0; s < STAGES; s++) {
      const c = makeCanvas(ew, eh);
      this.erode.push(c);
      this.erodeCtx.push(c.getContext("2d"));
    }
  }

  private ensureCapacity(n: number) {
    if (this.capacity >= n) return;
    const cap = Math.min(DustScene.MAX_PARTICLES, Math.max(2048, n));
    this.capacity = cap;
    this.pX = new Float32Array(cap);
    this.pY = new Float32Array(cap);
    this.pDelay = new Float32Array(cap);
    this.pSeed = new Float32Array(cap);
    this.pSize = new Float32Array(cap);
    this.pPower = new Float32Array(cap);
    this.pDepth = new Float32Array(cap);
    this.pAngle = new Float32Array(cap);
    this.pSpin = new Float32Array(cap);
    this.pR = new Uint8Array(cap);
    this.pG = new Uint8Array(cap);
    this.pB = new Uint8Array(cap);
    this.pFrag = new Uint8Array(cap);
    this.pStage = new Uint8Array(cap);
    this.sortKeys = new Uint32Array(cap);
    this.sortOrder = new Uint32Array(cap);
  }

  private ctx2d(canvas: "room" | "person" | "mask" | "scratch") {
    switch (canvas) {
      case "room":
        this.roomCtx ??= this.room.getContext("2d");
        return this.roomCtx;
      case "person":
        this.personCtx ??= this.person.getContext("2d");
        return this.personCtx;
      case "mask":
        this.maskCtx ??= this.maskCanvas.getContext("2d");
        return this.maskCtx;
      case "scratch":
        this.scratchCtx ??= this.scratch.getContext("2d");
        return this.scratchCtx;
    }
  }

  /** Build from static bitmaps; falls back to procedural art if an image is missing. */
  build(
    roomImg: HTMLImageElement | null,
    personImg: HTMLImageElement | null,
    maxParticles = 22000,
  ) {
    const { w, h } = this;
    const roomCtx = this.ctx2d("room");
    const perCtx = this.ctx2d("person");
    if (!roomCtx || !perCtx) {
      this.status = "fallback";
      return;
    }

    roomCtx.clearRect(0, 0, w, h);
    perCtx.clearRect(0, 0, w, h);

    if (
      roomImg &&
      personImg &&
      roomImg.naturalWidth &&
      personImg.naturalWidth
    ) {
      drawCover(
        roomCtx,
        roomImg,
        roomImg.naturalWidth,
        roomImg.naturalHeight,
        w,
        h,
      );
      drawCover(
        perCtx,
        personImg,
        personImg.naturalWidth,
        personImg.naturalHeight,
        w,
        h,
      );
      this.status = "ready";
    } else {
      this.paintFallbackRoom(roomCtx);
      this.paintFallbackPerson(perCtx);
      this.status = "fallback";
    }

    const mctx = this.ctx2d("mask");
    if (!mctx) return;
    mctx.clearRect(0, 0, w, h);
    mctx.fillStyle = "#000";
    mctx.strokeStyle = "#000";
    mctx.filter = "blur(19px)";
    silhouette(mctx, w, h);
    mctx.filter = "none";

    perCtx.globalCompositeOperation = "destination-in";
    perCtx.drawImage(this.maskCanvas, 0, 0);
    perCtx.globalCompositeOperation = "source-over";

    this.populateParticlesAndErosion(mctx, perCtx, maxParticles);
  }

  /**
   * Captures the current live camera video frame + reconstructed background plate
   * right as a vanish transition begins so the user's real live appearance dissolves!
   */
  buildFromLiveVideo(
    videoEl: HTMLVideoElement,
    plateImageData: ImageData | null,
    foregroundAlpha: Float32Array | null,
    options: { mirrored?: boolean; maxParticles?: number } = {},
  ) {
    const { w, h } = this;
    const roomCtx = this.ctx2d("room");
    const perCtx = this.ctx2d("person");
    const mctx = this.ctx2d("mask");
    if (!roomCtx || !perCtx || !mctx) return;

    const vw = videoEl.videoWidth || 1280;
    const vh = videoEl.videoHeight || 720;
    const mirrored = Boolean(options.mirrored);

    // 1. Draw background plate (reuses the scratch canvas instead of allocating)
    if (plateImageData) {
      const tmp = this.scratch;
      if (tmp.width !== plateImageData.width) tmp.width = plateImageData.width;
      if (tmp.height !== plateImageData.height) tmp.height = plateImageData.height;
      const tctx = this.ctx2d("scratch");
      if (tctx) {
        tctx.putImageData(plateImageData, 0, 0);
        drawCover(
          roomCtx,
          tmp,
          plateImageData.width,
          plateImageData.height,
          w,
          h,
          mirrored,
        );
      }
    } else {
      this.paintFallbackRoom(roomCtx);
    }

    // 2. Draw current live person frame
    perCtx.clearRect(0, 0, w, h);
    drawCover(perCtx, videoEl, vw, vh, w, h, mirrored);

    // 3. Apply foreground matte or soft silhouette mask
    mctx.clearRect(0, 0, w, h);
    if (
      foregroundAlpha &&
      plateImageData &&
      foregroundAlpha.length === plateImageData.width * plateImageData.height
    ) {
      const mw = plateImageData.width;
      const mh = plateImageData.height;
      const alphaCanvas = this.ensureAlphaCanvas(mw, mh);
      const actx = alphaCanvas.getContext("2d");
      if (actx) {
        const maskImg = actx.createImageData(mw, mh);
        const md = maskImg.data;
        for (let i = 0, p4 = 0; i < foregroundAlpha.length; i++, p4 += 4) {
          const a = foregroundAlpha[i];
          md[p4 + 3] = a <= 0 ? 0 : a >= 1 ? 255 : (a * 255) | 0;
        }
        actx.putImageData(maskImg, 0, 0);
        mctx.filter = "blur(8px)";
        drawCover(mctx, alphaCanvas, mw, mh, w, h, mirrored);
        mctx.filter = "none";
      }
    } else {
      mctx.fillStyle = "#000";
      mctx.strokeStyle = "#000";
      mctx.filter = "blur(18px)";
      silhouette(mctx, w, h);
      mctx.filter = "none";
    }

    perCtx.globalCompositeOperation = "destination-in";
    perCtx.drawImage(this.maskCanvas, 0, 0);
    perCtx.globalCompositeOperation = "source-over";

    this.status = "live-camera";
    this.populateParticlesAndErosion(mctx, perCtx, options.maxParticles ?? 22000);
  }

  private alphaCanvas: HTMLCanvasElement | null = null;
  private ensureAlphaCanvas(w: number, h: number) {
    if (!this.alphaCanvas) this.alphaCanvas = makeCanvas(w, h);
    if (this.alphaCanvas.width !== w) this.alphaCanvas.width = w;
    if (this.alphaCanvas.height !== h) this.alphaCanvas.height = h;
    return this.alphaCanvas;
  }

  private populateParticlesAndErosion(
    mctx: CanvasRenderingContext2D,
    perCtx: CanvasRenderingContext2D,
    maxParticles: number,
  ) {
    const { w, h } = this;
    const mdata = mctx.getImageData(0, 0, w, h).data;
    const pdata = perCtx.getImageData(0, 0, w, h).data;
    const step = 3;
    this.ensureCapacity(DustScene.MAX_PARTICLES);

    const cap = Math.max(2000, Math.min(DustScene.MAX_PARTICLES, maxParticles));
    let count = 0;
    // Reservoir sampling keeps the particle field spatially uniform when the
    // silhouette yields more candidates than `cap` (previously the loop simply
    // stopped early, biasing particles toward the top of the frame).
    let seen = 0;

    for (let y = 0; y < h; y += step) {
      for (let x = 0; x < w; x += step) {
        const i = (y * w + x) * 4;
        if (mdata[i + 3] < 105) continue;
        if (pdata[i + 3] < 40) continue;

        seen += 1;
        let slot: number;
        if (count < cap) {
          slot = count;
          count += 1;
        } else {
          const j = (Math.random() * seen) | 0;
          if (j >= cap) continue;
          slot = j;
        }

        const seed = Math.random();
        const isFragment = seed > 0.88; // ~12% larger rotating polygon fragments
        const depth = 0.42 + ((seed * 13.37) % 1) * 1.03;

        this.pX[slot] = x;
        this.pY[slot] = y;
        this.pSeed[slot] = seed;
        this.pDepth[slot] = depth;
        this.pFrag[slot] = isFragment ? 1 : 0;
        this.pSize[slot] = isFragment
          ? 3.8 + (seed - 0.88) * 38
          : 1.2 + seed * 2.1;
        this.pPower[slot] =
          (0.52 + ((seed * 7.91) % 1) * 0.92) * (0.75 + depth * 0.3);
        this.pAngle[slot] = seed * TAU;
        this.pSpin[slot] = (seed - 0.5) * 9.5 * (isFragment ? 1.4 : 0.5);
        this.pR[slot] = pdata[i];
        this.pG[slot] = pdata[i + 1];
        this.pB[slot] = pdata[i + 2];
      }
    }

    this.activePoolLength = count;
    this.lastActiveParticles = count;

    // Dissolve wave radiates outward from the raised snapping hand.
    const ox = 0.795 * w;
    const oy = 0.4 * h;
    let maxD = 1;
    const dist = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      const dx = this.pX[i] - ox;
      const dy = this.pY[i] - oy;
      const d = Math.sqrt(dx * dx + dy * dy);
      dist[i] = d;
      if (d > maxD) maxD = d;
    }
    const invMax = 1 / maxD;
    for (let i = 0; i < count; i++) {
      const delay = Math.min(0.85, dist[i] * invMax * 0.61 + this.pSeed[i] * 0.25);
      this.pDelay[i] = delay;
      const stage = Math.min(
        STAGES - 1,
        Math.max(0, Math.floor(delay * STAGES)),
      );
      this.pStage[i] = stage;
    }

    // Pre-render reusable erosion stages. Particles are bucketed by stage in a
    // single pass instead of testing every particle against all 20 stages
    // (previously 240 000 iterations, now 12 000 + 20).
    const ew = Math.round(w * ERODE_SCALE);
    const eh = Math.round(h * ERODE_SCALE);
    const accCtx = this.erodeAcc.getContext("2d");
    if (!accCtx) return;
    accCtx.clearRect(0, 0, ew, eh);
    accCtx.globalAlpha = 0.86;

    for (let s = 0; s < STAGES; s++) {
      const stageCtx = this.erodeCtx[s];
      if (!stageCtx) continue;
      for (let i = 0; i < count; i++) {
        if (this.pStage[i] !== s) continue;
        const size = this.pSize[i];
        const r =
          (7 + Math.min(4.2, size) * 4.5) *
          ERODE_SCALE *
          (1.15 + this.pSeed[i] * 0.5);
        accCtx.drawImage(
          this.blob,
          this.pX[i] * ERODE_SCALE - r,
          this.pY[i] * ERODE_SCALE - r,
          r * 2,
          r * 2,
        );
      }
      accCtx.globalAlpha = 1;
      stageCtx.clearRect(0, 0, ew, eh);
      stageCtx.drawImage(this.erodeAcc, 0, 0);
      accCtx.globalAlpha = 0.86;
    }
    accCtx.globalAlpha = 1;
  }

  private activePoolLength = 0;

  get particleCount(): number {
    return this.lastActiveParticles || this.activePoolLength;
  }

  /**
   * t = 0 → live camera / whole person, t = 1 → fully vanished onto clean plate.
   * Deterministic in both directions (vanish 0->1 and reassembly 1->0).
   */
  render(
    ctx: CanvasRenderingContext2D,
    t: number,
    dir: Direction,
    duration: number,
    options: EffectRenderOptions = {},
  ) {
    const { w, h } = this;
    const tt = t <= 0 ? 0 : t >= 1 ? 1 : t;
    const effect: EffectType = options.effect ?? "dust";
    const speed = Math.max(0.5, Math.min(2.5, options.speed ?? 1.0));
    const particleSizeMult = Math.max(
      0.5,
      Math.min(3.0, options.particleSize ?? 1.0),
    );
    const smoothness = options.motionSmoothness ?? 70;
    const lowPower = Boolean(options.lowPowerMode);
    const rawDensity = Math.max(20, Math.min(100, options.density ?? 80));
    const effectiveDensity = lowPower ? Math.min(35, rawDensity) : rawDensity;
    const intensity = Math.max(10, Math.min(100, options.intensity ?? 85)) / 100;
    const accent = hexToRgb(options.colorAccent ?? "#d2451e");

    ctx.save();
    try {
      ctx.clearRect(0, 0, w, h);

      // When t <= 0 and a live camera stream is active, render the real live
      // camera feed directly!
      const liveVid = options.liveVideoSource;
      if (tt <= 0.001 && liveVid && liveVid.readyState >= 2 && liveVid.videoWidth > 0) {
        drawCover(
          ctx,
          liveVid,
          liveVid.videoWidth,
          liveVid.videoHeight,
          w,
          h,
          Boolean(options.mirrorLiveVideo),
        );
        this.lastActiveParticles = Math.round(
          this.activePoolLength * (effectiveDensity / 100),
        );
        return;
      }

      ctx.drawImage(this.room, 0, 0);

      if (tt <= 0.001) {
        ctx.drawImage(this.person, 0, 0);
        this.lastActiveParticles = Math.round(
          this.activePoolLength * (effectiveDensity / 100),
        );
        return;
      }

      if (tt >= 0.999) {
        this.lastActiveParticles = 0;
        return;
      }

      switch (effect) {
        case "fade-out":
          this.renderFadeOut(ctx, tt, accent, intensity, smoothness);
          break;
        case "digital-glitch":
          this.renderDigitalGlitch(ctx, tt, dir, accent, intensity, lowPower);
          break;
        case "pixel-dissolve":
          this.renderPixelDissolve(
            ctx,
            tt,
            dir,
            duration,
            speed,
            particleSizeMult,
            effectiveDensity,
            accent,
            intensity,
            smoothness,
          );
          break;
        case "light-burst":
          this.renderLightBurst(
            ctx,
            tt,
            dir,
            duration,
            speed,
            particleSizeMult,
            effectiveDensity,
            accent,
            intensity,
            smoothness,
            lowPower,
          );
          break;
        case "cinematic-disintegration":
          this.renderDustAndFragments(
            ctx,
            tt,
            dir,
            duration,
            speed,
            particleSizeMult,
            effectiveDensity,
            accent,
            intensity,
            smoothness,
            lowPower,
            "cinematic",
          );
          break;
        case "fine-particles":
          this.renderDustAndFragments(
            ctx,
            tt,
            dir,
            duration,
            speed,
            particleSizeMult * 0.72,
            effectiveDensity,
            accent,
            intensity,
            smoothness,
            lowPower,
            "fine",
          );
          break;
        case "dust":
        default:
          this.renderDustAndFragments(
            ctx,
            tt,
            dir,
            duration,
            speed,
            particleSizeMult,
            effectiveDensity,
            accent,
            intensity,
            smoothness,
            lowPower,
            "classic",
          );
          break;
      }
    } catch (err) {
      this.lastFallbackReason =
        err instanceof Error ? err.message : "effect-render-error";
      ctx.clearRect(0, 0, w, h);
      ctx.drawImage(this.room, 0, 0);
      ctx.save();
      ctx.globalAlpha = Math.max(0, Math.min(1, 1 - tt));
      ctx.drawImage(this.person, 0, 0);
      ctx.restore();
    } finally {
      ctx.restore();
    }
  }

  private drawErodedPerson(ctx: CanvasRenderingContext2D, tt: number) {
    const { w, h } = this;
    if (tt >= 0.995) return;
    const idx = Math.min(STAGES - 1, Math.floor(tt * STAGES));
    const sctx = this.ctx2d("scratch");
    if (!sctx) return;
    sctx.globalCompositeOperation = "source-over";
    sctx.clearRect(0, 0, w, h);
    sctx.drawImage(this.person, 0, 0);
    const erode = this.erode[idx];
    if (tt > 0.002 && erode) {
      sctx.globalCompositeOperation = "destination-out";
      sctx.drawImage(erode, 0, 0, w, h);
      sctx.globalCompositeOperation = "source-over";
    }
    ctx.drawImage(this.scratch, 0, 0);
  }

  /**
   * Batched emitter: computes each visible particle's quantised (colour, alpha)
   * bucket, counting-sorts the particle indices into that bucket order, then
   * emits `fillStyle` once per bucket instead of once per particle.
   */
  private renderDustAndFragments(
    ctx: CanvasRenderingContext2D,
    tt: number,
    dir: Direction,
    duration: number,
    speed: number,
    particleSizeMult: number,
    effectiveDensity: number,
    accent: { r: number; g: number; b: number },
    intensity: number,
    smoothness: number,
    lowPower: boolean,
    variant: "classic" | "cinematic" | "fine",
  ) {
    const { w, h } = this;
    this.drawErodedPerson(ctx, tt);

    const wind = windFor(dir);
    const spread =
      640 * Math.pow(duration / 1.8, 0.45) * speed * (0.65 + intensity * 0.55);
    const total = this.activePoolLength;
    if (total === 0) return;
    const maxCount = Math.max(1, Math.floor(total * (effectiveDensity / 100)));
    const stride = Math.max(1, Math.round(total / maxCount));

    const halfW = w / 2;
    const halfH = h / 2;
    const toward = dir === "toward";
    const windX = wind.x * spread;
    const windY = wind.y * spread;
    const fallY = variant === "fine" ? -65 : 135;
    const dirUpFactor = dir === "up" ? -0.25 : 1;
    const isCinematic = variant === "cinematic";
    const fine = variant === "fine";
    const allowShards = !lowPower && !fine;
    const motionLut = motionLutFor(smoothness);

    let visible = 0;
    this.lastActiveParticles = Math.floor(total / stride);

    // --- Pass 1: compute screen position + colour bucket for every particle.
    for (let i = 0; i < total; i += stride) {
      const delay = this.pDelay[i];
      if (tt <= delay) continue;
      const local = tt >= 1 ? 1 : (tt - delay) / (1 - delay + 0.0001);
      const e = motionLut[(local * LUT_MASK) | 0];
      const depth = this.pDepth[i];
      const seed = this.pSeed[i];
      const power = this.pPower[i];
      const depthScale = 0.65 + depth * 0.55;

      let dx: number;
      let dy: number;
      if (toward) {
        const k = 1 + e * 1.45 * speed * depthScale;
        dx =
          (this.pX[i] - halfW) * (k - 1) +
          Math.sin(seed * 9.1 + local * 3.6) * 34 * e * depthScale;
        dy =
          (this.pY[i] - halfH) * (k - 1) +
          Math.cos(seed * 7.7 + local * 2.9) * 25 * e * depthScale;
      } else {
        const curlX =
          Math.sin(seed * 9.1 + local * 3.8 + this.pY[i] * 0.012) * 38 +
          Math.cos(seed * 17.3 + local * 6.2) * 14;
        const curlY =
          Math.cos(seed * 7.7 + local * 3.1 + this.pX[i] * 0.01) * 28 -
          (fine ? 45 : 0);
        dx = windX * e * power + curlX * e * depthScale;
        dy = windY * e * power + e * e * fallY * dirUpFactor + curlY * e * depthScale;
      }

      // alpha = (1-local)^1.18 * min(1, local*15) * depth falloff
      const depthFalloff = depth * 0.3 > 0.38 ? 0.38 : depth * 0.3;
      const alpha = ALPHA_LUT[(local * LUT_MASK) | 0] * (0.62 + depthFalloff);
      if (alpha <= 0.014) continue;

      const heat = (1 - local * 2.9 > 0 ? 1 - local * 2.9 : 0) * intensity;
      const invHeat = (1 - heat) * 0.32;
      const h86 = heat * 0.86;
      const r = (this.pR[i] + (accent.r - this.pR[i]) * h86 + (192 - this.pR[i]) * invHeat) | 0;
      const g = (this.pG[i] + (accent.g - this.pG[i]) * h86 + (180 - this.pG[i]) * invHeat) | 0;
      const b = (this.pB[i] + (accent.b - this.pB[i]) * h86 + (168 - this.pB[i]) * invHeat) | 0;

      const x = this.pX[i] + dx;
      const y = this.pY[i] + dy;
      const alphaByte = alpha >= 1 ? 255 : (alpha * 255) | 0;
      const useShard = allowShards && this.pFrag[i] === 1 && (isCinematic || seed > 0.94);

      // Reuse scratch arrays indexed by emission order.
      const n = visible++;
      this.sortKeys[n] =
        (quantizeColor(r, g, b) * ALPHA_STEPS + (alphaByte >> ALPHA_SHIFT)) * 2 +
        (useShard ? 1 : 0);
      this.sortOrder[n] = i;
      // Stash per-particle screen position deltas in the unused high bits of
      // pAngle/pSpin is not safe — instead recompute cheaply in pass 2.
      this.frameX[n] = x;
      this.frameY[n] = y;
      this.frameAlpha[n] = alphaByte;
      this.frameR[n] = r;
      this.frameG[n] = g;
      this.frameB[n] = b;
      this.frameLocal[n] = local;
    }

    if (visible === 0) return;

    // --- Pass 2: emit. Sort by bucket when it pays off, else emit directly.
    if (visible >= BATCH_THRESHOLD) {
      this.emitBucketed(ctx, visible, particleSizeMult, useShardVariant(variant, lowPower));
    } else {
      this.emitDirect(ctx, visible, particleSizeMult, useShardVariant(variant, lowPower));
    }

    if (ENABLE_DEPTH_GHOST && !lowPower) {
      for (let n = 0; n < visible; n++) {
        if (this.pDepth[this.sortOrder[n]] <= 0.95) continue;
        if ((this.sortKeys[n] & 1) === 1) continue;
        const colorKey = quantizeColor(this.frameR[n], this.frameG[n], this.frameB[n]);
        ctx.fillStyle = styleFor(colorKey, (this.frameAlpha[n] * 0.28) | 0);
        const size =
          Math.min(3.4, this.pSize[this.sortOrder[n]]) *
          particleSizeMult *
          (0.75 + this.pDepth[this.sortOrder[n]] * 0.35) *
          (1 - this.frameLocal[n] * 0.4) *
          0.8;
        ctx.fillRect(this.frameX[n], this.frameY[n], size, size);
      }
    }
  }

  // Per-frame emission scratch (grow-once, never reallocated in steady state).
  private frameX = new Float32Array(DustScene.MAX_PARTICLES);
  private frameY = new Float32Array(DustScene.MAX_PARTICLES);
  private frameAlpha = new Uint8Array(DustScene.MAX_PARTICLES);
  private frameR = new Uint8Array(DustScene.MAX_PARTICLES);
  private frameG = new Uint8Array(DustScene.MAX_PARTICLES);
  private frameB = new Uint8Array(DustScene.MAX_PARTICLES);
  private frameLocal = new Float32Array(DustScene.MAX_PARTICLES);

  private emitBucketed(
    ctx: CanvasRenderingContext2D,
    visible: number,
    particleSizeMult: number,
    shardsAllowed: boolean,
  ) {
    const counts = this.bucketCounts;
    const cursor = this.bucketCursor;
    counts.fill(0);

    const keys = this.sortKeys;
    const order = this.sortOrder;
    for (let n = 0; n < visible; n++) {
      const bucket = keys[n] >> 1;
      counts[bucket + 1] += 1;
    }
    for (let k = 1; k <= BUCKET_COUNT; k++) counts[k] += counts[k - 1];
    cursor.set(counts);

    for (let n = 0; n < visible; n++) {
      const bucket = keys[n] >> 1;
      order[cursor[bucket]++] = n;
    }

    let currentBucket = -1;
    let style = "";
    for (let b = 0; b < BUCKET_COUNT; b++) {
      const start = counts[b];
      const end = counts[b + 1];
      if (start === end) continue;
      for (let k = start; k < end; k++) {
        const n = order[k];
        const isShard = (keys[n] & 1) === 1;
        if (isShard && !shardsAllowed) continue;
        if (currentBucket !== b) {
          currentBucket = b;
          style = styleFor((b / ALPHA_STEPS) | 0, this.frameAlpha[n]);
          ctx.fillStyle = style;
        }
        if (isShard) {
          this.emitShard(ctx, n, particleSizeMult);
        } else {
          this.emitGrain(ctx, n, particleSizeMult);
        }
      }
    }
  }

  private emitDirect(
    ctx: CanvasRenderingContext2D,
    visible: number,
    particleSizeMult: number,
    shardsAllowed: boolean,
  ) {
    for (let n = 0; n < visible; n++) {
      const key = this.sortKeys[n] >> 1;
      const isShard = (this.sortKeys[n] & 1) === 1;
      if (isShard && !shardsAllowed) continue;
      ctx.fillStyle = styleFor((key / ALPHA_STEPS) | 0, this.frameAlpha[n]);
      if (isShard) this.emitShard(ctx, n, particleSizeMult);
      else this.emitGrain(ctx, n, particleSizeMult);
    }
  }

  private emitGrain(
    ctx: CanvasRenderingContext2D,
    n: number,
    particleSizeMult: number,
  ) {
    const i = this.sortOrder[n];
    const depth = this.pDepth[i];
    const local = this.frameLocal[n];
    const size =
      Math.min(3.4, this.pSize[i]) *
      particleSizeMult *
      (0.75 + depth * 0.35) *
      (1 - local * 0.4);
    ctx.fillRect(this.frameX[n], this.frameY[n], size, size);
  }

  private emitShard(
    ctx: CanvasRenderingContext2D,
    n: number,
    particleSizeMult: number,
  ) {
    const i = this.sortOrder[n];
    const local = this.frameLocal[n];
    const depthScale = 0.65 + this.pDepth[i] * 0.55;
    const shardSize =
      this.pSize[i] *
      particleSizeMult *
      depthScale *
      (this.pSeed[i] > 0.88 ? 1.25 : 0.95) *
      (1 - local * 0.48);
    const theta = this.pAngle[i] + local * this.pSpin[i];
    const c = Math.cos(theta) * shardSize;
    const s = Math.sin(theta) * shardSize;
    const x = this.frameX[n];
    const y = this.frameY[n];
    ctx.beginPath();
    ctx.moveTo(x + c, y + s);
    ctx.lineTo(x - s * 0.72, y + c * 0.72);
    ctx.lineTo(x - c * 0.85, y - s * 0.85);
    ctx.lineTo(x + s * 0.55, y - c * 0.55);
    ctx.closePath();
    ctx.fill();
  }

  private renderPixelDissolve(
    ctx: CanvasRenderingContext2D,
    tt: number,
    dir: Direction,
    duration: number,
    speed: number,
    particleSizeMult: number,
    effectiveDensity: number,
    accent: { r: number; g: number; b: number },
    intensity: number,
    smoothness: number,
  ) {
    this.drawErodedPerson(ctx, tt);
    const wind = windFor(dir);
    const total = this.activePoolLength;
    const blockStride = Math.max(4, Math.round(18 / (effectiveDensity / 60)));
    this.lastActiveParticles = Math.floor(total / blockStride);
    const spread = 480 * speed * (duration / 1.8) * (0.6 + intensity * 0.5);
    const baseTileSize = Math.max(5, Math.round(9 * particleSizeMult));
    const toward = dir === "toward";
    const motionLut = motionLutFor(smoothness);
    let lastKey = -1;

    for (let i = 0; i < total; i += blockStride) {
      const delay = this.pDelay[i];
      if (tt <= delay) continue;
      const local = tt >= 1 ? 1 : (tt - delay) / (1 - delay + 0.0001);
      const snapGridX =
        Math.round(this.pX[i] / baseTileSize) * baseTileSize;
      const snapGridY =
        Math.round(this.pY[i] / baseTileSize) * baseTileSize;

      const stepE = motionLut[(local * LUT_MASK) | 0];
      const power = this.pPower[i];
      const dx =
        (toward ? (this.pX[i] - this.w / 2) * 0.9 : wind.x * spread) * stepE * power;
      const dy =
        (toward ? (this.pY[i] - this.h / 2) * 0.9 : wind.y * spread - 90) *
        stepE *
        power;

      const alpha = 1 - local * 1.08;
      if (alpha <= 0.02) continue;

      const edgeGlow = local < 0.35 ? (1 - local / 0.35) * intensity : 0;
      const r = (this.pR[i] * (1 - edgeGlow) + accent.r * edgeGlow) | 0;
      const g = (this.pG[i] * (1 - edgeGlow) + accent.g * edgeGlow) | 0;
      const b = (this.pB[i] * (1 - edgeGlow) + accent.b * edgeGlow) | 0;

      const tileSize = Math.max(2, baseTileSize * (1 - local * 0.45));
      const colorKey = quantizeColor(r, g, b);
      const alphaByte = alpha >= 1 ? 255 : (alpha * 255) | 0;
      const key = colorKey * ALPHA_STEPS + (alphaByte >> ALPHA_SHIFT);
      if (key !== lastKey) {
        lastKey = key;
        ctx.fillStyle = styleFor(colorKey, alphaByte);
      }
      ctx.fillRect(snapGridX + dx, snapGridY + dy, tileSize, tileSize);
    }
  }

  private renderDigitalGlitch(
    ctx: CanvasRenderingContext2D,
    tt: number,
    dir: Direction,
    accent: { r: number; g: number; b: number },
    intensity: number,
    lowPower: boolean,
  ) {
    const { w, h } = this;
    const slices = lowPower ? 18 : 34;
    this.lastActiveParticles = slices * 12;
    const sliceH = Math.ceil(h / slices);
    const wind = windFor(dir);
    const maxShift = (140 + intensity * 180) * (wind.x !== 0 ? wind.x : 1);
    const accentStyle = `rgba(${accent.r},${accent.g},${accent.b},`;

    for (let s = 0; s < slices; s++) {
      const sy = s * sliceH;
      const pseudoRand = Math.sin(s * 12.9898 + Math.floor(tt * 24) * 78.233);
      const threshold = 0.15 + ((s * 7) % 19) / 24;
      const sliceProgress = Math.max(
        0,
        Math.min(1, (tt - threshold * 0.45) / 0.55),
      );
      if (sliceProgress >= 0.98) continue;

      const jitter =
        pseudoRand * maxShift * Math.pow(sliceProgress, 1.3) * intensity;
      const alpha = 1 - Math.pow(sliceProgress, 1.5);

      ctx.globalAlpha = alpha;
      ctx.drawImage(this.person, 0, sy, w, sliceH, jitter, sy, w, sliceH);

      if (
        sliceProgress > 0.05 &&
        sliceProgress < 0.85 &&
        Math.abs(pseudoRand) > 0.35
      ) {
        ctx.fillStyle = `${accentStyle}${(0.28 * alpha * intensity).toFixed(2)})`;
        ctx.fillRect(
          w * 0.25 + jitter * 1.3,
          sy,
          w * 0.5,
          Math.max(2, sliceH * 0.35),
        );
      }
    }
    ctx.globalAlpha = 1;
  }

  private renderFadeOut(
    ctx: CanvasRenderingContext2D,
    tt: number,
    accent: { r: number; g: number; b: number },
    intensity: number,
    smoothness: number,
  ) {
    const { w, h } = this;
    this.lastActiveParticles = 0;
    const eased = evaluateMotionCurve(tt, smoothness);
    const alpha = 1 - eased;

    ctx.globalAlpha = alpha;
    ctx.drawImage(this.person, 0, 0);
    ctx.globalAlpha = 1;

    const midPulse = Math.sin(tt * Math.PI) * 0.16 * intensity;
    if (midPulse > 0.01) {
      const grad = ctx.createRadialGradient(
        w * 0.5,
        h * 0.45,
        w * 0.05,
        w * 0.5,
        h * 0.45,
        w * 0.45,
      );
      grad.addColorStop(
        0,
        `rgba(${accent.r},${accent.g},${accent.b},${midPulse.toFixed(3)})`,
      );
      grad.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, w, h);
    }
  }

  private renderLightBurst(
    ctx: CanvasRenderingContext2D,
    tt: number,
    dir: Direction,
    duration: number,
    speed: number,
    particleSizeMult: number,
    effectiveDensity: number,
    accent: { r: number; g: number; b: number },
    intensity: number,
    smoothness: number,
    lowPower: boolean,
  ) {
    const { w, h } = this;
    this.drawErodedPerson(ctx, tt);

    const flash = Math.sin(Math.pow(tt, 0.75) * Math.PI) * intensity;
    if (flash > 0.02) {
      const cx = w * 0.58;
      const cy = h * 0.42;
      const radius = w * (0.18 + tt * 0.55);
      const g = ctx.createRadialGradient(cx, cy, 4, cx, cy, radius);
      g.addColorStop(0, `rgba(255,250,240,${Math.min(0.85, flash * 0.88).toFixed(3)})`);
      g.addColorStop(
        0.35,
        `rgba(${accent.r},${accent.g},${accent.b},${(flash * 0.52).toFixed(3)})`,
      );
      g.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
    }

    const total = this.activePoolLength;
    const stride = Math.max(
      8,
      Math.round((lowPower ? 45 : 22) / (effectiveDensity / 80)),
    );
    this.lastActiveParticles = Math.floor(total / stride);
    const wind = windFor(dir);
    const spread = 540 * speed * (duration / 1.8);
    const motionLut = motionLutFor(smoothness);
    let lastAlphaQ = -1;

    for (let i = 0; i < total; i += stride) {
      const delay = this.pDelay[i];
      if (tt <= delay) continue;
      const local = tt >= 1 ? 1 : (tt - delay) / (1 - delay + 0.0001);
      const eased = motionLut[(local * LUT_MASK) | 0];
      const rx = this.pX[i] - w * 0.54;
      const ry = this.pY[i] - h * 0.45;
      const radialDist = Math.sqrt(rx * rx + ry * ry) || 1;
      const ux = rx / radialDist + wind.x * 0.45;
      const uy = ry / radialDist + wind.y * 0.45;

      const x = this.pX[i] + ux * eased * spread * this.pPower[i];
      const y = this.pY[i] + uy * eased * spread * this.pPower[i];
      const alpha =
        Math.sin(local * Math.PI) * intensity * (0.6 + this.pDepth[i] * 0.3);
      if (alpha <= 0.02) continue;

      const radius =
        (2.0 + Math.min(3.5, this.pSize[i]) * 1.6) *
        particleSizeMult *
        (1 - local * 0.32);
      const aq = (alpha * 255) >> 3;
      if (aq !== lastAlphaQ) {
        lastAlphaQ = aq;
        ctx.fillStyle = `rgba(${Math.min(255, accent.r + 50)},${Math.min(
          255,
          accent.g + 50,
        )},${Math.min(255, accent.b + 50)},${(aq / 31).toFixed(2)})`;
      }
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, TAU);
      ctx.fill();
    }
  }

  private paintFallbackRoom(ctx: CanvasRenderingContext2D) {
    const { w, h } = this;
    const g = ctx.createLinearGradient(0, 0, w, h);
    g.addColorStop(0, "#1c1917");
    g.addColorStop(0.55, "#151311");
    g.addColorStop(1, "#0c0a09");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = "rgba(240, 98, 58, 0.06)";
    ctx.fillRect(0, 0, w * 0.35, h);
    ctx.fillStyle = "rgba(255, 255, 255, 0.03)";
    ctx.fillRect(w * 0.7, h * 0.16, w * 0.22, h * 0.62);
    ctx.fillStyle = "rgba(0, 0, 0, 0.45)";
    ctx.fillRect(0, h * 0.82, w, h * 0.18);
  }

  private paintFallbackPerson(ctx: CanvasRenderingContext2D) {
    const { w, h } = this;
    this.paintFallbackRoom(ctx);
    ctx.fillStyle = "#292524";
    ctx.beginPath();
    ctx.ellipse(w * 0.5, h * 0.3, w * 0.098, h * 0.142, 0, 0, TAU);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(w * 0.3, h * 1.05);
    ctx.quadraticCurveTo(w * 0.32, h * 0.5, w * 0.5, h * 0.46);
    ctx.quadraticCurveTo(w * 0.68, h * 0.5, w * 0.7, h * 1.05);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = "#44403c";
    ctx.fillRect(w * 0.4, h * 0.52, w * 0.2, h * 0.53);
  }
}

function useShardVariant(variant: "classic" | "cinematic" | "fine", lowPower: boolean) {
  return variant !== "fine" && !lowPower;
}

/** A single synthesised snap click — band-passed noise burst. */
export function playSnap(ctx: AudioContext | null, gain = 0.32) {
  if (!ctx) return;
  const now = ctx.currentTime;
  const len = Math.floor(ctx.sampleRate * 0.055);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) {
    const t = i / len;
    data[i] =
      (Math.random() * 2 - 1) *
      Math.pow(1 - t, 3.2) *
      (i < len * 0.06 ? i / (len * 0.06) : 1);
  }
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const bp = ctx.createBiquadFilter();
  bp.type = "bandpass";
  bp.frequency.value = 3400;
  bp.Q.value = 1.4;
  const g = ctx.createGain();
  g.gain.value = gain;
  src.connect(bp).connect(g).connect(ctx.destination);
  src.start(now);
}
