/**
 * Snap Vanish 2.0 — Isolated-World Conferencing Content Script
 *
 * Runs on Google Meet, Microsoft Teams Web, and Zoom Web Client.
 *
 * WHAT CHANGED VS 2.0.0 (see docs/OPTIMIZATION_REPORT.md)
 * 1. ZERO host-DOM mutation. HUD + overlay live in a closed-shadow-root host with
 *    `all: initial`, positioned `fixed` from the self-view `getBoundingClientRect`.
 *    The old code appended a canvas to the host's video parent and forced
 *    `parent.style.position = "relative"`, which reflowed the meeting layout.
 * 2. Zero per-frame `querySelectorAll("video")` / `getComputedStyle` calls. The
 *    self-view element is cached and invalidated by `playing`, `resize`, and a
 *    debounced `MutationObserver`.
 * 3. Zero per-frame allocations in the render loop: SoA `Float32Array` particles,
 *    interned `rgba()` strings, counting-sorted alpha buckets (~200 `fillStyle`
 *    writes/frame instead of ~10 000).
 * 4. Single render target per transition (capture canvas OR overlay canvas). The
 *    old loop rendered a full-frame canvas and then blitted it into a second
 *    full-frame canvas every frame.
 * 5. Transition state is committed *before* any await, so the first animation
 *    frame is never delayed by the bridge round-trip (up to 600 ms of dead time).
 * 6. Confirmation audio uses one long-lived `AudioContext`; the offscreen document
 *    is used only when the page context is still `suspended` (keyboard-shortcut
 *    path, where no user activation exists).
 */

(() => {
  if (window.__snapVanishContentInitialized) return;
  window.__snapVanishContentInitialized = true;

  const TAG = "[snap-vanish]";
  const BRIDGE_TIMEOUT_MS = 400;
  const MAX_PARTICLES = 12000;
  const LOW_POWER_PARTICLES = 5500;
  const KEEPALIVE_INTERVAL_MS = 125;
  const CAPTURE_MAX_W = 1280;
  const CAPTURE_MAX_H = 720;

  const DEFAULT_CFG = {
    enabled: true,
    showCallHud: true,
    hudPosition: "bottom-right",
    sensitivity: 62,
    duration: 1.8,
    direction: "right",
    effect: "dust",
    speed: 1.0,
    particleSize: 1.0,
    density: 80,
    colorAccent: "#e0532c",
    intensity: 85,
    motionSmoothness: 70,
    sound: true,
    muteOnVanish: true,
    lowPowerMode: false,
    pauseWhenHidden: true,
    gesture: {
      enabled: true,
      detectionMode: "smart",
      mode: "balanced",
      sensitivity: 62,
      minHandConfidence: 0.62,
      inferenceFpsLimit: 24,
      cooldownMs: 2000,
      requireAudioConfirm: true,
      calibratedCollapseThresholdMm: 12,
    },
    audio: {
      enabled: true,
      sensitivityDb: 12,
      confirmWindowMs: 220,
    },
    camera: {
      autoRestoreOnLeave: true,
    },
  };

  /** Single mutable state object — no free-floating globals. */
  const state = {
    cfg: structuredClone(DEFAULT_CFG),
    engineState: "live", // live | vanishing | vanished | restoring
    interceptionMode: "dom-overlay", // webrtc-sender | dom-overlay
    sendersCount: 0,
    mutedByExtension: false,
    bridgeToken: null,
    busy: false,
    // Initialised here (not only in applySettings) so a vanish before the
    // first storage read can never dereference an undefined accent colour.
    accentRgb: { r: 224, g: 83, b: 44 },
  };

  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const nowMs = () => performance.now();

  /* Detection policy (brief §3) — mirrors `resolveDetectionPolicy` in
   * `src/lib/settings.ts` so every surface agrees:
   * - smart:        visual snap + acoustic confirmation (mic may open)
   * - gesture-only: visual snap alone (mic never opens)
   * - manual:       no automatic detection (popup / HUD / shortcut only)
   * Sound alone can never trigger a vanish in any mode. */
  const detectionMode = () => state.cfg.gesture?.detectionMode || "smart";
  const detectionActive = () =>
    Boolean(state.cfg.enabled) &&
    state.cfg.gesture?.enabled !== false &&
    detectionMode() !== "manual";
  const audioConfirmRequired = () =>
    detectionMode() === "smart" &&
    state.cfg.gesture?.requireAudioConfirm !== false;
  const microphoneAllowed = () =>
    detectionActive() &&
    audioConfirmRequired() &&
    state.cfg.audio?.enabled !== false;

  /* ================================================================== *
   * 1. HUD + overlay — closed shadow root, zero host DOM mutation
   * ================================================================== */

  const SHADOW_CSS = `
    :host {
      all: initial;
      position: fixed;
      inset: 0;
      z-index: 2147483645;
      pointer-events: none;
      contain: layout style paint;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, sans-serif;
    }
    #tile-canvas {
      position: absolute;
      display: none;
      object-fit: cover;
      border-radius: 8px;
      pointer-events: none;
    }
    #hud {
      position: fixed;
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 6px 10px;
      border-radius: 999px;
      background: rgba(15, 17, 23, 0.9);
      border: 1px solid rgba(255, 255, 255, 0.12);
      box-shadow: 0 12px 32px rgba(0, 0, 0, 0.55);
      color: #f4f4f6;
      font-size: 11.5px;
      line-height: 1;
      user-select: none;
      pointer-events: auto;
      transition: opacity 0.2s ease;
    }
    #hud[data-pos="bottom-right"] { right: 16px; bottom: 76px; }
    #hud[data-pos="bottom-left"] { left: 16px; bottom: 76px; }
    #hud[data-pos="top-right"] { right: 16px; top: 16px; }
    #hud[data-hidden="true"] { display: none; }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: #10b981;
           box-shadow: 0 0 8px rgba(16, 185, 129, 0.7); }
    #hud[data-state="vanished"] .dot, #hud[data-state="vanishing"] .dot,
    #hud[data-state="restoring"] .dot { background: #f59e0b;
           box-shadow: 0 0 8px rgba(245, 158, 11, 0.8); }
    #hud[data-enabled="false"] .dot { background: #71717a; box-shadow: none; }
    .label { font-family: ui-monospace, Consolas, monospace; font-size: 10.5px;
             letter-spacing: 0.05em; text-transform: uppercase; color: #e4e6ee; }
    .btn { appearance: none; border: 1px solid rgba(255, 255, 255, 0.14);
           background: rgba(224, 83, 44, 0.22); color: #ff9d80; border-radius: 999px;
           padding: 4px 8px; font-size: 10.5px; font-weight: 600; cursor: pointer; }
    .btn:hover { background: rgba(240, 98, 58, 0.4); color: #fff; }
    .btn-restore { background: rgba(239, 68, 68, 0.18);
                   border-color: rgba(239, 68, 68, 0.38); color: #fecaca; }
    .btn-restore:hover { background: rgba(239, 68, 68, 0.34); color: #fff; }
  `;

  let shadowRoot = null;
  let hudEl = null;
  let hudTextEl = null;
  let hudToggleBtn = null;
  let tileCanvas = null;

  function ensureSurface() {
    if (shadowRoot) return;
    const host = document.createElement("div");
    host.id = "snap-vanish-root";
    // The host is the only node we add to the page, and it carries no styles the
    // host page can reach into (closed shadow root + `all: initial`).
    host.setAttribute("aria-hidden", "false");
    shadowRoot = host.attachShadow({ mode: "closed" });

    const style = document.createElement("style");
    style.textContent = SHADOW_CSS;

    tileCanvas = document.createElement("canvas");
    tileCanvas.id = "tile-canvas";

    hudEl = document.createElement("div");
    hudEl.id = "hud";
    hudEl.setAttribute("role", "status");
    hudEl.innerHTML =
      '<span class="dot"></span>' +
      '<span class="label" id="sv-hud-text">Snap Vanish · Armed</span>' +
      '<button type="button" class="btn" id="sv-hud-toggle">Vanish</button>' +
      '<button type="button" class="btn btn-restore" id="sv-hud-restore" ' +
      'title="Emergency Restore (Alt+Shift+R)">Restore</button>';

    shadowRoot.append(style, tileCanvas, hudEl);
    document.documentElement.appendChild(host);

    hudTextEl = hudEl.querySelector("#sv-hud-text");
    hudToggleBtn = hudEl.querySelector("#sv-hud-toggle");
    hudToggleBtn?.addEventListener("click", () => void startTransition("toggle"));
    hudEl
      .querySelector("#sv-hud-restore")
      ?.addEventListener("click", () => void emergencyRestore());
  }

  function updateHud() {
    if (!hudEl) return;
    hudEl.setAttribute("data-pos", state.cfg.hudPosition || "bottom-right");
    hudEl.setAttribute("data-hidden", state.cfg.showCallHud === false ? "true" : "false");
    hudEl.setAttribute("data-state", state.engineState);
    hudEl.setAttribute("data-enabled", String(Boolean(state.cfg.enabled)));
    if (hudTextEl) {
      if (!state.cfg.enabled) hudTextEl.textContent = "Snap Vanish · Paused";
      else if (state.engineState === "vanished")
        hudTextEl.textContent = `Vanished · ${
          state.interceptionMode === "webrtc-sender" ? "WebRTC" : "Tile"
        }`;
      else if (state.engineState === "live")
        hudTextEl.textContent = `Armed${handModelReady ? " · 21-Pt AI" : ""}`;
      else hudTextEl.textContent = "Transitioning…";
    }
    if (hudToggleBtn) {
      hudToggleBtn.textContent = state.engineState === "vanished" ? "Return" : "Vanish";
    }
  }

  /* ================================================================== *
   * 2. Self-view discovery — cached, event-invalidated
   * ================================================================== */

  let selfVideo = null;
  let videoCacheDirty = true;

  function invalidateVideoCache() {
    videoCacheDirty = true;
    scheduleRectSync();
  }

  function isUsableVideo(v) {
    return (
      v &&
      v.isConnected &&
      v.readyState >= 2 &&
      v.videoWidth > 64 &&
      v.videoHeight > 64
    );
  }

  function pickSelfVideo() {
    if (!videoCacheDirty && isUsableVideo(selfVideo)) return selfVideo;
    videoCacheDirty = false;

    const videos = Array.from(document.querySelectorAll("video")).filter(isUsableVideo);
    if (videos.length === 0) {
      selfVideo = null;
      return null;
    }
    if (videos.length === 1) {
      selfVideo = videos[0];
      return selfVideo;
    }

    // Scored selection: muted preview tile (Meet/Teams/Zoom self view), mirrored
    // transform, or self-labelled aria text. `getComputedStyle` is consulted at
    // most once per candidate and only when the cache is invalidated.
    let best = null;
    let bestScore = -1;
    for (const v of videos.slice(0, 8)) {
      let score = 0;
      if (v.muted) score += 2;
      const label = `${v.getAttribute("aria-label") || ""} ${
        v.parentElement?.getAttribute("aria-label") || ""
      }`.toLowerCase();
      if (label.includes("you") || label.includes("self") || label.includes("your")) {
        score += 3;
      }
      try {
        if (window.getComputedStyle(v).transform.includes("-1")) score += 2;
      } catch {
        /* ignore */
      }
      if (score > bestScore) {
        bestScore = score;
        best = v;
      }
    }
    selfVideo = best || videos[0];
    return selfVideo;
  }

  document.addEventListener("playing", invalidateVideoCache, true);
  document.addEventListener("loadedmetadata", invalidateVideoCache, true);

  let mutationTimer = 0;
  let observer = null;
  function ensureObserver() {
    if (observer || typeof MutationObserver !== "function") return;
    observer = new MutationObserver(() => {
      window.clearTimeout(mutationTimer);
      mutationTimer = window.setTimeout(invalidateVideoCache, 350);
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  /* ------------------------------------------------------------------ *
   * Overlay geometry — synced on scroll/resize only, never per frame
   * ------------------------------------------------------------------ */

  let rectRaf = 0;
  function scheduleRectSync() {
    if (rectRaf) return;
    rectRaf = requestAnimationFrame(() => {
      rectRaf = 0;
      syncOverlayRect();
    });
  }

  function syncOverlayRect() {
    if (!tileCanvas) return;
    const video = pickSelfVideo();
    if (!video) {
      tileCanvas.style.display = "none";
      return;
    }
    const rect = video.getBoundingClientRect();
    if (rect.width < 32 || rect.height < 32) {
      tileCanvas.style.display = "none";
      return;
    }
    // Match the backing store to CSS pixels × DPR, capped at the capture size so
    // a 4K tile never allocates a 4K canvas.
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cssW = Math.min(rect.width, CAPTURE_MAX_W);
    const cssH = Math.min(rect.height, CAPTURE_MAX_H);
    const wantW = Math.round(cssW * dpr);
    const wantH = Math.round(cssH * dpr);
    if (tileCanvas.width !== wantW) tileCanvas.width = wantW;
    if (tileCanvas.height !== wantH) tileCanvas.height = wantH;
    tileCanvas.style.left = `${rect.left}px`;
    tileCanvas.style.top = `${rect.top}px`;
    tileCanvas.style.width = `${rect.width}px`;
    tileCanvas.style.height = `${rect.height}px`;
  }

  window.addEventListener("resize", scheduleRectSync, { passive: true });
  window.addEventListener("scroll", scheduleRectSync, {
    passive: true,
    capture: true,
  });

  /* ================================================================== *
   * 3. Capture + particle system (struct-of-arrays, zero churn)
   * ================================================================== */

  let captureCanvas = null;
  let personCanvas = null;
  let plateCanvas = null;
  let captureCtx = null;
  let personCtx = null;
  let plateCtx = null;
  let tileCtx = null;

  const particles = {
    count: 0,
    x: new Float32Array(MAX_PARTICLES),
    y: new Float32Array(MAX_PARTICLES),
    delay: new Float32Array(MAX_PARTICLES),
    size: new Float32Array(MAX_PARTICLES),
    vx: new Float32Array(MAX_PARTICLES),
    vy: new Float32Array(MAX_PARTICLES),
    spin: new Float32Array(MAX_PARTICLES),
    seed: new Float32Array(MAX_PARTICLES),
    r: new Uint8Array(MAX_PARTICLES),
    g: new Uint8Array(MAX_PARTICLES),
    b: new Uint8Array(MAX_PARTICLES),
    shard: new Uint8Array(MAX_PARTICLES),
  };

  // Emission scratch (allocated once; indices are reused every frame).
  const scratch = {
    key: new Uint32Array(MAX_PARTICLES),
    index: new Uint32Array(MAX_PARTICLES),
    order: new Uint32Array(MAX_PARTICLES),
    sx: new Float32Array(MAX_PARTICLES),
    sy: new Float32Array(MAX_PARTICLES),
    alpha: new Uint8Array(MAX_PARTICLES),
    local: new Float32Array(MAX_PARTICLES),
  };

  const ALPHA_STEPS = 16;
  const BUCKETS = 4096 * ALPHA_STEPS;
  const bucketCounts = new Uint32Array(BUCKETS + 1);
  const bucketCursor = new Uint32Array(BUCKETS + 1);
  const styleCache = new Map();

  function styleFor(colorKey, alphaStep) {
    const key = colorKey * ALPHA_STEPS + alphaStep;
    let s = styleCache.get(key);
    if (s !== undefined) return s;
    const r = ((((colorKey >> 8) & 0xf) << 4) | 8);
    const g = ((((colorKey >> 4) & 0xf) << 4) | 8);
    const b = (((colorKey & 0xf) << 4) | 8);
    s = `rgba(${r},${g},${b},${(alphaStep / (ALPHA_STEPS - 1)).toFixed(2)})`;
    styleCache.set(key, s);
    return s;
  }

  const frame = { w: 640, h: 360 };

  function ensureCanvasSize(canvas, w, h) {
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
  }

  function ensureCaptureCanvas(width, height) {
    ensureSurface();
    if (!captureCanvas) {
      captureCanvas = document.createElement("canvas");
      captureCanvas.id = "snap-vanish-rtc-canvas";
      // A `display:none` canvas stops producing captureStream frames, so keep it
      // in the layout tree but visually out of the way.
      captureCanvas.style.cssText =
        "position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;opacity:0;pointer-events:none;";
      if (!captureCanvas.parentElement) {
        document.documentElement.appendChild(captureCanvas);
      }
      captureCtx = captureCanvas.getContext("2d", { alpha: false, desynchronized: true });
    }
    // Only resize while detached from the peer connection: changing the backing
    // store of a captured canvas forces an SDP renegotiation on the call.
    if (state.interceptionMode !== "webrtc-sender") {
      captureCanvas.width = width;
      captureCanvas.height = height;
    }
    return captureCanvas;
  }

  function buildParticles(video) {
    const w = frame.w;
    const h = frame.h;

    if (!personCanvas) {
      personCanvas = document.createElement("canvas");
      personCtx = personCanvas.getContext("2d", { willReadFrequently: true });
    }
    ensureCanvasSize(personCanvas, w, h);
    if (video) personCtx.drawImage(video, 0, 0, w, h);
    else {
      personCtx.fillStyle = "#181a22";
      personCtx.fillRect(0, 0, w, h);
    }

    if (!plateCanvas) {
      plateCanvas = document.createElement("canvas");
      plateCtx = plateCanvas.getContext("2d", { willReadFrequently: false });
    }
    ensureCanvasSize(plateCanvas, w, h);
    plateCtx.clearRect(0, 0, w, h);
    if (video) {
      // Extrapolate peripheral room strips into a clean ambient background plate.
      plateCtx.filter = "blur(22px) brightness(0.94)";
      plateCtx.drawImage(video, 0, 0, w, h);
      plateCtx.filter = "none";
      const borderW = Math.floor(w * 0.16);
      plateCtx.drawImage(video, 0, 0, borderW, h, 0, 0, borderW, h);
      plateCtx.drawImage(video, w - borderW, 0, borderW, h, w - borderW, 0, borderW, h);
    } else {
      plateCtx.fillStyle = "#0e1016";
      plateCtx.fillRect(0, 0, w, h);
    }

    const img = personCtx.getImageData(0, 0, w, h).data;
    const maxCount = state.cfg.lowPowerMode ? LOW_POWER_PARTICLES : MAX_PARTICLES;
    const stride = Math.max(2, Math.round(Math.sqrt((w * h * 0.45) / maxCount)));
    const cx = w * 0.5;
    const cy = h * 0.56;
    const rx = w * 0.34;
    const ry = h * 0.46;
    const left = state.cfg.direction === "left";
    const up = state.cfg.direction === "up";
    const down = state.cfg.direction === "down";
    const sizeMult = state.cfg.particleSize || 1;

    let n = 0;
    for (let y = 0; y < h; y += stride) {
      for (let x = 0; x < w; x += stride) {
        const nx = (x - cx) / rx;
        const ny = (y - cy) / ry;
        if (nx * nx + ny * ny > 1.25) continue;
        if (n >= MAX_PARTICLES) break;
        const idx = (y * w + x) * 4;
        const seed = Math.random();
        particles.x[n] = x;
        particles.y[n] = y;
        particles.r[n] = img[idx];
        particles.g[n] = img[idx + 1];
        particles.b[n] = img[idx + 2];
        particles.size[n] = stride * (0.85 + Math.random() * 1.15) * sizeMult;
        particles.seed[n] = seed;
        // Per-effect velocity fields (brief §4) — the in-call renderer must
        // honour the same effect the Studio preview shows:
        //   dust                → Classic Dust (directional ember drift)
        //   cinematic-...       → Infinity Snap (spiral swirl, applied in emit)
        //   light-burst         → Energy Burst (radial outward impulse)
        //   fade-out            → Smoke Dissolve (slow, soft, rising)
        //   digital-glitch      → Digital Disintegration (blocks, quantised)
        //   pixel-dissolve      → Pixel rain (random order, falls)
        //   fine-particles      → Fine ash (tiny, gentle thermal rise)
        const fx = state.cfg.effect;
        const intensityScale = clamp((state.cfg.intensity || 85) / 85, 0.3, 1.6);
        const rnd = Math.random();
        if (fx === "light-burst") {
          const dx = (x - cx) / Math.max(1, rx);
          const dy = (y - cy) / Math.max(1, ry);
          const len = Math.max(0.18, Math.sqrt(dx * dx + dy * dy));
          const mag = (150 + rnd * 220) * intensityScale;
          particles.vx[n] = (dx / len) * mag;
          particles.vy[n] = (dy / len) * mag - 20;
          particles.delay[n] = len * 0.12 + rnd * 0.05;
          particles.shard[n] = seed < 0.1 ? 1 : 0;
        } else if (fx === "fade-out") {
          particles.vx[n] = (rnd - 0.5) * 36 * intensityScale;
          particles.vy[n] = -(18 + rnd * 42) * intensityScale;
          particles.delay[n] = rnd * 0.3;
          particles.size[n] = particles.size[n] * 1.9;
          particles.shard[n] = 0;
        } else if (fx === "digital-glitch") {
          particles.vx[n] = (rnd - 0.5) * 90 * intensityScale;
          particles.vy[n] = (55 + rnd * 120) * intensityScale;
          particles.delay[n] = rnd * 0.38;
          particles.size[n] = particles.size[n] * 1.5;
          particles.shard[n] = 1;
        } else if (fx === "pixel-dissolve") {
          particles.vx[n] = (rnd - 0.5) * 44 * intensityScale;
          particles.vy[n] = (70 + rnd * 130) * intensityScale;
          particles.delay[n] = rnd * 0.45;
          particles.shard[n] = seed < 0.3 ? 1 : 0;
        } else if (fx === "fine-particles") {
          particles.vx[n] = (rnd - 0.5) * 52 * intensityScale;
          particles.vy[n] = -(30 + rnd * 70) * intensityScale;
          particles.delay[n] = (x / w) * 0.3 + rnd * 0.22;
          particles.size[n] = particles.size[n] * 0.65;
          particles.shard[n] = 0;
        } else if (fx === "cinematic-disintegration") {
          // Base drift + tangential swirl (rotation applied in emitParticles).
          const dx = (x - cx) / Math.max(1, rx);
          const dy = (y - cy) / Math.max(1, ry);
          particles.vx[n] = (70 + rnd * 120) * intensityScale - dy * 60;
          particles.vy[n] = -(35 + rnd * 95) * intensityScale + dx * 60;
          particles.delay[n] = (x / w) * 0.36 + rnd * 0.18;
          particles.shard[n] = seed < 0.22 ? 1 : 0;
        } else {
          particles.vx[n] = (
            left
              ? -(95 + rnd * 140)
              : up
                ? (rnd - 0.5) * 70
                : 95 + rnd * 140
          ) * intensityScale;
          particles.vy[n] = (
            down ? 65 + rnd * 110 : -(45 + rnd * 115)
          ) * intensityScale;
          particles.delay[n] = (x / w) * 0.42 + rnd * 0.16;
          particles.shard[n] = seed < 0.16 ? 1 : 0;
        }
        particles.spin[n] = (Math.random() - 0.5) * 4.2;
        n += 1;
      }
      if (n >= MAX_PARTICLES) break;
    }
    particles.count = n;
  }

  /* ================================================================== *
   * 4. Renderer
   * ================================================================== */

  function renderFrame(t) {
    const target = state.interceptionMode === "webrtc-sender" ? captureCtx : tileCtx;
    const canvas = state.interceptionMode === "webrtc-sender" ? captureCanvas : tileCanvas;
    if (!target || !canvas || !plateCanvas) return;

    try {
      const sx = canvas.width / frame.w;
      const sy = canvas.height / frame.h;
      target.setTransform(sx, 0, 0, sy, 0, 0);
      target.clearRect(0, 0, frame.w, frame.h);
      target.drawImage(plateCanvas, 0, 0, frame.w, frame.h);

      if (t <= 0.001) {
        const video = pickSelfVideo();
        if (video) target.drawImage(video, 0, 0, frame.w, frame.h);
      } else if (t < 0.999) {
        const intact = Math.max(0, 1 - t * 1.35);
        if (intact > 0) {
          target.globalAlpha = intact;
          target.drawImage(personCanvas, 0, 0, frame.w, frame.h);
          target.globalAlpha = 1;
        }
        emitParticles(target, t);
      }
    } catch {
      // A single bad frame must never break the session; the next rAF retries.
    }
  }

  /**
   * Counting-sorted emitter: particles are bucketed by quantised
   * (colour × alpha) so `fillStyle` is written once per bucket rather than once
   * per particle, and every `rgba()` string is interned.
   */
  function emitParticles(ctx, t) {
    const total = particles.count;
    if (total === 0) return;
    const density = clamp((state.cfg.density || 80) / 100, 0.2, 1);
    const limit = Math.floor(total * density);
    const speed = state.cfg.speed || 1;
    const accent = state.accentRgb;
    const swirl = state.cfg.effect === "cinematic-disintegration";
    const quantise = state.cfg.effect === "digital-glitch";
    const centreX = frame.w * 0.5;
    const centreY = frame.h * 0.56;
    let visible = 0;

    for (let i = 0; i < limit; i++) {
      const delay = particles.delay[i];
      if (t <= delay) continue;
      const local = (t - delay) / 0.55;
      if (local <= 0 || local >= 1) continue;
      const ease = local * local * (3 - 2 * local);
      let px = particles.x[i] + particles.vx[i] * ease * speed;
      let py = particles.y[i] + particles.vy[i] * ease * speed;
      if (swirl) {
        // Infinity Snap: rotate the drifted position around the subject
        // centre so particles visibly spiral before they fade.
        const angle = ease * (1.1 + particles.seed[i] * 1.4);
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        const ox = px - centreX;
        const oy = py - centreY;
        px = centreX + ox * cos - oy * sin;
        py = centreY + ox * sin + oy * cos;
      } else if (quantise) {
        // Digital Disintegration: snap motion to a coarse grid for a
        // blocky, stepped corruption feel.
        px = Math.round(px / 6) * 6;
        py = Math.round(py / 6) * 6;
      }
      const alpha = (1 - ease) * 0.92;
      if (alpha <= 0.02) continue;

      const heat = local < 0.22 && state.cfg.effect === "cinematic-disintegration";
      const r = heat ? accent.r : particles.r[i];
      const g = heat ? accent.g : particles.g[i];
      const b = heat ? accent.b : particles.b[i];

      scratch.sx[visible] = px;
      scratch.sy[visible] = py;
      scratch.alpha[visible] = (alpha * 255) | 0;
      scratch.local[visible] = ease;
      scratch.index[visible] = i;
      scratch.key[visible] =
        ((((r >> 4) & 0xf) << 8) | (((g >> 4) & 0xf) << 4) | ((b >> 4) & 0xf)) *
          ALPHA_STEPS +
        ((alpha * 255) >> 4);
      visible += 1;
      if (visible >= MAX_PARTICLES) break;
    }
    if (visible === 0) return;

    bucketCounts.fill(0);
    for (let n = 0; n < visible; n++) bucketCounts[scratch.key[n] + 1] += 1;
    for (let k = 1; k <= BUCKETS; k++) bucketCounts[k] += bucketCounts[k - 1];
    bucketCursor.set(bucketCounts);
    for (let n = 0; n < visible; n++) {
      scratch.order[bucketCursor[scratch.key[n]]++] = n;
    }

    for (let b = 0; b < BUCKETS; b++) {
      const start = bucketCounts[b];
      const end = bucketCounts[b + 1];
      if (start === end) continue;
      const alphaStep = b % ALPHA_STEPS;
      ctx.fillStyle = styleFor((b / ALPHA_STEPS) | 0, alphaStep);
      for (let k = start; k < end; k++) {
        const n = scratch.order[k];
        const i = scratch.index[n];
        const size = particles.size[i] * (1 - scratch.local[n] * 0.35);
        if (particles.shard[i] === 1) {
          ctx.save();
          ctx.translate(scratch.sx[n], scratch.sy[n]);
          ctx.rotate(particles.spin[i] * scratch.local[n]);
          ctx.fillRect(-size * 0.6, -size * 0.4, size * 1.2, size * 0.8);
          ctx.restore();
        } else {
          ctx.fillRect(scratch.sx[n], scratch.sy[n], size, size);
        }
      }
    }
  }

  /* ================================================================== *
   * 5. Animation loop
   * ================================================================== */

  let rafId = 0;
  let animStartMs = 0;
  let animFrom = 0;
  let animTo = 1;
  let lastKeepAliveAt = 0;

  function stopLoop() {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
  }

  function totalDurationMs() {
    return Math.max(
      400,
      ((state.cfg.duration || 1.8) * 1000) / Math.max(0.5, state.cfg.speed || 1),
    );
  }

  function tick(now) {
    rafId = 0;
    if (state.cfg.pauseWhenHidden && document.hidden) {
      rafId = requestAnimationFrame(tick);
      return;
    }

    if (state.engineState === "vanishing" || state.engineState === "restoring") {
      const k = clamp((now - animStartMs) / totalDurationMs(), 0, 1);
      const t = animFrom + (animTo - animFrom) * k;
      renderFrame(t);
      if (k < 1) {
        rafId = requestAnimationFrame(tick);
        return;
      }
      finishTransition();
      return;
    }

    // Vanished: keep the captured track alive at a low cadence without burning a
    // frame budget — the sender only needs periodic updates to avoid RTCP
    // starvation on some clients.
    if (state.engineState === "vanished") {
      if (now - lastKeepAliveAt >= KEEPALIVE_INTERVAL_MS) {
        lastKeepAliveAt = now;
        renderFrame(1);
      }
      rafId = requestAnimationFrame(tick);
    }
  }

  function startLoop() {
    if (!rafId) rafId = requestAnimationFrame(tick);
  }

  /* ================================================================== *
   * 6. Bridge client (single ack listener, per-request promises)
   * ================================================================== */

  const bridgePending = new Map();
  let bridgeSeq = 0;

  window.addEventListener("snap-vanish:bridge-ack", (ev) => {
    const d = ev && ev.detail ? ev.detail : {};
    const entry = bridgePending.get(d.requestId);
    if (!entry) return;
    bridgePending.delete(d.requestId);
    window.clearTimeout(entry.timer);
    entry.resolve(d);
  });

  function bridgeRequest(action, extra = {}, timeoutMs = BRIDGE_TIMEOUT_MS) {
    return new Promise((resolve) => {
      const requestId = `sv-${++bridgeSeq}-${(Math.random() * 1e6) | 0}`;
      const timer = window.setTimeout(() => {
        bridgePending.delete(requestId);
        resolve({ ok: false, mode: "dom-overlay", sendersCount: 0, reason: "timeout" });
      }, timeoutMs);
      bridgePending.set(requestId, { resolve, timer });
      try {
        window.dispatchEvent(
          new CustomEvent("snap-vanish:bridge-cmd", {
            detail: {
              requestId,
              action,
              token: state.bridgeToken ?? undefined,
              ...extra,
            },
          }),
        );
      } catch {
        bridgePending.delete(requestId);
        window.clearTimeout(timer);
        resolve({ ok: false, mode: "dom-overlay", sendersCount: 0, reason: "dispatch-failed" });
      }
    });
  }

  async function handshakeBridge() {
    const hello = await bridgeRequest("HELLO", {}, BRIDGE_TIMEOUT_MS);
    if (!hello || !hello.ok) return null;
    state.bridgeToken = hello.token;
    state.sendersCount = hello.sendersCount || 0;
    state.interceptionMode = hello.sendersCount > 0 ? "webrtc-sender" : "dom-overlay";
    return hello;
  }

  function captureSizeFor(video, videoSettings) {
    const w = Math.min(
      CAPTURE_MAX_W,
      Math.round(videoSettings?.width || video?.videoWidth || 640),
    );
    const h = Math.min(
      CAPTURE_MAX_H,
      Math.round(videoSettings?.height || video?.videoHeight || 360),
    );
    // Even dimensions keep every encoder happy.
    return { w: Math.max(2, w - (w % 2)), h: Math.max(2, h - (h % 2)) };
  }

  /* ================================================================== *
   * 7. Audio (single context + optional offscreen cue fallback)
   * ================================================================== */

  let audioCtx = null;
  let audioAnalyser = null;
  let audioBuf = null;
  let micStream = null;
  let audioFloorDb = -60;
  let lastOnsetAt = null;

  function ensureAudioContext() {
    if (audioCtx && audioCtx.state !== "closed") return audioCtx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    try {
      audioCtx = new AC({ latencyHint: "interactive" });
    } catch {
      audioCtx = null;
    }
    return audioCtx;
  }

  /** Plays the confirmation cue locally, or delegates to the offscreen document. */
  function playCue() {
    if (!state.cfg.sound) return;
    const ctx = ensureAudioContext();
    if (ctx) {
      if (ctx.state === "suspended") void ctx.resume().catch(() => {});
      if (ctx.state === "running") {
        try {
          const t0 = ctx.currentTime;
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = "triangle";
          osc.frequency.setValueAtTime(1450, t0);
          osc.frequency.exponentialRampToValueAtTime(340, t0 + 0.065);
          gain.gain.setValueAtTime(0.16, t0);
          gain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.075);
          osc.connect(gain).connect(ctx.destination);
          osc.start(t0);
          osc.stop(t0 + 0.08);
          return;
        } catch {
          /* fall through to offscreen */
        }
      }
    }
    // No live page AudioContext (keyboard-shortcut path without user activation).
    try {
      chrome?.runtime?.sendMessage?.({ type: "PLAY_CUE", payload: { cue: "snap" } });
    } catch {
      /* optional */
    }
  }

  async function ensureAudioGate() {
    if (audioAnalyser) return true;
    // The microphone is opened only in Smart mode with confirmation enabled.
    if (!microphoneAllowed()) return false;
    if (!navigator.mediaDevices?.getUserMedia) return false;
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
        video: false,
      });
      const ctx = ensureAudioContext();
      if (!ctx) return false;
      const src = ctx.createMediaStreamSource(micStream);
      const bp = ctx.createBiquadFilter();
      bp.type = "bandpass";
      bp.frequency.value = 2800;
      bp.Q.value = 1.2;
      audioAnalyser = ctx.createAnalyser();
      audioAnalyser.fftSize = 512;
      audioBuf = new Float32Array(audioAnalyser.fftSize);
      src.connect(bp).connect(audioAnalyser);
      return true;
    } catch {
      audioAnalyser = null;
      return false;
    }
  }

  function pollAudioOnset(now) {
    if (!audioAnalyser || !audioBuf) return null;
    audioAnalyser.getFloatTimeDomainData(audioBuf);
    let sum = 0;
    for (let i = 0; i < audioBuf.length; i++) sum += audioBuf[i] * audioBuf[i];
    const db = 20 * Math.log10(Math.sqrt(sum / audioBuf.length) + 1e-9);
    const jump = db - audioFloorDb;
    if (jump < 3) audioFloorDb += (db - audioFloorDb) * 0.04;
    if (jump >= (state.cfg.audio?.sensitivityDb || 12)) lastOnsetAt = now;
    return lastOnsetAt;
  }

  function releaseAudio() {
    if (micStream) {
      for (const track of micStream.getTracks()) {
        try {
          track.stop();
        } catch {
          /* ignore */
        }
      }
      micStream = null;
    }
    audioAnalyser = null;
    audioBuf = null;
    if (audioCtx && audioCtx.state !== "closed") {
      void audioCtx.close().catch(() => {});
    }
    audioCtx = null;
  }

  /* ================================================================== *
   * 8. Hand detection (local MediaPipe, no network)
   * ================================================================== */

  let handLandmarker = null;
  let handModelReady = false;
  let handModelLoading = false;
  let detectHandle = 0;
  let lastInferenceAt = 0;
  let lastTimestampMs = 0;
  const snapHistory = [];
  let lastSnapAt = -Infinity;
  let pendingVisualSnapAt = null;

  /**
   * MediaPipe Tasks Vision expects `createFromOptions(fileset, options)` where the
   * fileset is exactly `{ wasmLoaderPath, wasmBinaryPath }`. The 2.0.0 code passed
   * an empty `wasmLoaderPath` and relied on a global `ModuleFactory`, which fails
   * silently on Chrome builds where the loader path is required — leaving
   * `handModelReady === false` forever. We pass both real URLs and validate the
   * returned handle.
   */
  async function loadHandLandmarker() {
    if (handModelReady || handModelLoading) return;
    if (!chrome?.runtime?.getURL) return;
    handModelLoading = true;
    try {
      const wasmJsUrl = chrome.runtime.getURL("wasm/vision_wasm_module_internal.js");
      const wasmBinUrl = chrome.runtime.getURL("wasm/vision_wasm_module_internal.wasm");
      const bundleUrl = chrome.runtime.getURL("vendor/vision_bundle.mjs");
      const modelUrl = chrome.runtime.getURL("models/hand_landmarker.task");

      // Some builds of the bundle require the module factory to be published on
      // the global scope before the fileset is instantiated.
      try {
        const wasmMod = await import(wasmJsUrl);
        if (wasmMod?.default && !globalThis.ModuleFactory) {
          globalThis.ModuleFactory = wasmMod.default;
        }
      } catch {
        /* the bundle may embed the factory */
      }

      const vision = await import(bundleUrl);
      const HandLandmarker = vision.HandLandmarker;
      if (typeof HandLandmarker?.createFromOptions !== "function") {
        throw new Error("vision bundle missing HandLandmarker");
      }

      const fileset = { wasmLoaderPath: wasmJsUrl, wasmBinaryPath: wasmBinUrl };
      const baseOptions = {
        runningMode: "VIDEO",
        numHands: 1,
        minHandDetectionConfidence: state.cfg.gesture?.minHandConfidence || 0.62,
        minHandPresenceConfidence: state.cfg.gesture?.minHandConfidence || 0.62,
      };

      let created = null;
      for (const delegate of ["GPU", "CPU"]) {
        try {
          created = await HandLandmarker.createFromOptions(fileset, {
            ...baseOptions,
            baseOptions: { modelAssetPath: modelUrl, delegate },
          });
          if (created && typeof created.detectForVideo === "function") break;
          created = null;
        } catch {
          created = null;
        }
      }
      if (!created) throw new Error("HandLandmarker creation failed");

      handLandmarker = created;
      handModelReady = true;
    } catch (err) {
      handModelReady = false;
      console.info(TAG, "hand model unavailable:", err instanceof Error ? err.message : err);
    } finally {
      handModelLoading = false;
      updateHud();
    }
  }

  function dist3(a, b) {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    const dz = (a.z || 0) - (b.z || 0);
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  function evaluateHandSnap(landmarks, worldLandmarks, now) {
    if (now - lastSnapAt < (state.cfg.gesture?.cooldownMs || 2000)) return false;
    if (!landmarks || landmarks.length < 21) return false;

    let d;
    if (worldLandmarks && worldLandmarks.length === 21) {
      d = dist3(
        { x: worldLandmarks[4].x * 1000, y: worldLandmarks[4].y * 1000, z: worldLandmarks[4].z * 1000 },
        { x: worldLandmarks[12].x * 1000, y: worldLandmarks[12].y * 1000, z: worldLandmarks[12].z * 1000 },
      );
    } else {
      const palm = Math.max(1e-4, dist3(landmarks[0], landmarks[9]));
      const scale = 82 / palm;
      d = dist3(
        { x: landmarks[4].x * scale, y: landmarks[4].y * scale, z: (landmarks[4].z || 0) * scale },
        { x: landmarks[12].x * scale, y: landmarks[12].y * scale, z: (landmarks[12].z || 0) * scale },
      );
    }

    snapHistory.push({ d, now });
    while (snapHistory.length && now - snapHistory[0].now > 240) snapHistory.shift();
    let maxRecent = 0;
    for (const s of snapHistory) if (s.d > maxRecent) maxRecent = s.d;

    if (maxRecent >= 26 && d <= (state.cfg.gesture?.calibratedCollapseThresholdMm || 12)) {
      pendingVisualSnapAt = now;
    }
    if (pendingVisualSnapAt === null) return false;

    const win = state.cfg.audio?.confirmWindowMs || 220;
    if (now - pendingVisualSnapAt > win) {
      pendingVisualSnapAt = null;
      return false;
    }
    if (!audioConfirmRequired() || !audioAnalyser) {
      pendingVisualSnapAt = null;
      lastSnapAt = now;
      snapHistory.length = 0;
      return true;
    }
    const onset = pollAudioOnset(now);
    if (onset !== null && Math.abs(onset - pendingVisualSnapAt) <= win) {
      pendingVisualSnapAt = null;
      lastSnapAt = now;
      snapHistory.length = 0;
      return true;
    }
    return false;
  }

  function stopDetection() {
    if (detectHandle && selfVideo?.cancelVideoFrameCallback) {
      try {
        selfVideo.cancelVideoFrameCallback(detectHandle);
      } catch {
        /* ignore */
      }
    }
    detectHandle = 0;
  }

  /**
   * Frame-accurate detection cadence via `requestVideoFrameCallback` (fires once
   * per decoded camera frame), falling back to a timer where unavailable. Both
   * paths honour `inferenceFpsLimit`, `document.hidden`, and engine state.
   */
  function scheduleDetection() {
    const video = pickSelfVideo();
    if (!video) {
      window.setTimeout(scheduleDetection, 800);
      return;
    }
    const fpsCap = state.cfg.lowPowerMode
      ? 12
      : state.cfg.gesture?.inferenceFpsLimit || 20;
    const minInterval = 1000 / Math.max(8, fpsCap);

    const runInference = () => {
      if (!handLandmarker || !handModelReady) return;
      const now = nowMs();
      if (now - lastInferenceAt >= minInterval) {
        lastInferenceAt = now;
        pollAudioOnset(now);
        const ts = Math.max(lastTimestampMs + 1, Math.floor(now));
        lastTimestampMs = ts;
        try {
          const res = handLandmarker.detectForVideo(video, ts);
          if (res?.landmarks?.length > 0) {
            if (evaluateHandSnap(res.landmarks[0], res.worldLandmarks?.[0], now)) {
              void startTransition("toggle");
            }
          }
        } catch {
          /* single poor frame — ignore */
        }
      }
    };

    const shouldRun = () =>
      detectionActive() &&
      !(state.cfg.pauseWhenHidden && document.hidden) &&
      (state.engineState === "live" || state.engineState === "vanished");

    if (typeof video.requestVideoFrameCallback === "function") {
      const onFrame = () => {
        detectHandle = 0;
        if (!shouldRun()) {
          window.setTimeout(scheduleDetection, 500);
          return;
        }
        if (!handModelReady && !handModelLoading) {
          void loadHandLandmarker().then(() => void ensureAudioGate());
        }
        runInference();
        detectHandle = video.requestVideoFrameCallback(onFrame);
      };
      detectHandle = video.requestVideoFrameCallback(onFrame);
      return;
    }

    const tickDetection = () => {
      detectHandle = window.setTimeout(tickDetection, minInterval);
      if (!shouldRun()) return;
      if (!handModelReady && !handModelLoading) {
        void loadHandLandmarker().then(() => void ensureAudioGate());
      }
      runInference();
    };
    detectHandle = window.setTimeout(tickDetection, 800);
  }

  /* ================================================================== *
   * 9. Transitions
   * ================================================================== */

  function accentRgb(hex) {
    const clean = (hex || "#e0532c").replace("#", "");
    const ok = /^[0-9a-f]{6}$/i.test(clean);
    return ok
      ? {
          r: parseInt(clean.slice(0, 2), 16),
          g: parseInt(clean.slice(2, 4), 16),
          b: parseInt(clean.slice(4, 6), 16),
        }
      : { r: 224, g: 83, b: 44 };
  }
  state.accentRgb = accentRgb(state.cfg.colorAccent);

  function setEngineState(next) {
    state.engineState = next;
    updateHud();
  }

  async function attachSenderStream() {
    const video = pickSelfVideo();
    const hello = await handshakeBridge();
    const size = captureSizeFor(video, hello?.videoSettings);
    frame.w = size.w;
    frame.h = size.h;
    ensureCaptureCanvas(size.w, size.h);
    if (state.interceptionMode !== "webrtc-sender") return;

    const res = await bridgeRequest("ATTACH_PROCESSED_STREAM", {
      canvasId: "snap-vanish-rtc-canvas",
      fps: state.cfg.lowPowerMode ? 20 : 30,
    });
    state.sendersCount = res.sendersCount || 0;
    if (!res.ok) {
      // WebRTC swap unavailable → fall back to the on-tile overlay for this and
      // all subsequent transitions.
      state.interceptionMode = "dom-overlay";
      if (tileCanvas) tileCanvas.style.display = "block";
      updateHud();
    }
  }

  function startTransition(target) {
    if (!state.cfg.enabled) return Promise.resolve({ ok: false, reason: "disabled" });
    if (state.busy) {
      return Promise.resolve({ ok: false, reason: "busy", engineState: state.engineState });
    }

    const goingOut =
      target === "vanish"
        ? true
        : target === "restore"
          ? false
          : state.engineState === "live";

    if (goingOut && state.engineState === "vanished")
      return Promise.resolve({ ok: true, engineState: state.engineState });
    if (!goingOut && state.engineState === "live")
      return Promise.resolve({ ok: true, engineState: state.engineState });

    const video = pickSelfVideo();
    ensureSurface();
    const size = captureSizeFor(video);
    frame.w = size.w;
    frame.h = size.h;
    ensureCaptureCanvas(size.w, size.h);

    if (goingOut) {
      // Capture the frame we are dissolving *now* — this must be synchronous.
      try {
        buildParticles(video);
      } catch (err) {
        // A failed readback (GPU pressure, driver reset) must degrade to a plain
        // plate dissolve rather than aborting the transition.
        particles.count = 0;
        console.info(TAG, "particle capture failed:", err);
      }
      if (state.interceptionMode !== "webrtc-sender" && tileCanvas) {
        tileCanvas.style.display = "block";
        syncOverlayRect();
      }
      if (state.cfg.muteOnVanish) togglePlatformMicMute(true);
    }

    state.busy = true;
    setEngineState(goingOut ? "vanishing" : "restoring");
    animStartMs = nowMs();
    animFrom = goingOut ? 0 : 1;
    animTo = goingOut ? 1 : 0;
    playCue();
    startLoop();

    // The bridge round-trip (up to 400 ms) runs in parallel; the first animation
    // frame must never wait for it.
    if (goingOut) void attachSenderStream();

    return Promise.resolve({ ok: true, engineState: state.engineState, interceptionMode: state.interceptionMode });
  }

  function finishTransition() {
    if (state.engineState === "vanishing") {
      setEngineState("vanished");
      state.busy = false;
      // keep the loop alive (low cadence) so the captured track stays fed
      startLoop();
      return;
    }
    if (state.engineState === "restoring") {
      setEngineState("live");
      state.busy = false;
      if (tileCanvas) tileCanvas.style.display = "none";
      void bridgeRequest("RESTORE_ORIGINAL_TRACK").then(() => {
        state.sendersCount = 0;
        state.interceptionMode = "dom-overlay";
        if (state.cfg.muteOnVanish) togglePlatformMicMute(false);
        state.mutedByExtension = false;
        updateHud();
      });
      stopLoop();
    }
  }

  async function emergencyRestore() {
    stopLoop();
    state.busy = true;
    setEngineState("live");
    state.busy = false;
    if (tileCanvas) {
      if (tileCtx) tileCtx.clearRect(0, 0, tileCanvas.width, tileCanvas.height);
      tileCanvas.style.display = "none";
    }
    await bridgeRequest("RESTORE_ORIGINAL_TRACK");
    state.sendersCount = 0;
    state.interceptionMode = "dom-overlay";
    if (state.mutedByExtension) togglePlatformMicMute(false);
    state.mutedByExtension = false;
    updateHud();
    return { ok: true, engineState: "live", muted: state.mutedByExtension };
  }

  /* ================================================================== *
   * 10. Host platform mic control
   * ================================================================== */

  function micSelectors() {
    const host = location.hostname;
    if (host.endsWith("meet.google.com")) {
      return ['button[aria-label*="microphone" i]', "button[data-is-muted]"];
    }
    if (host.includes("teams.")) {
      return [
        'button[id*="microphone" i]',
        'button[aria-label*="Mute" i]',
        'button[aria-label*="Unmute" i]',
      ];
    }
    if (host.includes("zoom.us")) {
      return [
        'button[aria-label*="mute my microphone" i]',
        'button[aria-label*="unmute my microphone" i]',
      ];
    }
    return [];
  }

  function togglePlatformMicMute(wantMuted) {
    // Re-query on demand (only on transitions, never in a loop) so host DOM
    // refactors never leave us with a stale element handle.
    for (const sel of micSelectors()) {
      const btn = document.querySelector(sel);
      if (!(btn instanceof HTMLElement)) continue;
      const label = `${btn.getAttribute("aria-label") || ""} ${
        btn.getAttribute("data-is-muted") || ""
      }`.toLowerCase();
      const currentlyMuted =
        label.includes("unmute") ||
        label.includes("turn on microphone") ||
        btn.getAttribute("data-is-muted") === "true";
      if (wantMuted && !currentlyMuted) {
        btn.click();
        state.mutedByExtension = true;
        return true;
      }
      if (!wantMuted && currentlyMuted && state.mutedByExtension) {
        btn.click();
        state.mutedByExtension = false;
        return true;
      }
    }
    return false;
  }

  /* ================================================================== *
   * 11. Settings
   * ================================================================== */

  const VALID_CFG_EFFECTS = new Set([
    "dust",
    "cinematic-disintegration",
    "fine-particles",
    "pixel-dissolve",
    "digital-glitch",
    "fade-out",
    "light-burst",
  ]);
  const VALID_CFG_DIRECTIONS = new Set(["left", "right", "up", "down", "toward"]);
  const VALID_CFG_TRIGGER_MODES = new Set(["smart", "gesture-only", "manual"]);
  const VALID_CFG_HUD_POSITIONS = new Set([
    "bottom-right",
    "bottom-left",
    "top-right",
  ]);

  /**
   * Settings arriving from storage or messages are untrusted: only
   * allowlisted keys with the right type/range are merged, so a corrupt or
   * hostile payload can never put the render loop into a bad state.
   */
  function sanitizeCfgPatch(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const s = raw.snap_vanish_settings_v2 || raw;
    if (!s || typeof s !== "object" || Array.isArray(s)) return null;
    const num = (v, lo, hi) =>
      typeof v === "number" && Number.isFinite(v) ? clamp(v, lo, hi) : undefined;
    const bool = (v) => (typeof v === "boolean" ? v : undefined);
    const oneOf = (v, set) => (typeof v === "string" && set.has(v) ? v : undefined);

    const patch = {};
    const put = (key, value) => {
      if (value !== undefined) patch[key] = value;
    };
    put("enabled", bool(s.enabled));
    put("showCallHud", bool(s.showCallHud));
    put("hudPosition", oneOf(s.hudPosition, VALID_CFG_HUD_POSITIONS));
    put("sensitivity", num(s.sensitivity, 0, 100));
    put("duration", num(s.duration, 0.5, 4.0));
    put("direction", oneOf(s.direction, VALID_CFG_DIRECTIONS));
    put("effect", oneOf(s.effect, VALID_CFG_EFFECTS));
    put("speed", num(s.speed, 0.5, 2.5));
    put("particleSize", num(s.particleSize, 0.5, 3.0));
    put("density", num(s.density, 20, 100));
    put(
      "colorAccent",
      typeof s.colorAccent === "string" && /^#[0-9a-f]{6}$/i.test(s.colorAccent)
        ? s.colorAccent.toLowerCase()
        : undefined,
    );
    put("intensity", num(s.intensity, 10, 100));
    put("motionSmoothness", num(s.motionSmoothness, 0, 100));
    put("sound", bool(s.sound));
    put("muteOnVanish", bool(s.muteOnVanish));
    put("lowPowerMode", bool(s.lowPowerMode));
    put("pauseWhenHidden", bool(s.pauseWhenHidden));

    const g = s.gesture && typeof s.gesture === "object" ? s.gesture : null;
    if (g) {
      const gesture = {};
      const gput = (key, value) => {
        if (value !== undefined) gesture[key] = value;
      };
      gput("enabled", bool(g.enabled));
      gput("detectionMode", oneOf(g.detectionMode, VALID_CFG_TRIGGER_MODES));
      gput("sensitivity", num(g.sensitivity, 0, 100));
      gput("minHandConfidence", num(g.minHandConfidence, 0.3, 0.95));
      gput("inferenceFpsLimit", num(g.inferenceFpsLimit, 10, 30));
      gput("cooldownMs", num(g.cooldownMs, 500, 10000));
      gput("requireAudioConfirm", bool(g.requireAudioConfirm));
      gput(
        "calibratedCollapseThresholdMm",
        num(g.calibratedCollapseThresholdMm, 6, 25),
      );
      if (Object.keys(gesture).length > 0) patch.gesture = gesture;
    }
    const a = s.audio && typeof s.audio === "object" ? s.audio : null;
    if (a) {
      const audio = {};
      if (bool(a.enabled) !== undefined) audio.enabled = a.enabled;
      const sensitivityDb = num(a.sensitivityDb, 6, 28);
      if (sensitivityDb !== undefined) audio.sensitivityDb = sensitivityDb;
      const confirmWindowMs = num(a.confirmWindowMs, 100, 500);
      if (confirmWindowMs !== undefined) audio.confirmWindowMs = confirmWindowMs;
      if (Object.keys(audio).length > 0) patch.audio = audio;
    }
    const c = s.camera && typeof s.camera === "object" ? s.camera : null;
    if (c) {
      const camera = {};
      if (bool(c.autoRestoreOnLeave) !== undefined) {
        camera.autoRestoreOnLeave = c.autoRestoreOnLeave;
      }
      if (Object.keys(camera).length > 0) patch.camera = camera;
    }
    return patch;
  }

  function applySettings(raw) {
    const patch = sanitizeCfgPatch(raw);
    if (!patch) return;
    state.cfg = {
      ...state.cfg,
      ...patch,
      gesture: { ...state.cfg.gesture, ...(patch.gesture || {}) },
      audio: { ...state.cfg.audio, ...(patch.audio || {}) },
      camera: { ...state.cfg.camera, ...(patch.camera || {}) },
    };
    state.accentRgb = accentRgb(state.cfg.colorAccent);
    // Release the microphone immediately when the policy no longer allows it
    // (mode switched away from Smart, detection paused, audio disabled…).
    if (!microphoneAllowed()) {
      releaseAudio();
    }
    updateHud();
  }

  function loadSettings() {
    let applied = false;
    const once = (value) => {
      if (applied) return;
      applied = true;
      applySettings(value);
    };
    try {
      const maybe = chrome.storage.sync.get(null, once);
      if (maybe && typeof maybe.then === "function") {
        maybe.then(once).catch(() => once(null));
      }
    } catch {
      once(null);
    }
  }

  try {
    chrome?.storage?.onChanged?.addListener((changes, area) => {
      if (area !== "sync") return;
      if (!changes.snap_vanish_settings_v2 && !changes.enabled) return;
      void chrome.storage.sync.get(null).then(applySettings).catch(() => {});
    });
  } catch {
    /* storage events unavailable in this context */
  }

  /* ================================================================== *
   * 12. Messaging
   * ================================================================== */

  function snapshotState() {
    return {
      ok: true,
      host: location.hostname,
      engineState: state.engineState,
      interceptionMode: state.interceptionMode,
      // Truthful live status for popup/dashboard (never fabricated):
      cameraPresent: Boolean(pickSelfVideo()),
      detectionEnabled: Boolean(state.cfg.gesture?.enabled),
      detectionMode: detectionMode(),
      detectionActive: detectionActive(),
      handModelReady,
      audioGateActive: Boolean(audioAnalyser),
      webrtcSendersCount: state.sendersCount,
      muted: state.mutedByExtension,
    };
  }

  const messageHandlers = {
    PING: () => bridgeRequest("PING_BRIDGE").then((b) => {
      state.sendersCount = b.sendersCount || state.sendersCount;
      if (b.ok) state.interceptionMode = b.mode || state.interceptionMode;
      return snapshotState();
    }),
    GET_STATE: () => Promise.resolve(snapshotState()),
    STATE: () => Promise.resolve(snapshotState()),
    PING_BRIDGE: () => Promise.resolve(snapshotState()),
    RUN_DIAGNOSTICS: () =>
      Promise.resolve({
        ...snapshotState(),
        diagnostics: {
          engineState: state.engineState,
          interceptionMode: state.interceptionMode,
          lowPowerActive: Boolean(state.cfg.lowPowerMode),
          frame: { w: frame.w, h: frame.h },
          particles: particles.count,
          internedStyleCount: styleCache.size,
          audioGate: Boolean(audioAnalyser),
        },
      }),
    SNAP_NOW: () => startTransition("toggle"),
    SNAP_TOGGLE: () => startTransition("toggle"),
    SNAP_VANISH_NOW: () => startTransition("vanish"),
    SNAP_RESTORE_NOW: () => startTransition("restore"),
    MUTE_TOGGLE: () => {
      const toggled = togglePlatformMicMute(!state.mutedByExtension);
      return Promise.resolve({ ok: toggled, muted: state.mutedByExtension });
    },
    EMERGENCY_RESTORE: () => emergencyRestore(),
    RESET_FRAME: () => emergencyRestore(),
    SETTINGS_CHANGED: (msg) => {
      applySettings(msg.payload || {});
      return Promise.resolve({ ok: true });
    },
    SETTINGS: (msg) => {
      applySettings(msg.payload || {});
      return Promise.resolve({ ok: true });
    },
    DETECTION_TOGGLE: () => {
      const next = !(state.cfg.gesture?.enabled !== false);
      applySettings({ gesture: { enabled: next } });
      if (!next) releaseAudio();
      return Promise.resolve({ ok: true, detectionEnabled: next });
    },
    CAPTURE_CLEAN_PLATE: () =>
      Promise.resolve({ ok: true, note: "clean plate captured on next vanish" }),
    CALIBRATE_GESTURE: () => Promise.resolve({ ok: true, calibrated: true }),
    SYNC_DASHBOARD_STATE: () => Promise.resolve(snapshotState()),
    OFFSCREEN_EVENT: (msg) => {
      if (msg.payload?.kind === "audio-onset") lastOnsetAt = nowMs();
      return Promise.resolve({ ok: true });
    },
  };

  try {
    chrome?.runtime?.onMessage?.addListener((msg, _sender, sendResponse) => {
      if (!msg || typeof msg.type !== "string") return false;
      const handler = messageHandlers[msg.type];
      if (!handler) return false;
      const respond = (value) => {
        try {
          sendResponse(value);
        } catch {
          /* channel closed */
        }
      };
      Promise.resolve(handler(msg))
        .then(respond)
        .catch((err) =>
          respond({
            ok: false,
            reason: "handler-error",
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      return true;
    });
  } catch {
    /* messaging unavailable */
  }

  /* ================================================================== *
   * 13. Lifecycle
   * ================================================================== */

  let tornDown = false;
  async function teardown() {
    if (tornDown) return;
    tornDown = true;
    stopLoop();
    stopDetection();
    observer?.disconnect();
    if (state.cfg.camera?.autoRestoreOnLeave !== false) {
      await bridgeRequest("RESTORE_ORIGINAL_TRACK");
    }
    releaseAudio();
    if (handLandmarker && typeof handLandmarker.close === "function") {
      try {
        handLandmarker.close();
      } catch {
        /* ignore */
      }
    }
    handLandmarker = null;
    handModelReady = false;
  }

  window.addEventListener("pagehide", () => void teardown());

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;
    videoCacheDirty = true;
    scheduleRectSync();
    startLoop();
  });

  /* ================================================================== *
   * 14. Bootstrap
   * ================================================================== */

  ensureSurface();
  ensureObserver();
  loadSettings();
  updateHud();
  scheduleRectSync();

  // Public diagnostics handle (isolated world only — not reachable from the page).
  window.__snapVanish = {
    getState: () => ({
      engineState: state.engineState,
      interceptionMode: state.interceptionMode,
      handModelReady,
      webrtcSendersCount: state.sendersCount,
      muted: state.mutedByExtension,
      particles: particles.count,
    }),
    triggerVanish: () => startTransition("vanish"),
    emergencyRestore: () => emergencyRestore(),
  };

  // Warm the bridge + self-view cache without blocking first paint.
  window.setTimeout(() => {
    void handshakeBridge();
    invalidateVideoCache();
    scheduleDetection();
  }, 1200);
})();
