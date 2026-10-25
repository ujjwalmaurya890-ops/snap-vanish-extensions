/**
 * Snap Vanish — Multi-Effect Visual Engine (Dust, Pixel Dissolve, Digital Glitch, Fade-Out, Light-Burst).
 *
 * The person layer is eroded by a stack of pre-rendered soft-blob masks
 * (one per dissolving stage), while ~22k particles sampled from the person's
 * own pixels are advected along an analytic path. Analytic motion means every
 * effect can be evaluated at any t in [0, 1] — allowing both disintegration
 * (0 -> 1) and exact reassembly (1 -> 0).
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
  r: number;
  g: number;
  b: number;
};

export type SceneStatus = "loading" | "ready" | "fallback";

export interface EffectRenderOptions {
  effect?: EffectType;
  speed?: number;
  particleSize?: number;
  density?: number;
  colorAccent?: string;
  intensity?: number;
  lowPowerMode?: boolean;
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
) {
  const s = Math.max(w / iw, h / ih);
  const dw = iw * s;
  const dh = ih * s;
  ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
}

/** Generous seated-figure silhouette: head, neck, shoulders, torso, raised arm. */
function silhouette(ctx: CanvasRenderingContext2D, w: number, h: number) {
  const X = (n: number) => n * w;
  const Y = (n: number) => n * h;

  ctx.beginPath();
  // head
  ctx.ellipse(X(0.5), Y(0.285), X(0.115), Y(0.168), 0, 0, Math.PI * 2);
  ctx.fill();
  // neck + shoulders + torso, generously oversized
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
  // arms: one resting, one raised (the snapping hand)
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
  // hand
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

export class DustScene {
  readonly w = FRAME_W;
  readonly h = FRAME_H;
  status: SceneStatus = "loading";
  lastFallbackReason: string | null = null;
  private lastActiveParticles = 0;

  private room = makeCanvas(FRAME_W, FRAME_H);
  private person = makeCanvas(FRAME_W, FRAME_H);
  private scratch = makeCanvas(FRAME_W, FRAME_H);
  private erode: HTMLCanvasElement[] = [];
  private particles: Particle[] = [];
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
  }

  /** Build from bitmaps; falls back to procedural art if an image is missing. */
  build(roomImg: HTMLImageElement | null, personImg: HTMLImageElement | null) {
    const { w, h } = this;
    const roomCtx = this.room.getContext("2d");
    const perCtx = this.person.getContext("2d");
    if (!roomCtx || !perCtx) {
      this.status = "fallback";
      return;
    }

    if (roomImg && personImg && roomImg.naturalWidth && personImg.naturalWidth) {
      drawCover(roomCtx, roomImg, roomImg.naturalWidth, roomImg.naturalHeight, w, h);
      drawCover(perCtx, personImg, personImg.naturalWidth, personImg.naturalHeight, w, h);
      this.status = "ready";
    } else {
      this.paintFallbackRoom(roomCtx);
      this.paintFallbackPerson(perCtx);
      this.status = "fallback";
    }

    // soft alpha mask for the figure
    const mask = makeCanvas(w, h);
    const mctx = mask.getContext("2d");
    if (!mctx) return;
    mctx.fillStyle = "#000";
    mctx.strokeStyle = "#000";
    mctx.filter = "blur(19px)";
    silhouette(mctx, w, h);
    mctx.filter = "none";

    perCtx.globalCompositeOperation = "destination-in";
    perCtx.drawImage(mask, 0, 0);
    perCtx.globalCompositeOperation = "source-over";

    // ---- sample particles from the figure's own pixels -----------------
    const mdata = mctx.getImageData(0, 0, w, h).data;
    const pdata = perCtx.getImageData(0, 0, w, h).data;
    const step = 3;
    const found: Particle[] = [];
    for (let y = 0; y < h; y += step) {
      for (let x = 0; x < w; x += step) {
        const i = (y * w + x) * 4;
        if (mdata[i + 3] < 110) continue;
        const a = pdata[i + 3];
        if (a < 40) continue;
        found.push({
          x,
          y,
          delay: 0,
          seed: Math.random(),
          size: 1.4 + Math.random() * 2.2,
          power: 0.55 + Math.random() * 0.9,
          r: pdata[i],
          g: pdata[i + 1],
          b: pdata[i + 2],
        });
      }
    }

    // dissolve spreads outward from the raised hand
    const ox = 0.795 * w;
    const oy = 0.4 * h;
    let maxD = 1;
    for (const p of found) {
      const d = Math.hypot(p.x - ox, p.y - oy);
      maxD = Math.max(maxD, d);
    }
    for (const p of found) {
      const d = Math.hypot(p.x - ox, p.y - oy) / maxD;
      p.delay = Math.min(0.86, d * 0.62 + p.seed * 0.26);
    }

    // keep the run light enough for 60fps on integrated graphics
    const MAX = 22000;
    if (found.length > MAX) {
      for (let i = found.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [found[i], found[j]] = [found[j], found[i]];
      }
      found.length = MAX;
    }
    this.particles = found;
    this.lastActiveParticles = found.length;

    // ---- pre-render the erosion stages --------------------------------
    this.erode = [];
    const ew = Math.round(w * ERODE_SCALE);
    const eh = Math.round(h * ERODE_SCALE);
    const acc = makeCanvas(ew, eh);
    const accCtx = acc.getContext("2d");
    if (!accCtx) return;
    for (let s = 0; s < STAGES; s++) {
      const threshold = (s + 1) / STAGES;
      for (const p of this.particles) {
        if (p.delay < threshold && p.delay >= threshold - 1 / STAGES) {
          const r = (7 + p.size * 4.6) * ERODE_SCALE * (1.15 + p.seed * 0.5);
          accCtx.globalAlpha = 0.85;
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
      const stage = makeCanvas(ew, eh);
      stage.getContext("2d")?.drawImage(acc, 0, 0);
      this.erode.push(stage);
    }
  }

  get particleCount(): number {
    return this.lastActiveParticles || this.particles.length;
  }

  /**
   * t = 0 → person whole, t = 1 → fully vanished.
   * Safe to run in either direction (vanishing 0->1 or reassembly 1->0).
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
    const lowPower = Boolean(options.lowPowerMode);
    const rawDensity = Math.max(20, Math.min(100, options.density ?? 80));
    const effectiveDensity = lowPower ? Math.min(35, rawDensity) : rawDensity;
    const intensity = Math.max(10, Math.min(100, options.intensity ?? 85)) / 100;
    const accent = hexToRgb(options.colorAccent ?? "#d2451e");

    try {
      ctx.save();
      ctx.clearRect(0, 0, w, h);
      ctx.drawImage(this.room, 0, 0);

      if (tt <= 0.001) {
        ctx.drawImage(this.person, 0, 0);
        this.lastActiveParticles = Math.round(
          this.particles.length * (effectiveDensity / 100),
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
          this.renderFadeOut(ctx, tt, accent, intensity);
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
            lowPower,
          );
          break;
        case "dust":
        default:
          this.renderDustParticles(
            ctx,
            tt,
            dir,
            duration,
            speed,
            particleSizeMult,
            effectiveDensity,
            accent,
            intensity,
            lowPower,
          );
          break;
      }
      ctx.restore();
    } catch (err) {
      // Graceful fallback if any effect rendering fails
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

  private renderDustParticles(
    ctx: CanvasRenderingContext2D,
    tt: number,
    dir: Direction,
    duration: number,
    speed: number,
    particleSizeMult: number,
    effectiveDensity: number,
    accent: { r: number; g: number; b: number },
    intensity: number,
    lowPower: boolean,
  ) {
    const { w, h } = this;
    this.drawErodedPerson(ctx, tt);

    const wind = windFor(dir);
    const spread =
      620 * Math.pow(duration / 1.8, 0.45) * speed * (0.65 + intensity * 0.55);
    const total = this.particles.length;
    const maxCount = Math.max(1, Math.floor(total * (effectiveDensity / 100)));
    const stride = Math.max(1, Math.round(total / maxCount));
    this.lastActiveParticles = Math.floor(total / stride);

    for (let i = 0; i < total; i += stride) {
      const p = this.particles[i];
      if (tt <= p.delay) continue;
      const local = Math.min(1, (tt - p.delay) / (1 - p.delay + 0.0001));
      const e = Math.pow(local, 1.22);
      const nx = p.x - w / 2;
      const ny = p.y - h / 2;

      let dx: number;
      let dy: number;
      if (dir === "toward") {
        const k = 1 + e * 1.35 * speed;
        dx = nx * (k - 1) + Math.sin(p.seed * 9.1 + local * 3.4) * 30 * e;
        dy = ny * (k - 1) + Math.cos(p.seed * 7.7 + local * 2.8) * 22 * e;
      } else {
        dx =
          wind.x * e * spread * p.power +
          Math.sin(p.seed * 9.1 + local * 3.4 + p.y * 0.012) * 34 * e;
        dy =
          wind.y * e * spread * p.power +
          e * e * 150 * (dir === "up" ? -0.2 : 1) +
          Math.cos(p.seed * 7.7 + local * 2.8 + p.x * 0.01) * 24 * e;
      }

      const x = p.x + dx;
      const y = p.y + dy;
      let alpha = Math.pow(1 - local, 1.15);
      alpha *= Math.min(1, local * 16);
      if (alpha <= 0.012) continue;

      const size = p.size * particleSizeMult * (1 - local * 0.42);
      const heat = Math.max(0, 1 - local * 3.1) * intensity;
      const r = Math.round(
        p.r +
          (accent.r - p.r) * heat * 0.85 +
          (196 - p.r) * (1 - heat) * 0.35,
      );
      const g = Math.round(
        p.g +
          (accent.g - p.g) * heat * 0.85 +
          (185 - p.g) * (1 - heat) * 0.35,
      );
      const b = Math.round(
        p.b +
          (accent.b - p.b) * heat * 0.85 +
          (172 - p.b) * (1 - heat) * 0.35,
      );

      ctx.fillStyle = `rgba(${r},${g},${b},${alpha})`;
      ctx.fillRect(x, y, size, size);
      if (!lowPower) {
        ctx.fillStyle = `rgba(${r},${g},${b},${alpha * 0.3})`;
        ctx.fillRect(
          x - dx * 0.055,
          y - dy * 0.055,
          size * 0.82,
          size * 0.82,
        );
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
  ) {
    this.drawErodedPerson(ctx, tt);
    const wind = windFor(dir);
    const total = this.particles.length;
    // Sample fewer, larger mosaic blocks
    const blockStride = Math.max(
      4,
      Math.round(18 / (effectiveDensity / 60)),
    );
    this.lastActiveParticles = Math.floor(total / blockStride);
    const spread = 480 * speed * (duration / 1.8) * (0.6 + intensity * 0.5);
    const baseTileSize = Math.max(5, Math.round(9 * particleSizeMult));

    for (let i = 0; i < total; i += blockStride) {
      const p = this.particles[i];
      if (tt <= p.delay) continue;
      const local = Math.min(1, (tt - p.delay) / (1 - p.delay + 0.0001));
      const snapGridX = Math.round(p.x / baseTileSize) * baseTileSize;
      const snapGridY = Math.round(p.y / baseTileSize) * baseTileSize;

      const stepE = Math.floor(local * 12) / 12;
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
      ctx.drawImage(
        this.person,
        0,
        sy,
        w,
        sliceH,
        jitter,
        sy,
        w,
        sliceH,
      );

      // Chromatic aberration bar on active glitch slices
      if (sliceProgress > 0.05 && sliceProgress < 0.85 && Math.abs(pseudoRand) > 0.35) {
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
  ) {
    const { w, h } = this;
    this.lastActiveParticles = 0;
    // Smoothstep optical curve
    const smooth = tt * tt * (3 - 2 * tt);
    const alpha = Math.max(0, 1 - smooth);

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.drawImage(this.person, 0, 0);
    ctx.restore();

    // Subtle optical tint pulse at mid-dissolve
    const midPulse = Math.sin(tt * Math.PI) * 0.18 * intensity;
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
    lowPower: boolean,
  ) {
    const { w, h } = this;
    this.drawErodedPerson(ctx, tt);

    // Photonic core bloom centered near the snapping hand / upper torso
    const flash = Math.sin(Math.pow(tt, 0.75) * Math.PI) * intensity;
    if (flash > 0.02) {
      const cx = w * 0.58;
      const cy = h * 0.42;
      const radius = w * (0.18 + tt * 0.55);
      const g = ctx.createRadialGradient(cx, cy, 4, cx, cy, radius);
      g.addColorStop(0, `rgba(255,255,255,${Math.min(0.85, flash * 0.9)})`);
      g.addColorStop(
        0.35,
        `rgba(${accent.r},${accent.g},${accent.b},${flash * 0.55})`,
      );
      g.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
    }

    // Luminous bokeh motes
    const total = this.particles.length;
    const stride = Math.max(
      8,
      Math.round((lowPower ? 45 : 22) / (effectiveDensity / 80)),
    );
    this.lastActiveParticles = Math.floor(total / stride);
    const wind = windFor(dir);
    const spread = 540 * speed * (duration / 1.8);

    for (let i = 0; i < total; i += stride) {
      const p = this.particles[i];
      if (tt <= p.delay) continue;
      const local = Math.min(1, (tt - p.delay) / (1 - p.delay + 0.0001));
      const rx = p.x - w * 0.54;
      const ry = p.y - h * 0.45;
      const radialDist = Math.hypot(rx, ry) || 1;
      const ux = rx / radialDist + wind.x * 0.45;
      const uy = ry / radialDist + wind.y * 0.45;

      const x = p.x + ux * local * spread * p.power;
      const y = p.y + uy * local * spread * p.power;
      const alpha = Math.sin(local * Math.PI) * intensity;
      if (alpha <= 0.02) continue;

      const radius = (2.2 + p.size * 1.8) * particleSizeMult * (1 - local * 0.3);
      ctx.fillStyle = `rgba(${ Math.min(255, accent.r + 50) },${ Math.min(255, accent.g + 50) },${ Math.min(255, accent.b + 50) },${alpha})`;
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // ---- procedural fallback so a missing asset never leaves a hole --------
  private paintFallbackRoom(ctx: CanvasRenderingContext2D) {
    const { w, h } = this;
    const g = ctx.createLinearGradient(0, 0, w, h);
    g.addColorStop(0, "#c9b79c");
    g.addColorStop(0.55, "#a98f72");
    g.addColorStop(1, "#6d5741");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = "rgba(255,236,205,0.22)";
    ctx.fillRect(0, 0, w * 0.32, h);
    ctx.fillStyle = "rgba(60,44,30,0.32)";
    ctx.fillRect(w * 0.72, h * 0.18, w * 0.22, h * 0.62);
    ctx.fillStyle = "rgba(38,28,19,0.5)";
    ctx.fillRect(0, h * 0.82, w, h * 0.18);
  }

  private paintFallbackPerson(ctx: CanvasRenderingContext2D) {
    const { w, h } = this;
    this.paintFallbackRoom(ctx);
    ctx.fillStyle = "#2c2620";
    ctx.beginPath();
    ctx.ellipse(w * 0.5, h * 0.3, w * 0.098, h * 0.142, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(w * 0.3, h * 1.05);
    ctx.quadraticCurveTo(w * 0.32, h * 0.5, w * 0.5, h * 0.46);
    ctx.quadraticCurveTo(w * 0.68, h * 0.5, w * 0.7, h * 1.05);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = "#5b4b3c";
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
