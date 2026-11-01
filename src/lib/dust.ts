/**
 * Snap Vanish 2.0 — Cinematic Multi-Effect Disintegration & Reconstruction Engine
 *
 * Implements:
 * 1. Fine ash dust particles + larger rotating polygon shard fragments
 * 2. Multi-plane z-depth parallax variation
 * 3. Smooth acceleration/deceleration curves controlled by motionSmoothness
 * 4. Pooled particle objects & pre-allocated stage canvases to avoid GC spikes
 * 5. Live camera stream compositing on t === 0 (never freezes live camera on restore)
 * 6. Deterministic analytic evaluation for t in [0, 1] (vanish 0->1, restore 1->0)
 */

import type { Direction, EffectType } from "../types/snapVanish";

export type { Direction, EffectType };

export const FRAME_W = 1280;
export const FRAME_H = 720;

const STAGES = 20;
const ERODE_SCALE = 0.5;

type Particle = {
  x: number;
  y: number;
  delay: number;
  seed: number;
  size: number;
  power: number;
  depth: number; // 0.4 (far) .. 1.45 (near) parallax depth plane
  angle: number; // initial radians
  spin: number; // rad per unit local progress
  isFragment: boolean; // true = rotating shard fragment, false = fine dust grain
  r: number;
  g: number;
  b: number;
};

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
  ctx.ellipse(X(0.5), Y(0.285), X(0.115), Y(0.168), 0, 0, Math.PI * 2);
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
  ctx.ellipse(X(0.795), Y(0.362), X(0.072), Y(0.095), -0.25, 0, Math.PI * 2);
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
  private particlePool: Particle[] = [];
  private activePoolLength = 0;
  private blob = makeCanvas(64, 64);

  constructor() {
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
      this.erode.push(makeCanvas(ew, eh));
    }
  }

  /** Build from static bitmaps; falls back to procedural art if an image is missing. */
  build(
    roomImg: HTMLImageElement | null,
    personImg: HTMLImageElement | null,
    maxParticles = 22000,
  ) {
    const { w, h } = this;
    const roomCtx = this.room.getContext("2d");
    const perCtx = this.person.getContext("2d");
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

    const mctx = this.maskCanvas.getContext("2d");
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
    const roomCtx = this.room.getContext("2d");
    const perCtx = this.person.getContext("2d");
    const mctx = this.maskCanvas.getContext("2d");
    if (!roomCtx || !perCtx || !mctx) return;

    const vw = videoEl.videoWidth || 1280;
    const vh = videoEl.videoHeight || 720;

    // 1. Draw background plate
    if (plateImageData) {
      const tmp = makeCanvas(plateImageData.width, plateImageData.height);
      tmp.getContext("2d")?.putImageData(plateImageData, 0, 0);
      drawCover(
        roomCtx,
        tmp,
        plateImageData.width,
        plateImageData.height,
        w,
        h,
        Boolean(options.mirrored),
      );
    } else {
      this.paintFallbackRoom(roomCtx);
    }

    // 2. Draw current live person frame
    perCtx.clearRect(0, 0, w, h);
    drawCover(perCtx, videoEl, vw, vh, w, h, Boolean(options.mirrored));

    // 3. Apply foreground matte or soft silhouette mask
    mctx.clearRect(0, 0, w, h);
    if (
      foregroundAlpha &&
      plateImageData &&
      foregroundAlpha.length === plateImageData.width * plateImageData.height
    ) {
      const mw = plateImageData.width;
      const mh = plateImageData.height;
      const alphaCanvas = makeCanvas(mw, mh);
      const actx = alphaCanvas.getContext("2d");
      if (actx) {
        const maskImg = actx.createImageData(mw, mh);
        for (let i = 0; i < foregroundAlpha.length; i++) {
          const p4 = i * 4;
          maskImg.data[p4] = 0;
          maskImg.data[p4 + 1] = 0;
          maskImg.data[p4 + 2] = 0;
          maskImg.data[p4 + 3] = Math.round(
            Math.max(0, Math.min(1, foregroundAlpha[i])) * 255,
          );
        }
        actx.putImageData(maskImg, 0, 0);
        mctx.filter = "blur(8px)";
        drawCover(
          mctx,
          alphaCanvas,
          mw,
          mh,
          w,
          h,
          Boolean(options.mirrored),
        );
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
    this.populateParticlesAndErosion(
      mctx,
      perCtx,
      options.maxParticles ?? 22000,
    );
  }

  private acquirePooledParticle(index: number): Particle {
    let p = this.particlePool[index];
    if (!p) {
      p = {
        x: 0,
        y: 0,
        delay: 0,
        seed: 0,
        size: 2,
        power: 1,
        depth: 1,
        angle: 0,
        spin: 0,
        isFragment: false,
        r: 200,
        g: 180,
        b: 160,
      };
      this.particlePool[index] = p;
    }
    return p;
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
    let count = 0;

    for (let y = 0; y < h; y += step) {
      for (let x = 0; x < w; x += step) {
        const i = (y * w + x) * 4;
        if (mdata[i + 3] < 105) continue;
        if (pdata[i + 3] < 40) continue;

        const seed = Math.random();
        const isFragment = seed > 0.88; // ~12% larger rotating polygon fragments
        const p = this.acquirePooledParticle(count);
        p.x = x;
        p.y = y;
        p.delay = 0;
        p.seed = seed;
        p.isFragment = isFragment;
        p.depth = 0.42 + ((seed * 13.37) % 1) * 1.03;
        p.size = isFragment
          ? 3.8 + (seed - 0.88) * 38
          : 1.2 + seed * 2.1;
        p.power = (0.52 + ((seed * 7.91) % 1) * 0.92) * (0.75 + p.depth * 0.3);
        p.angle = seed * Math.PI * 2;
        p.spin = ((seed - 0.5) * 9.5) * (isFragment ? 1.4 : 0.5);
        p.r = pdata[i];
        p.g = pdata[i + 1];
        p.b = pdata[i + 2];
        count += 1;
      }
    }

    // Cap particle pool length for laptop GPU/CPU efficiency using reservoir-like shuffle
    const cap = Math.max(2000, Math.min(28000, maxParticles));
    if (count > cap) {
      for (let i = count - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        const tmp = this.particlePool[i];
        this.particlePool[i] = this.particlePool[j];
        this.particlePool[j] = tmp;
      }
      count = cap;
    }
    this.activePoolLength = count;
    this.lastActiveParticles = count;

    // Dissolve wave radiates outward from raised snapping hand
    const ox = 0.795 * w;
    const oy = 0.4 * h;
    let maxD = 1;
    for (let idx = 0; idx < count; idx++) {
      const p = this.particlePool[idx];
      const d = Math.hypot(p.x - ox, p.y - oy);
      if (d > maxD) maxD = d;
    }
    for (let idx = 0; idx < count; idx++) {
      const p = this.particlePool[idx];
      const d = Math.hypot(p.x - ox, p.y - oy) / maxD;
      p.delay = Math.min(0.85, d * 0.61 + p.seed * 0.25);
    }

    // Pre-render reusable erosion stages without allocating new DOM canvases
    const ew = Math.round(w * ERODE_SCALE);
    const eh = Math.round(h * ERODE_SCALE);
    const accCtx = this.erodeAcc.getContext("2d");
    if (!accCtx) return;
    accCtx.clearRect(0, 0, ew, eh);

    for (let s = 0; s < STAGES; s++) {
      const threshold = (s + 1) / STAGES;
      for (let idx = 0; idx < count; idx++) {
        const p = this.particlePool[idx];
        if (p.delay < threshold && p.delay >= threshold - 1 / STAGES) {
          const r =
            (7 + Math.min(4.2, p.size) * 4.5) *
            ERODE_SCALE *
            (1.15 + p.seed * 0.5);
          accCtx.globalAlpha = 0.86;
          accCtx.drawImage(
            this.blob,
            p.x * ERODE_SCALE - r,
            p.y * ERODE_SCALE - r,
            r * 2,
            r * 2,
          );
        }
      }
      accCtx.globalAlpha = 1;
      const stageCtx = this.erode[s]?.getContext("2d");
      if (stageCtx) {
        stageCtx.clearRect(0, 0, ew, eh);
        stageCtx.drawImage(this.erodeAcc, 0, 0);
      }
    }
  }

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
    const tt = Math.max(0, Math.min(1, t));
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

    try {
      ctx.save();
      ctx.clearRect(0, 0, w, h);

      // When t <= 0.001 and a live camera stream is active, render the real live camera feed directly!
      const liveVid = options.liveVideoSource;
      if (
        tt <= 0.001 &&
        liveVid &&
        liveVid.readyState >= 2 &&
        liveVid.videoWidth > 0
      ) {
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
        ctx.restore();
        return;
      }

      ctx.drawImage(this.room, 0, 0);

      if (tt <= 0.001) {
        ctx.drawImage(this.person, 0, 0);
        this.lastActiveParticles = Math.round(
          this.activePoolLength * (effectiveDensity / 100),
        );
        ctx.restore();
        return;
      }

      if (tt >= 0.999) {
        this.lastActiveParticles = 0;
        ctx.restore();
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
      ctx.restore();
    } catch (err) {
      this.lastFallbackReason =
        err instanceof Error ? err.message : "effect-render-error";
      ctx.restore();
      ctx.clearRect(0, 0, w, h);
      ctx.drawImage(this.room, 0, 0);
      ctx.save();
      ctx.globalAlpha = Math.max(0, Math.min(1, 1 - tt));
      ctx.drawImage(this.person, 0, 0);
      ctx.restore();
    }
  }

  private drawErodedPerson(ctx: CanvasRenderingContext2D, tt: number) {
    const { w, h } = this;
    if (tt >= 0.995) return;
    const idx = Math.min(STAGES - 1, Math.floor(tt * STAGES));
    const sctx = this.scratch.getContext("2d");
    if (!sctx) return;
    sctx.globalCompositeOperation = "source-over";
    sctx.clearRect(0, 0, w, h);
    sctx.drawImage(this.person, 0, 0);
    if (tt > 0.002 && this.erode[idx]) {
      sctx.globalCompositeOperation = "destination-out";
      sctx.drawImage(this.erode[idx], 0, 0, w, h);
      sctx.globalCompositeOperation = "source-over";
    }
    ctx.drawImage(this.scratch, 0, 0);
  }

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
    this.lastActiveParticles = Math.floor(total / stride);

    for (let i = 0; i < total; i += stride) {
      const p = this.particlePool[i];
      if (tt <= p.delay) continue;
      const local = Math.min(1, (tt - p.delay) / (1 - p.delay + 0.0001));
      const e = evaluateMotionCurve(local, smoothness);
      const depthScale = 0.65 + p.depth * 0.55;
      const nx = p.x - w / 2;
      const ny = p.y - h / 2;

      let dx: number;
      let dy: number;
      if (dir === "toward") {
        const k = 1 + e * 1.45 * speed * depthScale;
        dx =
          nx * (k - 1) +
          Math.sin(p.seed * 9.1 + local * 3.6) * 34 * e * depthScale;
        dy =
          ny * (k - 1) +
          Math.cos(p.seed * 7.7 + local * 2.9) * 25 * e * depthScale;
      } else {
        const curlX =
          Math.sin(p.seed * 9.1 + local * 3.8 + p.y * 0.012) * 38 +
          Math.cos(p.seed * 17.3 + local * 6.2) * 14;
        const curlY =
          Math.cos(p.seed * 7.7 + local * 3.1 + p.x * 0.01) * 28 -
          (variant === "fine" ? 45 : 0);
        dx = wind.x * e * spread * p.power + curlX * e * depthScale;
        dy =
          wind.y * e * spread * p.power +
          e * e * (variant === "fine" ? -65 : 135) * (dir === "up" ? -0.25 : 1) +
          curlY * e * depthScale;
      }

      const x = p.x + dx;
      const y = p.y + dy;
      let alpha = Math.pow(1 - local, 1.18) * Math.min(1, local * 15);
      // Far depth plane is subtly softer for atmospheric depth perception
      alpha *= 0.62 + Math.min(0.38, p.depth * 0.3);
      if (alpha <= 0.014) continue;

      const heat = Math.max(0, 1 - local * 2.9) * intensity;
      const r = Math.round(
        p.r +
          (accent.r - p.r) * heat * 0.86 +
          (192 - p.r) * (1 - heat) * 0.32,
      );
      const g = Math.round(
        p.g +
          (accent.g - p.g) * heat * 0.86 +
          (180 - p.g) * (1 - heat) * 0.32,
      );
      const b = Math.round(
        p.b +
          (accent.b - p.b) * heat * 0.86 +
          (168 - p.b) * (1 - heat) * 0.32,
      );

      const useShard =
        variant !== "fine" &&
        p.isFragment &&
        (variant === "cinematic" || p.seed > 0.94);

      if (useShard && !lowPower) {
        // Rotating irregular shard fragment
        const shardSize =
          p.size *
          particleSizeMult *
          depthScale *
          (variant === "cinematic" ? 1.25 : 0.95) *
          (1 - local * 0.48);
        const theta = p.angle + local * p.spin;
        const c = Math.cos(theta) * shardSize;
        const s = Math.sin(theta) * shardSize;

        ctx.fillStyle = `rgba(${r},${g},${b},${alpha})`;
        ctx.beginPath();
        ctx.moveTo(x + c, y + s);
        ctx.lineTo(x - s * 0.72, y + c * 0.72);
        ctx.lineTo(x - c * 0.85, y - s * 0.85);
        ctx.lineTo(x + s * 0.55, y - c * 0.55);
        ctx.closePath();
        ctx.fill();
      } else {
        // Fine ash / ember grain with depth-scaled size
        const size =
          Math.min(3.4, p.size) *
          particleSizeMult *
          (0.75 + p.depth * 0.35) *
          (1 - local * 0.4);
        ctx.fillStyle = `rgba(${r},${g},${b},${alpha})`;
        ctx.fillRect(x, y, size, size);

        if (!lowPower && p.depth > 0.95) {
          ctx.fillStyle = `rgba(${r},${g},${b},${alpha * 0.28})`;
          ctx.fillRect(
            x - dx * 0.05,
            y - dy * 0.05,
            size * 0.8,
            size * 0.8,
          );
        }
      }
    }
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

    for (let i = 0; i < total; i += blockStride) {
      const p = this.particlePool[i];
      if (tt <= p.delay) continue;
      const local = Math.min(1, (tt - p.delay) / (1 - p.delay + 0.0001));
      const snapGridX = Math.round(p.x / baseTileSize) * baseTileSize;
      const snapGridY = Math.round(p.y / baseTileSize) * baseTileSize;

      const stepE = evaluateMotionCurve(local, smoothness);
      const dx =
        (dir === "toward" ? (p.x - this.w / 2) * 0.9 : wind.x * spread) *
        stepE *
        p.power;
      const dy =
        (dir === "toward" ? (p.y - this.h / 2) * 0.9 : wind.y * spread - 90) *
        stepE *
        p.power;

      const alpha = Math.max(0, 1 - local * 1.08);
      if (alpha <= 0.02) continue;

      const edgeGlow = local < 0.35 ? (1 - local / 0.35) * intensity : 0;
      const r = Math.round(p.r * (1 - edgeGlow) + accent.r * edgeGlow);
      const g = Math.round(p.g * (1 - edgeGlow) + accent.g * edgeGlow);
      const b = Math.round(p.b * (1 - edgeGlow) + accent.b * edgeGlow);

      const tileSize = Math.max(2, baseTileSize * (1 - local * 0.45));
      ctx.fillStyle = `rgba(${r},${g},${b},${alpha})`;
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
      const alpha = Math.max(0, 1 - Math.pow(sliceProgress, 1.5));

      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.drawImage(this.person, 0, sy, w, sliceH, jitter, sy, w, sliceH);

      if (
        sliceProgress > 0.05 &&
        sliceProgress < 0.85 &&
        Math.abs(pseudoRand) > 0.35
      ) {
        ctx.fillStyle = `rgba(${accent.r},${accent.g},${accent.b},${0.28 * alpha * intensity})`;
        ctx.fillRect(
          w * 0.25 + jitter * 1.3,
          sy,
          w * 0.5,
          Math.max(2, sliceH * 0.35),
        );
      }
      ctx.restore();
    }
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
    const alpha = Math.max(0, 1 - eased);

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.drawImage(this.person, 0, 0);
    ctx.restore();

    const midPulse = Math.sin(tt * Math.PI) * 0.16 * intensity;
    if (midPulse > 0.01) {
      ctx.save();
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
        `rgba(${accent.r},${accent.g},${accent.b},${midPulse})`,
      );
      grad.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, w, h);
      ctx.restore();
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
      g.addColorStop(0, `rgba(255,250,240,${Math.min(0.85, flash * 0.88)})`);
      g.addColorStop(
        0.35,
        `rgba(${accent.r},${accent.g},${accent.b},${flash * 0.52})`,
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

    for (let i = 0; i < total; i += stride) {
      const p = this.particlePool[i];
      if (tt <= p.delay) continue;
      const local = Math.min(1, (tt - p.delay) / (1 - p.delay + 0.0001));
      const eased = evaluateMotionCurve(local, smoothness);
      const rx = p.x - w * 0.54;
      const ry = p.y - h * 0.45;
      const radialDist = Math.hypot(rx, ry) || 1;
      const ux = rx / radialDist + wind.x * 0.45;
      const uy = ry / radialDist + wind.y * 0.45;

      const x = p.x + ux * eased * spread * p.power;
      const y = p.y + uy * eased * spread * p.power;
      const alpha = Math.sin(local * Math.PI) * intensity * (0.6 + p.depth * 0.3);
      if (alpha <= 0.02) continue;

      const radius =
        (2.0 + Math.min(3.5, p.size) * 1.6) *
        particleSizeMult *
        (1 - local * 0.32);
      ctx.fillStyle = `rgba(${Math.min(255, accent.r + 50)},${Math.min(255, accent.g + 50)},${Math.min(255, accent.b + 50)},${alpha})`;
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
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
    ctx.ellipse(w * 0.5, h * 0.3, w * 0.098, h * 0.142, 0, 0, Math.PI * 2);
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
