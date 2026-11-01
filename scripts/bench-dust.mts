/**
 * Snap Vanish 2.0 — DustScene render-loop micro-benchmark.
 *
 * Measures the JS-side cost of `DustScene.render()` (particle math + Canvas2D
 * command recording) against a counting 2D-context stub. Rasterisation is not
 * measured — this isolates per-frame CPU + allocation pressure, which is what
 * determines whether the frame budget is blown before the compositor ever sees
 * the frame.
 *
 * Run: npx vite-node scripts/bench-dust.mts
 */

type AnyCtx = Record<string, unknown>;

function makeStubCanvas(width = 0, height = 0) {
  const stats = { fillStyles: 0, fillRects: 0, draws: 0 };
  let fillStyle = "#000";
  const ctx: AnyCtx = {
    _stats: stats,
    save() {},
    restore() {},
    clearRect() {},
    beginPath() {},
    closePath() {},
    moveTo() {},
    lineTo() {},
    arc() {},
    ellipse() {},
    quadraticCurveTo() {},
    fill() {},
    stroke() {},
    translate() {},
    scale() {},
    rotate() {},
    createLinearGradient: () => ({ addColorStop() {} }),
    createRadialGradient: () => ({ addColorStop() {} }),
    createPattern: () => ({}),
    drawImage() {
      stats.draws += 1;
    },
    putImageData() {},
    getImageData: (_x: number, _y: number, w: number, h: number) => ({
      width: w,
      height: h,
      data: new Uint8ClampedArray(w * h * 4).fill(180),
    }),
    fillRect() {
      stats.fillRects += 1;
    },
    filter: "none",
    globalAlpha: 1,
    globalCompositeOperation: "source-over",
    strokeStyle: "#000",
    lineWidth: 1,
    lineCap: "round",
    lineJoin: "round",
  };
  Object.defineProperty(ctx, "fillStyle", {
    get: () => fillStyle,
    set: (v: string) => {
      fillStyle = v;
      stats.fillStyles += 1;
    },
  });

  const canvas = {
    width,
    height,
    id: "",
    style: {},
    getContext: () => ctx,
    captureStream: () => ({ getVideoTracks: () => [] }),
    getBoundingClientRect: () => ({ width, height }),
  };
  return canvas;
}

// Minimal DOM surface used by dust.ts (document.createElement only).
const g = globalThis as unknown as Record<string, unknown>;
if (!g.document) {
  g.document = {
    createElement: () => makeStubCanvas(),
  };
}

const { DustScene } = await import("../src/lib/dust.ts");

const FRAMES = 120;
const RESULTS: Array<{ label: string; effect: string; ms: number; fillRects: number; fillStyles: number; draws: number }> = [];

for (const effect of ["dust", "cinematic-disintegration", "fine-particles", "pixel-dissolve", "light-burst"] as const) {
  const scene = new DustScene();
  scene.build(null, null, 12000);
  const ctx = makeStubCanvas().getContext() as AnyCtx;
  const stats = (ctx as unknown as { _stats: { fillStyles: number; fillRects: number; draws: number } })._stats;

  // Warm up (JIT + lazy particle init)
  for (let i = 0; i < 10; i++) {
    scene.render(ctx as unknown as CanvasRenderingContext2D, 0.4, "right", 1.8, { effect });
  }
  stats.fillStyles = 0;
  stats.fillRects = 0;
  stats.draws = 0;

  const t0 = performance.now();
  for (let f = 0; f < FRAMES; f++) {
    const t = 0.02 + (f / FRAMES) * 0.96;
    scene.render(ctx as unknown as CanvasRenderingContext2D, t, "right", 1.8, {
      effect,
      speed: 1,
      particleSize: 1,
      density: 80,
      colorAccent: "#e0532c",
      intensity: 85,
      motionSmoothness: 70,
      lowPowerMode: false,
    });
  }
  const elapsed = performance.now() - t0;

  RESULTS.push({
    label: `particles=${scene.particleCount}`,
    effect,
    ms: Number((elapsed / FRAMES).toFixed(3)),
    fillRects: Math.round(stats.fillRects / FRAMES),
    fillStyles: Math.round(stats.fillStyles / FRAMES),
    draws: Math.round(stats.draws / FRAMES),
  });
}

console.log("\n=== DustScene micro-benchmark (JS-side frame cost) ===");
console.table(RESULTS);
const worst = Math.max(...RESULTS.map((r) => r.ms));
console.log(`worst effect frame cost: ${worst.toFixed(3)} ms  (16.67 ms = 60 FPS budget)`);
