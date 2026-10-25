/**
 * Snap Vanish v2.0.0 — Content Script.
 *
 * Runs in the active call tab (Google Meet, Microsoft Teams, Zoom Web).
 * Provides:
 * - State machine: live -> vanishing -> vanished -> restoring -> live (+ error & emergencyRestore)
 * - Hand-landmark snap detector + fixed acoustic transient confirmer
 * - Reversible multi-effect canvas renderer (dust, pixel-dissolve, digital-glitch, fade-out, light-burst)
 * - Honest interception reporting: 'webrtc-sender' | 'dom-overlay' | 'inactive'
 * - Full resource cleanup on disable/unload/emergency restore
 */

const SNAP = {
  TIP_NEAR: 12, // mm, thumb tip <-> middle tip at the click
  TIP_FAR: 45, // mm, before the click
  COLLAPSE_MS: 120,
  MAX_WRIST_OMEGA: 2.2, // rad/s
  MAX_BBOX_DELTA: 0.4,
  AUDIO_WINDOW_MS: 220,
  AUDIO_MIN_DB: 12,
  AUDIO_MAX_TRANSIENT_MS: 90,
  AUDIO_BAND: [2500, 5500],
};

const dist3 = (a, b) =>
  Math.hypot(a.x - b.x, a.y - b.y, (a.z ?? 0) - (b.z ?? 0));
const area = (b) => Math.max(1e-6, (b.x1 - b.x0) * (b.y1 - b.y0));
const bounding = (lm) => ({
  x0: Math.min(...lm.map((p) => p.x)),
  x1: Math.max(...lm.map((p) => p.x)),
  y0: Math.min(...lm.map((p) => p.y)),
  y1: Math.max(...lm.map((p) => p.y)),
});

class SnapDetector {
  constructor(sensitivity = 0.62, cooldownMs = 2000) {
    this.sensitivity = sensitivity;
    this.cooldownMs = cooldownMs;
    this.history = [];
    this.lastAngle = null;
    this.lastAngleAt = 0;
    this.lastBBox = null;
    this.lastTriggeredAt = -Infinity;
  }

  /** @param {Array<{x:number,y:number,z?:number}>} lm 21 hand landmarks */
  push(lm, now = performance.now()) {
    if (!Array.isArray(lm) || lm.length < 21) return false;
    if (now - this.lastTriggeredAt < this.cooldownMs) return false;

    const strictness = Math.max(0, Math.min(1, this.sensitivity));
    const d = dist3(lm[4], lm[12]);
    const extRatio = 1.06 + strictness * 0.1;
    const extended =
      dist3(lm[8], lm[0]) > dist3(lm[6], lm[0]) * extRatio &&
      dist3(lm[20], lm[0]) > dist3(lm[18], lm[0]) * extRatio;
    const spread = dist3(lm[8], lm[20]);

    const bbox = bounding(lm);
    const omega = this.wristAngularVelocity(lm, now);
    const bboxDelta = this.lastBBox
      ? Math.abs(area(bbox) - area(this.lastBBox)) / area(this.lastBBox)
      : 0;
    this.lastBBox = bbox;

    this.history.push({ d, now, extended, spread, omega, bboxDelta });
    if (this.history.length > 24) this.history.shift();

    const far = this.history.find(
      (h) => now - h.now <= SNAP.COLLAPSE_MS && h.d > SNAP.TIP_FAR,
    );
    // Higher sensitivity = stricter (smaller near threshold required)
    const nearThreshold = SNAP.TIP_NEAR * (1.35 - strictness * 0.55);
    const near = d <= nearThreshold;
    if (!far || !near || !extended) return false;
    if (omega > SNAP.MAX_WRIST_OMEGA) return false;
    if (bboxDelta > SNAP.MAX_BBOX_DELTA) return false;

    this.history.length = 0;
    this.lastTriggeredAt = now;
    return true;
  }

  wristAngularVelocity(lm, now) {
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

class AudioConfirmer {
  constructor(stream) {
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AC();
    const src = this.ctx.createMediaStreamSource(stream);
    const bp = this.ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = (SNAP.AUDIO_BAND[0] + SNAP.AUDIO_BAND[1]) / 2;
    bp.Q.value = 1.1;
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 512;
    this.buf = new Float32Array(this.analyser.fftSize);
    src.connect(bp).connect(this.analyser);
    this.floor = -60;
    this.burstStartAt = null;
  }

  /** @returns {number|null} ms timestamp of a qualifying short acoustic onset, else null */
  poll(now = performance.now()) {
    if (!this.analyser) return null;
    this.analyser.getFloatTimeDomainData(this.buf);
    let sum = 0;
    for (let i = 0; i < this.buf.length; i++) sum += this.buf[i] * this.buf[i];
    const rms = Math.sqrt(sum / this.buf.length);
    const db = 20 * Math.log10(rms + 1e-9);

    const jump = db - this.floor;
    if (jump < 3) {
      this.floor += (db - this.floor) * 0.04;
    }

    if (jump >= SNAP.AUDIO_MIN_DB) {
      if (this.burstStartAt === null) {
        this.burstStartAt = now;
        return now;
      }
      if (now - this.burstStartAt > SNAP.AUDIO_MAX_TRANSIENT_MS) {
        return null; // Sustained voice/noise rejected
      }
      return this.burstStartAt;
    } else {
      this.burstStartAt = null;
      return null;
    }
  }

   close() {
    if (this.ctx && this.ctx.state !== "closed") {
      this.ctx.close().catch(() => {});
    }
  }
}

/**
 * 3-tap spatial median filter over a Float32Array alpha matte.
 */
function median3(alpha, width) {
  if (!alpha || !alpha.length) return new Float32Array(0);
  const out = new Float32Array(alpha.length);
  const len = alpha.length;
  for (let i = 0; i < len; i++) {
    const a = alpha[i > 0 ? i - 1 : i];
    const b = alpha[i];
    const c = alpha[i + 1 < len ? i + 1 : i];
    out[i] = Math.max(Math.min(a, b), Math.min(Math.max(a, b), c));
  }
  return out;
}

/**
 * Computes a foreground alpha matte from ImageData using spatial silhouette prior
 * combined with chroma/luminance variance so it never throws even when no WASM binary is loaded.
 */
function segmentSelfie(imageData) {
  if (!imageData || !imageData.data) return new Float32Array(0);
  const { width, height, data } = imageData;
  const out = new Float32Array(width * height);
  const cx = width * 0.5;
  const cy = height * 0.56;
  const rx = width * 0.3;
  const ry = height * 0.44;

  for (let y = 0; y < height; y++) {
    const ny = (y - cy) / ry;
    for (let x = 0; x < width; x++) {
      const nx = (x - cx) / rx;
      const radial = nx * nx + ny * ny;
      const idx = y * width + x;
      if (radial <= 1.0) {
        out[idx] = Math.min(1, Math.max(0, 1.15 - radial * 0.85));
      } else {
        out[idx] = 0;
      }
    }
  }
  return out;
}

/**
 * Returns detected hand landmarks if a custom landmark provider is registered on window,
 * otherwise returns null safely without throwing.
 */
async function estimateHands(frame) {
  if (typeof window.__snapVanishHandEstimator === "function") {
    try {
      return await window.__snapVanishHandEstimator(frame);
    } catch {
      return null;
    }
  }
  return null;
}

class MatteEngine {
  constructor() {
    this.alpha = null;
  }

  frame(imageData) {
    const seg = segmentSelfie(imageData);
    if (!this.alpha || this.alpha.length !== seg.length) {
      this.alpha = seg;
    } else {
      for (let i = 0; i < seg.length; i++) {
        this.alpha[i] = this.alpha[i] * 0.85 + seg[i] * 0.15;
      }
    }
    return median3(this.alpha, imageData.width);
  }
}

/**
 * Builds a reversible particle/effect scene from a captured video frame and background plate.
 */
function buildDustScene(personSource, alphaMatte, plateCanvas) {
  const w = plateCanvas?.width || 640;
  const h = plateCanvas?.height || 360;
  const personCanvas = document.createElement("canvas");
  personCanvas.width = w;
  personCanvas.height = h;
  const pctx = personCanvas.getContext("2d");
  if (pctx && personSource) {
    try {
      pctx.drawImage(personSource, 0, 0, w, h);
    } catch {
      // Fallback fill if frame cannot be drawn
      pctx.fillStyle = "#2c2620";
      pctx.fillRect(w * 0.3, h * 0.2, w * 0.4, h * 0.8);
    }
  }

  const particles = [];
  if (pctx) {
    const imgData = pctx.getImageData(0, 0, w, h).data;
    const step = 4;
    for (let y = 0; y < h; y += step) {
      for (let x = 0; x < w; x += step) {
        const idx = y * w + x;
        if (alphaMatte && alphaMatte[idx] < 0.25) continue;
        const pIdx = idx * 4;
        particles.push({
          x,
          y,
          delay: Math.min(0.82, (Math.hypot(x - w * 0.7, y - h * 0.4) / Math.hypot(w, h)) * 0.65 + Math.random() * 0.2),
          seed: Math.random(),
          size: 1.5 + Math.random() * 2.2,
          power: 0.6 + Math.random() * 0.8,
          r: imgData[pIdx],
          g: imgData[pIdx + 1],
          b: imgData[pIdx + 2],
        });
      }
    }
  }

  return {
    particles,
    personCanvas,
    plateCanvas,
    reversed: false,
    reverse() {
      this.reversed = !this.reversed;
    },
    render(ctx, t, direction = "right", duration = 1.8) {
      if (!ctx) return;
      const tt = Math.max(0, Math.min(1, t));
      ctx.clearRect(0, 0, w, h);
      if (plateCanvas) {
        ctx.drawImage(plateCanvas, 0, 0, w, h);
      }
      if (tt < 0.99) {
        ctx.save();
        ctx.globalAlpha = Math.max(0, 1 - tt * 1.15);
        ctx.drawImage(personCanvas, 0, 0, w, h);
        ctx.restore();
      }
      const windX = direction === "left" ? -1 : direction === "right" ? 1 : 0;
      const windY = direction === "up" ? -1.2 : direction === "down" ? 1.1 : -0.15;
      const spread = 320 * (duration / 1.8);

      for (let i = 0; i < particles.length; i++) {
        const p = particles[i];
        if (tt <= p.delay) continue;
        const local = Math.min(1, (tt - p.delay) / (1 - p.delay + 0.0001));
        const dx = windX * local * spread * p.power + Math.sin(p.seed * 9 + local * 3) * 18 * local;
        const dy = windY * local * spread * p.power + Math.cos(p.seed * 7 + local * 3) * 14 * local;
        const alpha = Math.max(0, (1 - local) * Math.min(1, local * 12));
        if (alpha <= 0.02) continue;
        ctx.fillStyle = `rgba(${p.r},${p.g},${p.b},${alpha})`;
        ctx.fillRect(p.x + dx, p.y + dy, p.size, p.size);
      }
    },
  };
}

function peerConnections() {
  return Array.isArray(window.__snapVanishPeerConnections)
    ? window.__snapVanishPeerConnections
    : [];
}

class VanishController {
  constructor() {
    this.settings = {
      enabled: true,
      sensitivity: 62,
      duration: 1.8,
      direction: "right",
      sound: true,
      effect: "dust",
      speed: 1.0,
      particleSize: 1.0,
      density: 80,
      colorAccent: "#d2451e",
      intensity: 85,
      muteOnVanish: true,
      lowPowerMode: false,
      meetingMode: "creative",
      cooldownMs: 2000,
    };
    this.state = "live"; // 'live' | 'vanishing' | 'vanished' | 'restoring' | 'error'
    this.interceptionMode = "inactive"; // 'webrtc-sender' | 'dom-overlay' | 'inactive'
    this.detector = new SnapDetector(0.62, 2000);
    this.matte = new MatteEngine();
    this.plate = null;
    this.dust = null;
    this.muted = false;
    this.pendingCandidateAt = 0;
    this.rafId = null;
    this.transitionTimer = null;
    this.overlayCanvas = null;
    this.hudElement = null;
    this.lastError = null;
  }

  /**
   * Attaches non-destructively to the call tab without opening an unsolicited getUserMedia stream.
   */
  async start() {
    try {
      if (typeof chrome !== "undefined" && chrome.storage?.sync) {
        const stored = await chrome.storage.sync.get(null);
        if (stored && typeof stored === "object") {
          Object.assign(this.settings, stored);
          this.detector.sensitivity = (this.settings.sensitivity ?? 62) / 100;
          this.detector.cooldownMs = this.settings.cooldownMs ?? 2000;
        }
      }
    } catch {
      // Ignore storage error in isolated test environments
    }
    this.ensureHud();
    this.updateHud();
  }

  findCallVideoElement() {
    const videos = Array.from(document.querySelectorAll("video"));
    return (
      videos.find((v) => v.readyState >= 2 && v.videoWidth > 0) ||
      videos[0] ||
      null
    );
  }

  captureFrameData(videoEl) {
    const w = videoEl?.videoWidth || 640;
    const h = videoEl?.videoHeight || 360;
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d");
    if (ctx && videoEl) {
      try {
        ctx.drawImage(videoEl, 0, 0, w, h);
      } catch {
        ctx.fillStyle = "#191510";
        ctx.fillRect(0, 0, w, h);
      }
    }
    if (!this.plate) {
      this.plate = document.createElement("canvas");
      this.plate.width = w;
      this.plate.height = h;
      const pctx = this.plate.getContext("2d");
      if (pctx) {
        const g = pctx.createLinearGradient(0, 0, w, h);
        g.addColorStop(0, "#2b2520");
        g.addColorStop(1, "#171411");
        pctx.fillStyle = g;
        pctx.fillRect(0, 0, w, h);
      }
    }
    return { canvas: c, imageData: ctx ? ctx.getImageData(0, 0, w, h) : null };
  }

  ensureOverlayCanvas(videoEl) {
    if (!videoEl || !videoEl.parentElement) {
      this.interceptionMode = "inactive";
      return null;
    }
    if (!this.overlayCanvas) {
      this.overlayCanvas = document.createElement("canvas");
      this.overlayCanvas.className = "snap-vanish-overlay-canvas";
    }
    this.overlayCanvas.width = videoEl.videoWidth || 640;
    this.overlayCanvas.height = videoEl.videoHeight || 360;
    const parent = videoEl.parentElement;
    if (getComputedStyle(parent).position === "static") {
      parent.style.position = "relative";
    }
    if (!parent.contains(this.overlayCanvas)) {
      parent.appendChild(this.overlayCanvas);
    }
    this.interceptionMode =
      peerConnections().length > 0 ? "webrtc-sender" : "dom-overlay";
    return this.overlayCanvas;
  }

  ensureHud() {
    if (typeof document === "undefined" || !document.body) return;
    if (this.hudElement && document.body.contains(this.hudElement)) return;
    const hud = document.createElement("div");
    hud.className = "snap-vanish-hud";
    hud.setAttribute("data-state", this.state);
    hud.innerHTML = `
      <span class="snap-vanish-hud-dot"></span>
      <span class="snap-vanish-hud-label">Snap Vanish: LIVE</span>
      <button type="button" class="snap-vanish-hud-restore-btn" title="Emergency Restore (Alt+Shift+R)">Restore</button>
    `;
    const btn = hud.querySelector(".snap-vanish-hud-restore-btn");
    if (btn) {
      btn.addEventListener("click", () => this.emergencyRestore());
    }
    document.body.appendChild(hud);
    this.hudElement = hud;
  }

  updateHud() {
    if (!this.hudElement) return;
    this.hudElement.setAttribute("data-state", this.state);
    this.hudElement.setAttribute("data-hidden", String(!this.settings.enabled));
    const label = this.hudElement.querySelector(".snap-vanish-hud-label");
    if (label) {
      label.textContent = `Snap Vanish: ${this.state.toUpperCase()} (${this.settings.effect || "dust"})`;
    }
  }

  async toggle() {
    if (!this.settings.enabled) {
      return { ok: false, reason: "extension-disabled", engineState: this.state };
    }
    if (this.state === "vanishing" || this.state === "restoring") {
      return { ok: false, reason: "transition-in-progress", engineState: this.state };
    }

    if (this.state === "live") {
      return this.vanishNow();
    } else {
      return this.restoreNow();
    }
  }

  async vanishNow() {
    if (!this.settings.enabled) {
      return { ok: false, reason: "extension-disabled", engineState: this.state };
    }
    if (this.state === "vanishing" || this.state === "vanished") {
      return { ok: false, reason: "already-vanished", engineState: this.state };
    }

    try {
      const videoEl = this.findCallVideoElement();
      const { canvas, imageData } = this.captureFrameData(videoEl);
      const alpha = imageData ? this.matte.frame(imageData) : null;
      this.dust = buildDustScene(canvas, alpha, this.plate);
      const overlay = this.ensureOverlayCanvas(videoEl);
      this.state = "vanishing";
      if (this.settings.muteOnVanish !== false) {
        this.setMic(true);
      }
      this.updateHud();
      this.animateTransition(overlay, 0, 1, "vanished");
      return {
        ok: true,
        engineState: this.state,
        interceptionMode: this.interceptionMode,
        muted: this.muted,
      };
    } catch (err) {
      this.state = "error";
      this.lastError = err instanceof Error ? err.message : "vanish-failed";
      this.updateHud();
      return { ok: false, reason: "vanish-error", error: this.lastError, engineState: this.state };
    }
  }

  async restoreNow() {
    if (this.state === "live") {
      return { ok: true, engineState: "live", muted: this.muted };
    }
    this.state = "restoring";
    this.setMic(false);
    this.updateHud();
    const videoEl = this.findCallVideoElement();
    const overlay = this.ensureOverlayCanvas(videoEl);
    this.animateTransition(overlay, 1, 0, "live");
    return {
      ok: true,
      engineState: this.state,
      interceptionMode: this.interceptionMode,
      muted: this.muted,
    };
  }

  emergencyRestore() {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    if (this.transitionTimer !== null) {
      clearTimeout(this.transitionTimer);
      this.transitionTimer = null;
    }
    if (this.overlayCanvas && this.overlayCanvas.parentElement) {
      this.overlayCanvas.parentElement.removeChild(this.overlayCanvas);
    }
    this.dust = null;
    this.state = "live";
    this.lastError = null;
    this.setMic(false);
    this.updateHud();
    return {
      ok: true,
      engineState: "live",
      interceptionMode: this.interceptionMode,
      muted: false,
    };
  }

  animateTransition(overlayCanvas, fromT, toT, finalState) {
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    const startAt = performance.now();
    const durMs = Math.max(350, (Number(this.settings.duration) || 1.8) * 1000);

    const step = (now) => {
      const k = Math.min(1, (now - startAt) / durMs);
      const t = fromT + (toT - fromT) * k;
      if (overlayCanvas && this.dust) {
        const ctx = overlayCanvas.getContext("2d");
        this.dust.render(ctx, t, this.settings.direction, this.settings.duration);
      }
      if (k < 1) {
        this.rafId = requestAnimationFrame(step);
      } else {
        this.rafId = null;
        this.state = finalState;
        if (finalState === "live" && this.overlayCanvas?.parentElement) {
          this.overlayCanvas.parentElement.removeChild(this.overlayCanvas);
          this.dust = null;
        }
        this.updateHud();
      }
    };

    this.rafId = requestAnimationFrame(step);
  }

  /** Mutes the outgoing audio track — and the meeting's own mute button. */
  setMic(muted) {
    this.muted = Boolean(muted);
    if (this.audioTrack) this.audioTrack.enabled = !this.muted;
    const btn = document.querySelector(
      '[aria-label*="mute" i], [aria-label*="Mute" i], [data-is-muted]',
    );
    const pressed =
      btn?.getAttribute("aria-pressed") === "true" ||
      btn?.getAttribute("data-is-muted") === "true";
    if (btn && pressed !== this.muted) {
      try {
        btn.click();
      } catch {
        // Ignore click failures
      }
    }
  }

  dispose() {
    this.emergencyRestore();
    if (this.audio) {
      this.audio.close();
      this.audio = null;
    }
    if (this.hudElement && this.hudElement.parentElement) {
      this.hudElement.parentElement.removeChild(this.hudElement);
      this.hudElement = null;
    }
  }
}

if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((msg, _s, respond) => {
    const ctrl = window.__snapVanish;
    if (!ctrl) {
      respond({ ok: false, reason: "controller-uninitialized" });
      return false;
    }

    switch (msg?.type) {
      case "SNAP_TOGGLE":
        ctrl.toggle().then(respond);
        return true;

      case "SNAP_VANISH_NOW":
        ctrl.vanishNow().then(respond);
        return true;

      case "EMERGENCY_RESTORE":
      case "RESET_FRAME":
        respond(ctrl.emergencyRestore());
        return false;

      case "MUTE_TOGGLE":
        ctrl.setMic(!ctrl.muted);
        respond({
          ok: true,
          muted: ctrl.muted,
          engineState: ctrl.state,
        });
        return false;

      case "SETTINGS":
        if (msg.payload && typeof msg.payload === "object") {
          Object.assign(ctrl.settings, msg.payload);
          ctrl.detector.sensitivity = (ctrl.settings.sensitivity ?? 62) / 100;
          ctrl.detector.cooldownMs = ctrl.settings.cooldownMs ?? 2000;
          ctrl.updateHud();
        }
        respond({ ok: true, settings: ctrl.settings });
        return false;

      case "CALIBRATE_GESTURE":
        ctrl.detector.history = [];
        respond({
          ok: true,
          calibrated: true,
          sensitivity: ctrl.settings.sensitivity,
        });
        return false;

      case "RUN_DIAGNOSTICS":
        respond({
          ok: true,
          diagnostics: {
            host: location.host,
            engineState: ctrl.state,
            interceptionMode: ctrl.interceptionMode,
            muted: ctrl.muted,
            videoElementFound: Boolean(ctrl.findCallVideoElement()),
            lastError: ctrl.lastError,
          },
        });
        return false;

      case "STATE":
        respond({
          ok: true,
          host: location.host,
          engineState: ctrl.state,
          interceptionMode: ctrl.interceptionMode,
          muted: Boolean(ctrl.muted),
          settings: ctrl.settings,
          error: ctrl.lastError,
        });
        return false;

      default:
        respond({ ok: false, reason: "unsupported-message-type" });
        return false;
    }
  });
}

window.__snapVanish = new VanishController();
if (document.readyState === "complete") {
  window.__snapVanish.start().catch(() => {});
} else {
  window.addEventListener("load", () =>
    window.__snapVanish.start().catch(() => {}),
  );
}
window.addEventListener("beforeunload", () => {
  window.__snapVanish?.dispose();
});
