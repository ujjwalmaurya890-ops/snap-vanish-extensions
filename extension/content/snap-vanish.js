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
 * 6. Confirmation audio uses one long-lived `AudioContext`, with an offscreen
 *    cue fallback. If page CSP blocks WASM, small transient camera frames are
 *    processed locally in that extension-origin document for hand inference.
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
    colorAccent: "#d2451e",
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
      actionMapping: "toggle-vanish",
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
    restoreError: null,
    renderError: null,
    mutedByExtension: false,
    bridgeToken: null,
    busy: false,
    // Initialised here (not only in applySettings) so a vanish before the
    // first storage read can never dereference an undefined accent colour.
    accentRgb: { r: 210, g: 69, b: 30 },
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
    state.cfg.audio?.enabled !== false &&
    !(state.cfg.pauseWhenHidden && document.hidden);

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
      flex-wrap: wrap;
      max-width: calc(100vw - 32px);
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
    .btn:focus-visible { outline: 2px solid #ffcc99; outline-offset: 2px; }
    .btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .btn-restore { background: rgba(239, 68, 68, 0.18);
                   border-color: rgba(239, 68, 68, 0.38); color: #fecaca; }
    .btn-restore:hover { background: rgba(239, 68, 68, 0.34); color: #fff; }
    #sv-plate-preview { width: 96px; height: 54px; border-radius: 5px; background: #0e1016; }
    [hidden] { display: none !important; }
  `;

  let shadowRoot = null;
  let hudEl = null;
  let hudTextEl = null;
  let hudToggleBtn = null;
  let hudPlateBtn = null;
  let hudClearPlateBtn = null;
  let hudReviewPlateBtn = null;
  let hudUsePlateBtn = null;
  let hudHidePreviewBtn = null;
  let hudPlatePreview = null;
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
    try { tileCtx = tileCanvas.getContext("2d", { alpha: false }); } catch { tileCtx = null; }

    hudEl = document.createElement("div");
    hudEl.id = "hud";
    hudEl.setAttribute("role", "group");
    hudEl.setAttribute("aria-label", "Snap Vanish meeting controls");
    hudEl.innerHTML =
      '<span class="dot" aria-hidden="true"></span>' +
      '<span class="label" id="sv-hud-text" role="status" aria-live="polite">Snap Vanish · Starting</span>' +
      '<button type="button" class="btn" id="sv-hud-toggle">Vanish</button>' +
      '<button type="button" class="btn btn-restore" id="sv-hud-restore" ' +
      'title="Emergency Restore (Alt+Shift+R)">Restore</button>' +
      '<button type="button" class="btn" id="sv-hud-plate" title="Capture a background after 5 seconds. Step out of frame; participants may see you. The frame stays in this tab until cleared or reloaded.">Capture plate</button>' +
      '<button type="button" class="btn" id="sv-hud-clear-plate" hidden>Clear plate</button>' +
      '<button type="button" class="btn" id="sv-hud-review-plate" hidden>Review plate</button>' +
      '<button type="button" class="btn" id="sv-hud-use-plate" hidden>Use this plate</button>' +
      '<button type="button" class="btn" id="sv-hud-hide-preview" hidden>Hide plate preview</button>' +
      '<canvas id="sv-plate-preview" width="96" height="54" role="img" aria-label="Captured background preview; verify it is empty before using the effect" hidden></canvas>';

    shadowRoot.append(style, tileCanvas, hudEl);
    document.documentElement.appendChild(host);

    hudTextEl = hudEl.querySelector("#sv-hud-text");
    hudToggleBtn = hudEl.querySelector("#sv-hud-toggle");
    hudPlateBtn = hudEl.querySelector("#sv-hud-plate");
    hudClearPlateBtn = hudEl.querySelector("#sv-hud-clear-plate");
    hudReviewPlateBtn = hudEl.querySelector("#sv-hud-review-plate");
    hudUsePlateBtn = hudEl.querySelector("#sv-hud-use-plate");
    hudHidePreviewBtn = hudEl.querySelector("#sv-hud-hide-preview");
    hudPlatePreview = hudEl.querySelector("#sv-plate-preview");
    hudToggleBtn?.addEventListener("click", () => void startTransition("toggle"));
    hudPlateBtn?.addEventListener("click", (event) => {
      if (!event.isTrusted) return;
      if (plateCaptureDeadline) cancelCleanPlateCapture("cancelled");
      else beginCleanPlateCapture();
    });
    hudClearPlateBtn?.addEventListener("click", (event) => { if (event.isTrusted) clearCleanPlate(); });
    hudReviewPlateBtn?.addEventListener("click", (event) => { if (event.isTrusted) showCleanPlatePreview(); });
    hudUsePlateBtn?.addEventListener("click", (event) => { if (event.isTrusted) approveCleanPlate(); });
    hudHidePreviewBtn?.addEventListener("click", (event) => {
      if (!event.isTrusted) return;
      platePreviewVisible = false;
      updateHud();
    });
    hudEl
      .querySelector("#sv-hud-restore")
      ?.addEventListener("click", () => void emergencyRestore());
  }

  function updateHud() {
    if (!hudEl) return;
    hudEl.setAttribute("data-pos", state.cfg.hudPosition || "bottom-right");
    hudEl.setAttribute("data-hidden", state.cfg.showCallHud === false && !plateCaptureDeadline && !platePreviewVisible ? "true" : "false");
    hudEl.setAttribute("data-state", state.engineState);
    hudEl.setAttribute("data-enabled", String(Boolean(state.cfg.enabled)));
    if (hudTextEl) {
      if (state.restoreError) hudTextEl.textContent = "Camera restore failed · check meeting";
      else if (state.renderError) hudTextEl.textContent = "Effect unavailable · check meeting";
      else if (plateCaptureDeadline) hudTextEl.textContent = `Step out · capturing in ${Math.max(1, Math.ceil((plateCaptureDeadline - Date.now()) / 1000))}s`;
      else if (platePreviewVisible) hudTextEl.textContent = "Verify plate is empty, then choose Use";
      else if (plateCaptureError) hudTextEl.textContent = `Plate capture ${plateCaptureError === "cancelled" ? "cancelled" : "failed"}`;
      else if (!state.cfg.enabled) hudTextEl.textContent = "Snap Vanish · Paused";
      else if (state.engineState === "vanished")
        hudTextEl.textContent = state.interceptionMode === "webrtc-sender"
          ? "Effect · outgoing camera" : "Effect · local tile only";
      else if (state.engineState === "live")
        hudTextEl.textContent = detectionMode() === "manual" ? "Manual mode" : "Snap Vanish · enabled";
      else hudTextEl.textContent = "Transitioning…";
    }
    if (hudToggleBtn) {
      hudToggleBtn.disabled = !state.cfg.enabled || state.busy || Boolean(plateCaptureDeadline);
      hudToggleBtn.textContent = state.engineState === "vanished" ? "Return" : "Vanish";
    }
    if (hudPlateBtn) {
      hudPlateBtn.textContent = plateCaptureDeadline ? "Cancel capture" : "Capture plate";
      hudPlateBtn.disabled = !plateCaptureDeadline && (!state.cfg.enabled || state.busy || state.engineState !== "live");
    }
    if (hudClearPlateBtn) hudClearPlateBtn.hidden = !cleanPlateCanvas;
    if (hudReviewPlateBtn) hudReviewPlateBtn.hidden = !cleanPlateCanvas || platePreviewVisible;
    if (hudUsePlateBtn) {
      hudUsePlateBtn.hidden = !platePreviewVisible;
      hudUsePlateBtn.disabled = state.engineState !== "live" || state.busy;
    }
    if (hudHidePreviewBtn) hudHidePreviewBtn.hidden = !platePreviewVisible;
    if (hudPlatePreview) hudPlatePreview.hidden = !platePreviewVisible;
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

  // The MAIN-world bridge observes camera acquisition and checks the actual
  // MediaStream on this element. Labels, muting and mirroring alone are not
  // proof of self-view: remote meeting videos often share those properties.
  function isVerifiedCameraVideo(video) {
    const requestId = `sv-camera-${Math.random().toString(36).slice(2)}`;
    let verified = false;
    const receive = (event) => {
      if (event?.detail?.requestId === requestId) verified = event.detail.ok === true;
    };
    window.addEventListener("snap-vanish:bridge-ack", receive);
    try {
      video.dispatchEvent(new CustomEvent("snap-vanish:bridge-cmd", {
        bubbles: true,
        detail: { requestId, action: "CHECK_CAMERA_PREVIEW" },
      }));
    } catch { /* An unavailable bridge is not proof of a local camera. */ }
    window.removeEventListener("snap-vanish:bridge-ack", receive);
    return verified;
  }

  function pickSelfVideo() {
    if (!videoCacheDirty && isUsableVideo(selfVideo) && isVerifiedCameraVideo(selfVideo)) return selfVideo;
    videoCacheDirty = false;

    const videos = Array.from(document.querySelectorAll("video"))
      .filter(isUsableVideo)
      .filter(isVerifiedCameraVideo);
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
    if (!tileCanvas || !tileCtx) return false;
    const video = pickSelfVideo();
    if (!video) {
      tileCanvas.style.display = "none";
      return false;
    }
    const rect = video.getBoundingClientRect();
    if (rect.width < 32 || rect.height < 32) {
      tileCanvas.style.display = "none";
      return false;
    }
    // Apply the size cap after DPR scaling, preserving the tile aspect ratio.
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const pixelW = rect.width * dpr;
    const pixelH = rect.height * dpr;
    const scale = Math.min(1, CAPTURE_MAX_W / pixelW, CAPTURE_MAX_H / pixelH);
    const wantW = Math.max(2, Math.round(pixelW * scale));
    const wantH = Math.max(2, Math.round(pixelH * scale));
    if (tileCanvas.width !== wantW) tileCanvas.width = wantW;
    if (tileCanvas.height !== wantH) tileCanvas.height = wantH;
    tileCanvas.style.left = `${rect.left}px`;
    tileCanvas.style.top = `${rect.top}px`;
    tileCanvas.style.width = `${rect.width}px`;
    tileCanvas.style.height = `${rect.height}px`;
    return true;
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

  // A user-requested single frame stays in this isolated tab only. It is never
  // sent through extension messaging or storage, and is discarded on teardown.
  let cleanPlateCanvas = null;
  let cleanPlateSource = null;
  let cleanPlateApproved = false;
  let plateCaptureDeadline = 0;
  let plateCaptureTimer = 0;
  let plateCaptureVideo = null;
  let plateCaptureSource = null;
  let platePreviewVisible = false;
  let plateCaptureError = null;
  let plateMethod = "solid-fallback";

  function previewSource(video) {
    try {
      const tracks = video?.srcObject?.getVideoTracks?.().filter((track) => track.readyState === "live") || [];
      if (tracks.length !== 1 || typeof tracks[0].id !== "string" || !tracks[0].id) return null;
      return { id: tracks[0].id, width: video.videoWidth, height: video.videoHeight };
    } catch { return null; }
  }

  function samePreviewSource(a, b) {
    return Boolean(a && b && a.id === b.id && a.width === b.width && a.height === b.height);
  }

  function cancelCleanPlateCapture(reason = "cancelled") {
    if (plateCaptureTimer) window.clearTimeout(plateCaptureTimer);
    plateCaptureTimer = 0;
    plateCaptureDeadline = 0;
    plateCaptureVideo = null;
    plateCaptureSource = null;
    plateCaptureError = reason;
    updateHud();
    return { ok: true };
  }

  function clearCleanPlate() {
    if (plateCaptureDeadline) cancelCleanPlateCapture();
    const hadPlate = Boolean(cleanPlateCanvas);
    if (cleanPlateCanvas) { cleanPlateCanvas.width = 0; cleanPlateCanvas.height = 0; }
    cleanPlateCanvas = null;
    cleanPlateSource = null;
    cleanPlateApproved = false;
    platePreviewVisible = false;
    plateCaptureError = null;
    plateMethod = "solid-fallback";
    if (plateCanvas && plateCtx) {
      plateCtx.filter = "none";
      plateCtx.fillStyle = "#0e1016";
      plateCtx.fillRect(0, 0, plateCanvas.width, plateCanvas.height);
    }
    // The capture canvas is page-visible for the bridge; erase its last plate
    // immediately too, including while a processed sender is still attached.
    if (captureCanvas && captureCtx) {
      try {
        captureCtx.save();
        captureCtx.setTransform(1, 0, 0, 1, 0, 0);
        captureCtx.globalAlpha = 1;
        captureCtx.fillStyle = "#0e1016";
        captureCtx.fillRect(0, 0, captureCanvas.width, captureCanvas.height);
        captureCtx.restore();
      } catch { /* context lost */ }
    }
    if (hadPlate) {
      try { hudPlatePreview?.getContext("2d")?.clearRect(0, 0, 96, 54); } catch { /* unavailable */ }
    }
    updateHud();
    return { ok: true };
  }

  function validCleanPlate(video) {
    if (!cleanPlateCanvas) return false;
    if (samePreviewSource(cleanPlateSource, previewSource(video))) return true;
    clearCleanPlate();
    plateCaptureError = "camera-changed";
    updateHud();
    return false;
  }

  function matchingCleanPlate(video) {
    return validCleanPlate(video) && cleanPlateApproved;
  }

  function showCleanPlatePreview() {
    if (!validCleanPlate(pickSelfVideo())) return { ok: false, reason: "no-captured-plate" };
    platePreviewVisible = true;
    updateHud();
    return { ok: true };
  }

  // Only the explicit HUD confirmation calls this; until then rendering uses the
  // neutral fallback even if a frame was captured successfully.
  function approveCleanPlate() {
    if (state.engineState !== "live" || state.busy) return { ok: false, reason: "camera-not-live" };
    if (!validCleanPlate(pickSelfVideo())) return { ok: false, reason: "no-captured-plate" };
    cleanPlateApproved = true;
    platePreviewVisible = false;
    plateCaptureError = null;
    updateHud();
    return { ok: true };
  }

  function capturePlateTick() {
    plateCaptureTimer = 0;
    const video = plateCaptureVideo;
    if (!plateCaptureDeadline) return;
    if (document.hidden || !state.cfg.enabled || state.busy || state.engineState !== "live" ||
        pickSelfVideo() !== video || !samePreviewSource(plateCaptureSource, previewSource(video))) {
      cancelCleanPlateCapture("capture-interrupted");
      return;
    }
    if (Date.now() < plateCaptureDeadline) {
      updateHud();
      plateCaptureTimer = window.setTimeout(capturePlateTick, Math.min(1000, plateCaptureDeadline - Date.now()));
      return;
    }
    try {
      const size = captureSizeFor(video);
      const canvas = document.createElement("canvas");
      canvas.width = size.w;
      canvas.height = size.h;
      const ctx = canvas.getContext("2d", { alpha: false });
      const preview = hudPlatePreview?.getContext("2d");
      if (!ctx || !preview) throw new Error("canvas-unavailable");
      ctx.drawImage(video, 0, 0, size.w, size.h);
      // Confirm the frame is origin-clean before calling the capture successful.
      ctx.getImageData(0, 0, 1, 1);
      preview.clearRect(0, 0, 96, 54);
      preview.drawImage(canvas, 0, 0, 96, 54);
      if (cleanPlateCanvas) { cleanPlateCanvas.width = 0; cleanPlateCanvas.height = 0; }
      cleanPlateCanvas = canvas;
      cleanPlateSource = plateCaptureSource;
      cleanPlateApproved = false;
      plateCaptureDeadline = 0;
      plateCaptureVideo = null;
      plateCaptureSource = null;
      plateCaptureError = null;
      platePreviewVisible = true;
      updateHud();
    } catch {
      cancelCleanPlateCapture("capture-failed");
    }
  }

  function beginCleanPlateCapture() {
    if (plateCaptureDeadline) return { ok: false, reason: "capture-pending" };
    if (!state.cfg.enabled || state.busy || state.engineState !== "live" || state.restoreError)
      return { ok: false, reason: "camera-not-live" };
    if (document.hidden) return { ok: false, reason: "focus-meeting-tab" };
    const video = pickSelfVideo();
    const source = previewSource(video);
    if (!video || !source) return { ok: false, reason: "no-verified-camera-preview" };
    plateCaptureVideo = video;
    plateCaptureSource = source;
    plateCaptureError = null;
    platePreviewVisible = false;
    plateCaptureDeadline = Date.now() + 5000;
    updateHud();
    plateCaptureTimer = window.setTimeout(capturePlateTick, 1000);
    return { ok: true, cleanPlateStatus: "countdown", cleanPlateRemaining: 5 };
  }

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
      try { captureCtx = captureCanvas.getContext("2d", { alpha: false, desynchronized: true }); } catch { captureCtx = null; }
    }
    // Only resize while detached from the peer connection: changing the backing
    // store of a captured canvas forces an SDP renegotiation on the call.
    if (state.interceptionMode !== "webrtc-sender") {
      ensureCanvasSize(captureCanvas, width, height);
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
    if (video && matchingCleanPlate(video)) {
      plateCtx.drawImage(cleanPlateCanvas, 0, 0, w, h);
      plateMethod = "captured-plate";
    } else {
      // A blurred current frame can still reveal a person. Use a neutral solid
      // backdrop unless the user explicitly captured and reviewed a plate.
      plateCtx.fillStyle = "#0e1016";
      plateCtx.fillRect(0, 0, w, h);
      plateMethod = "solid-fallback";
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

  function renderFrame(t, mode = state.interceptionMode) {
    const target = mode === "webrtc-sender" ? captureCtx : tileCtx;
    const canvas = mode === "webrtc-sender" ? captureCanvas : tileCanvas;
    if (!target || !canvas || !plateCanvas || !personCanvas) return false;

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
      return true;
    } catch {
      // A single bad frame must never break the session; the next rAF retries.
      return false;
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

  function renderTick(progress) {
    const ok = renderFrame(progress);
    const error = state.interceptionMode === "webrtc-sender" ? "capture-render-failed" : "overlay-render-failed";
    if (!ok && state.renderError !== error) {
      state.renderError = error;
      updateHud();
    } else if (ok && (state.renderError === "capture-render-failed" || state.renderError === "overlay-render-failed")) {
      state.renderError = null;
      updateHud();
    }
    return ok;
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
      renderTick(t);
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
        renderTick(1);
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

  function bridgeRequest(action, extra = {}, timeoutMs = BRIDGE_TIMEOUT_MS, target = window) {
    return new Promise((resolve) => {
      const requestId = `sv-${++bridgeSeq}-${(Math.random() * 1e6) | 0}`;
      const timer = window.setTimeout(() => {
        bridgePending.delete(requestId);
        resolve({ ok: false, mode: "dom-overlay", sendersCount: 0, reason: "timeout" });
      }, timeoutMs);
      bridgePending.set(requestId, { resolve, timer });
      try {
        target.dispatchEvent(
          new CustomEvent("snap-vanish:bridge-cmd", {
            bubbles: true,
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

  async function handshakeBridge(video = null) {
    const hello = await bridgeRequest("HELLO", {}, BRIDGE_TIMEOUT_MS, video || window);
    if (!hello || !hello.ok) return null;
    state.bridgeToken = hello.token;
    state.sendersCount = hello.sendersCount ?? 0;
    return hello;
  }

  function captureSizeFor(video, videoSettings) {
    const dimension = (preferred, fallback) => Number.isFinite(preferred) && preferred > 0 ? preferred : fallback;
    const sourceW = dimension(videoSettings?.width, dimension(video?.videoWidth, 640));
    const sourceH = dimension(videoSettings?.height, dimension(video?.videoHeight, 360));
    const scale = Math.min(1, CAPTURE_MAX_W / sourceW, CAPTURE_MAX_H / sourceH);
    const w = Math.max(2, Math.floor(sourceW * scale));
    const h = Math.max(2, Math.floor(sourceH * scale));
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
  let audioSource = null;
  let audioFilter = null;
  let audioStartPromise = null;
  let audioGeneration = 0;
  let audioStartFailed = false;
  let audioGateError = null;
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

  function stopStream(stream) {
    let tracks = [];
    try { tracks = stream?.getTracks() ?? []; } catch { return; }
    for (const track of tracks) {
      try { if (track.readyState !== "ended") track.stop(); } catch { /* keep stopping the others */ }
    }
  }

  async function ensureAudioGate() {
    if (audioAnalyser && audioCtx?.state === "running") return true;
    if (!microphoneAllowed() || tornDown || audioStartFailed) return false;
    if (audioStartPromise) return audioStartPromise;
    if (!navigator.mediaDevices?.getUserMedia) {
      audioGateError = "microphone-unavailable";
      audioStartFailed = true;
      return false;
    }

    const requestedGeneration = audioGeneration;
    const start = (async () => {
      let stream = null;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
          video: false,
        });
        if (requestedGeneration !== audioGeneration || !microphoneAllowed() || tornDown) {
          stopStream(stream);
          return false;
        }
        const ctx = ensureAudioContext();
        if (!ctx) throw new Error("audio-context-unavailable");
        // Publish ownership before awaiting resume so pause/teardown can stop it.
        micStream = stream;
        if (ctx.state === "suspended") await ctx.resume();
        if (requestedGeneration !== audioGeneration || !microphoneAllowed() || tornDown) {
          stopStream(stream);
          return false;
        }
        if (ctx.state !== "running") throw new Error("audio-context-not-running");
        const source = ctx.createMediaStreamSource(stream);
        const filter = ctx.createBiquadFilter();
        filter.type = "bandpass";
        filter.frequency.value = 2800;
        filter.Q.value = 1.2;
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        source.connect(filter).connect(analyser);
        audioSource = source;
        audioFilter = filter;
        audioAnalyser = analyser;
        audioBuf = new Float32Array(analyser.fftSize);
        audioGateError = null;
        for (const track of stream.getAudioTracks()) {
          track.addEventListener("ended", () => {
            if (micStream !== stream) return;
            releaseAudio();
            audioStartFailed = true;
            audioGateError = "microphone-ended";
            updateHud();
          }, { once: true });
        }
        updateHud();
        return true;
      } catch (error) {
        if (micStream !== stream) stopStream(stream);
        if (requestedGeneration === audioGeneration) {
          releaseAudio();
          audioStartFailed = true;
          audioGateError = error?.name === "NotAllowedError" ? "microphone-denied" : "microphone-unavailable";
          updateHud();
        }
        return false;
      }
    })();
    audioStartPromise = start;
    try { return await start; }
    finally { if (audioStartPromise === start) audioStartPromise = null; }
  }

  function pollAudioOnset(now) {
    if (!audioAnalyser || !audioBuf || audioCtx?.state !== "running" || !micStream) return null;
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
    audioGeneration += 1;
    audioStartPromise = null;
    stopStream(micStream);
    micStream = null;
    for (const node of [audioSource, audioFilter, audioAnalyser]) {
      try { node?.disconnect(); } catch { /* already disconnected */ }
    }
    audioSource = null;
    audioFilter = null;
    audioAnalyser = null;
    audioBuf = null;
    audioFloorDb = -60;
    lastOnsetAt = null;
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
  let handModelBackend = null;
  let handModelLoading = false;
  let remoteInferencePending = false;
  let remoteInferenceToken = 0;
  let inferenceCanvas = null;
  let inferenceCtx = null;
  let handModelError = null;
  let handModelRetryAt = 0;
  let handModelFailures = 0;
  let handModelGeneration = 0;
  let detectHandle = 0;
  let lastInferenceAt = 0;
  let lastSuccessfulInferenceAt = null;
  let lastTimestampMs = 0;
  const snapHistory = [];
  let lastSnapAt = -Infinity;
  let pendingVisualSnapAt = null;

  function modelRunAllowed() {
    return !tornDown && detectionActive() && !(state.cfg.pauseWhenHidden && document.hidden);
  }

  function releaseHandModel() {
    handModelGeneration += 1;
    remoteInferenceToken += 1;
    remoteInferencePending = false;
    if (handModelBackend === "offscreen") {
      try { void chrome.runtime.sendMessage({ type: "HAND_MODEL_RELEASE" }).catch(() => {}); } catch { /* unavailable */ }
    }
    try { handLandmarker?.close?.(); } catch { /* already closed */ }
    handLandmarker = null;
    handModelBackend = null;
    handModelReady = false;
    handModelError = null;
    handModelRetryAt = 0;
    handModelFailures = 0;
    lastSuccessfulInferenceAt = null;
    snapHistory.length = 0;
    pendingVisualSnapAt = null;
    if (inferenceCanvas) { inferenceCanvas.width = 0; inferenceCanvas.height = 0; }
    inferenceCanvas = null;
    inferenceCtx = null;
  }

  /** Prefer local in-page inference. If the host CSP blocks WASM compilation,
   * use a throttled extension-origin fallback with transient frames only. */
  async function loadHandLandmarker() {
    if (handModelReady || handModelLoading || !modelRunAllowed() || nowMs() < handModelRetryAt) return;
    handModelLoading = true;
    const generation = handModelGeneration;
    let factory = null;
    let created = null;
    try {
      if (!chrome?.runtime?.getURL) throw new Error("extension runtime unavailable");
      try {
        const wasmJsUrl = chrome.runtime.getURL("wasm/vision_wasm_module_internal.js");
        const wasmBinUrl = chrome.runtime.getURL("wasm/vision_wasm_module_internal.wasm");
        const bundleUrl = chrome.runtime.getURL("vendor/vision_bundle.mjs");
        const modelUrl = chrome.runtime.getURL("models/hand_landmarker.task");
        const wasmMod = await import(wasmJsUrl);
        factory = wasmMod?.default;
        if (typeof factory !== "function") throw new Error("WASM module factory unavailable");
        const vision = await import(bundleUrl);
        const HandLandmarker = vision.HandLandmarker;
        if (typeof HandLandmarker?.createFromOptions !== "function") throw new Error("HandLandmarker unavailable");
        // Empty loader path prevents MediaPipe injecting a classic script into
        // the meeting page. Its factory is consumed and cleared per task.
        const fileset = { wasmLoaderPath: "", wasmBinaryPath: wasmBinUrl };
        const options = {
          runningMode: "VIDEO", numHands: 1,
          minHandDetectionConfidence: state.cfg.gesture?.minHandConfidence || 0.62,
          minHandPresenceConfidence: state.cfg.gesture?.minHandConfidence || 0.62,
        };
        for (const delegate of ["GPU", "CPU"]) {
          if (generation !== handModelGeneration || !modelRunAllowed()) return;
          try {
            globalThis.ModuleFactory = factory;
            created = await HandLandmarker.createFromOptions(fileset, {
              ...options, baseOptions: { modelAssetPath: modelUrl, delegate },
            });
            if (created && typeof created.detectForVideo === "function") break;
            try { created?.close?.(); } catch { /* ignore */ }
            created = null;
          } catch { created = null; }
        }
      } catch { /* Host CSP or local initialization can prevent in-page WASM. */ }
      if (generation !== handModelGeneration || !modelRunAllowed()) {
        try { created?.close?.(); } catch { /* ignore */ }
        return;
      }
      if (created) {
        handLandmarker = created;
        created = null;
        handModelBackend = "in-page";
      } else {
        const response = await chrome.runtime.sendMessage({
          type: "HAND_MODEL_START", payload: { minConfidence: state.cfg.gesture?.minHandConfidence || 0.62 },
        });
        if (generation !== handModelGeneration || !modelRunAllowed()) {
          if (response?.ok) void chrome.runtime.sendMessage({ type: "HAND_MODEL_RELEASE" }).catch(() => {});
          return;
        }
        if (!response?.ok) throw new Error(response?.reason || "offscreen model unavailable");
        handModelBackend = "offscreen";
      }
      handModelReady = true;
      handModelError = null;
      handModelFailures = 0;
      handModelRetryAt = 0;
    } catch (err) {
      try { created?.close?.(); } catch { /* ignore */ }
      if (generation === handModelGeneration && !tornDown) {
        handModelReady = false;
        handModelBackend = null;
        handModelError = "model-initialization-failed";
        handModelFailures += 1;
        handModelRetryAt = nowMs() + Math.min(60000, 10000 * (2 ** Math.min(handModelFailures - 1, 3)));
        console.info(TAG, "hand model unavailable:", err instanceof Error ? err.message : err);
      }
    } finally {
      if (factory && globalThis.ModuleFactory === factory) delete globalThis.ModuleFactory;
      handModelLoading = false;
      if (!tornDown) updateHud();
    }
  }

  function dist3(a, b) {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    const dz = (a.z || 0) - (b.z || 0);
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  function evaluateHandSnap(landmarks, worldLandmarks, now, audioNow = now) {
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
    if (!audioConfirmRequired()) {
      pendingVisualSnapAt = null;
      lastSnapAt = now;
      snapHistory.length = 0;
      return true;
    }
    // Smart confirmation is fail-closed: denied, disabled, suspended, or lost
    // audio must never silently turn a visual candidate into a confirmed snap.
    if (!microphoneAllowed() || !audioAnalyser || audioCtx?.state !== "running" || !micStream) {
      pendingVisualSnapAt = null;
      return false;
    }
    const onset = pollAudioOnset(audioNow);
    if (onset !== null && Math.abs(onset - pendingVisualSnapAt) <= win) {
      pendingVisualSnapAt = null;
      lastSnapAt = now;
      snapHistory.length = 0;
      return true;
    }
    return false;
  }

  let detectHandleKind = null;
  let detectVideo = null;
  let detectRetryTimer = 0;
  let inferenceFailures = 0;

  function stopDetection() {
    if (detectRetryTimer) window.clearTimeout(detectRetryTimer);
    detectRetryTimer = 0;
    if (detectHandle) {
      if (detectHandleKind === "video") {
        try { detectVideo?.cancelVideoFrameCallback?.(detectHandle); } catch { /* ignore */ }
      } else window.clearTimeout(detectHandle);
    }
    detectHandle = 0;
    detectHandleKind = null;
    detectVideo = null;
  }

  function queueDetection(delay) {
    if (tornDown || detectRetryTimer || detectHandle) return;
    detectRetryTimer = window.setTimeout(() => {
      detectRetryTimer = 0;
      scheduleDetection();
    }, delay);
  }

  async function requestRemoteInference(video, capturedAt) {
    if (remoteInferencePending) return;
    const token = ++remoteInferenceToken;
    const generation = handModelGeneration;
    const source = previewSource(video);
    if (!source) return;
    remoteInferencePending = true;
    let timer = 0;
    try {
      if (!inferenceCanvas) {
        inferenceCanvas = document.createElement("canvas");
        inferenceCtx = inferenceCanvas.getContext("2d", { alpha: false });
      }
      if (!inferenceCtx) throw new Error("inference canvas unavailable");
      const scale = Math.min(1, 256 / video.videoWidth, 256 / video.videoHeight);
      const width = Math.max(2, Math.floor(video.videoWidth * scale));
      const height = Math.max(2, Math.floor(video.videoHeight * scale));
      ensureCanvasSize(inferenceCanvas, width, height);
      inferenceCtx.drawImage(video, 0, 0, width, height);
      const frame = inferenceCanvas.toDataURL("image/jpeg", 0.72);
      const response = await Promise.race([
        chrome.runtime.sendMessage({ type: "HAND_MODEL_INFER", payload: { frame, timestamp: capturedAt } }),
        new Promise((resolve) => { timer = window.setTimeout(() => resolve({ ok: false, reason: "timeout" }), 4000); }),
      ]);
      if (token !== remoteInferenceToken || generation !== handModelGeneration || !modelRunAllowed()) return;
      if (pickSelfVideo() !== video || !samePreviewSource(source, previewSource(video))) {
        snapHistory.length = 0;
        pendingVisualSnapAt = null;
        lastSuccessfulInferenceAt = null;
        return;
      }
      if (!response?.ok) {
        if (response?.reason === "busy") return;
        throw new Error(response?.reason || "inference unavailable");
      }
      inferenceFailures = 0;
      lastSuccessfulInferenceAt = nowMs();
      if (response.landmarks?.length && evaluateHandSnap(response.landmarks[0], response.worldLandmarks?.[0], capturedAt, nowMs())) {
        void triggerGestureAction();
      }
    } catch {
      if (token === remoteInferenceToken && generation === handModelGeneration) {
        inferenceFailures += 1;
        if (inferenceFailures >= 3) {
          releaseHandModel();
          releaseAudio();
          handModelError = "model-inference-failed";
          handModelRetryAt = nowMs() + 10000;
          inferenceFailures = 0;
          updateHud();
        }
      }
    } finally {
      if (timer) window.clearTimeout(timer);
      if (token === remoteInferenceToken) remoteInferencePending = false;
    }
  }

  /** One tracked callback at a time; reselect the camera when it changes. */
  function scheduleDetection() {
    if (tornDown || detectHandle || detectRetryTimer) return;
    const shouldRun = () => modelRunAllowed() && (state.engineState === "live" || state.engineState === "vanished");
    if (!shouldRun()) { queueDetection(500); return; }
    const video = pickSelfVideo();
    if (!video) { queueDetection(800); return; }
    const fpsCap = state.cfg.lowPowerMode ? 12 : state.cfg.gesture?.inferenceFpsLimit || 20;
    const minInterval = 1000 / Math.max(8, fpsCap);
    const onFrame = () => {
      detectHandle = 0;
      detectHandleKind = null;
      detectVideo = null;
      if (tornDown) return;
      if (!shouldRun() || pickSelfVideo() !== video) { queueDetection(500); return; }
      if (!handModelReady && !handModelLoading && nowMs() >= handModelRetryAt) {
        void loadHandLandmarker().then(() => { if (handModelReady) void ensureAudioGate(); });
      } else if (handModelReady && microphoneAllowed() && !audioAnalyser && !audioStartPromise && !audioStartFailed) {
        void ensureAudioGate();
      }
      const now = nowMs();
      pollAudioOnset(now);
      const inferenceInterval = handModelBackend === "offscreen" ? Math.max(minInterval, 125) : minInterval;
      if (handModelReady && now - lastInferenceAt >= inferenceInterval) {
        if (handModelBackend === "offscreen") {
          if (!remoteInferencePending) {
            lastInferenceAt = now;
            void requestRemoteInference(video, now);
          }
        } else if (handLandmarker) {
          lastInferenceAt = now;
          const ts = Math.max(lastTimestampMs + 1, Math.floor(now));
          lastTimestampMs = ts;
          try {
            const res = handLandmarker.detectForVideo(video, ts);
            inferenceFailures = 0;
            lastSuccessfulInferenceAt = now;
            if (res?.landmarks?.length > 0 && evaluateHandSnap(res.landmarks[0], res.worldLandmarks?.[0], now)) {
              void triggerGestureAction();
            }
          } catch {
            inferenceFailures += 1;
            if (inferenceFailures >= 5) {
              releaseHandModel();
              releaseAudio();
              handModelError = "model-inference-failed";
              handModelRetryAt = now + 10000;
              inferenceFailures = 0;
              updateHud();
            }
          }
        }
      }
      scheduleDetection();
    };
    detectVideo = video;
    if (typeof video.requestVideoFrameCallback === "function") {
      detectHandleKind = "video";
      detectHandle = video.requestVideoFrameCallback(onFrame);
    } else {
      detectHandleKind = "timer";
      detectHandle = window.setTimeout(onFrame, minInterval);
    }
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

  let transitionGeneration = 0;

  async function attachSenderStream(video, requestedGeneration) {
    const hello = await handshakeBridge(video);
    if (requestedGeneration !== transitionGeneration || !["vanishing", "vanished"].includes(state.engineState)) return;
    if (!hello?.ok || !hello.sendersCount) {
      state.interceptionMode = "dom-overlay";
      const visible = syncOverlayRect();
      if (tileCanvas) tileCanvas.style.display = visible ? "block" : "none";
      state.renderError = visible ? null : "overlay-unavailable";
      updateHud();
      return;
    }
    // Prime the correctly sized outgoing canvas before replaceTrack. Otherwise
    // captureStream can expose its default black/300×150 first frame.
    const progress = state.engineState === "vanished" ? 1 : clamp((nowMs() - animStartMs) / totalDurationMs(), 0, 1);
    if (!renderFrame(progress, "webrtc-sender")) {
      state.renderError = "capture-render-failed";
      updateHud();
      return;
    }

    const res = await bridgeRequest("ATTACH_PROCESSED_STREAM", {
      canvasId: "snap-vanish-rtc-canvas",
      fps: state.cfg.lowPowerMode ? 20 : 30,
    }, BRIDGE_TIMEOUT_MS, video);
    if (requestedGeneration !== transitionGeneration || !["vanishing", "vanished"].includes(state.engineState)) {
      // The user restored while the attach was in flight. A restore is queued
      // behind it in MAIN world, including when the attach response timed out.
      void bridgeRequest("RESTORE_ORIGINAL_TRACK");
      return;
    }
    state.sendersCount = res.sendersCount ?? 0;
    if (res.ok) {
      state.interceptionMode = "webrtc-sender";
      state.renderError = null;
      if (tileCanvas) tileCanvas.style.display = "none";
    } else {
      // A timed-out attach may still complete later. Cancel it in the bridge;
      // its transaction queue guarantees that restore follows the pending swap.
      if (res.reason === "timeout") void bridgeRequest("RESTORE_ORIGINAL_TRACK");
      state.interceptionMode = res.mode === "webrtc-sender" ? "webrtc-sender" : "dom-overlay";
      if (state.interceptionMode === "dom-overlay") {
        const visible = syncOverlayRect();
        if (tileCanvas) tileCanvas.style.display = visible ? "block" : "none";
        state.renderError = visible ? null : "overlay-unavailable";
      } else {
        state.renderError = "sender-rollback-failed";
      }
    }
    updateHud();
  }

  function startTransition(target) {
    if (!state.cfg.enabled) return Promise.resolve({ ok: false, reason: "disabled" });
    if (plateCaptureDeadline) return Promise.resolve({ ok: false, reason: "capture-pending" });
    if (state.busy) {
      return Promise.resolve({ ok: false, reason: "busy", engineState: state.engineState });
    }

    const goingOut =
      target === "vanish"
        ? true
        : target === "restore"
          ? false
          : state.engineState === "live";

    if (goingOut && state.restoreError)
      return Promise.resolve({ ok: false, reason: "restore-required", engineState: state.engineState });
    if (goingOut && state.engineState === "vanished")
      return Promise.resolve({ ok: true, engineState: state.engineState });
    if (!goingOut && state.engineState === "live") {
      return state.restoreError ? emergencyRestore() : Promise.resolve({ ok: true, engineState: state.engineState });
    }

    const video = pickSelfVideo();
    if (goingOut && !video) {
      return Promise.resolve({ ok: false, reason: "no-verified-camera-preview", engineState: state.engineState });
    }
    const requestedGeneration = ++transitionGeneration;
    ensureSurface();

    if (goingOut) {
      const size = captureSizeFor(video);
      frame.w = size.w;
      frame.h = size.h;
      ensureCaptureCanvas(size.w, size.h);
      if (!captureCtx || !tileCtx) {
        state.renderError = "rendering-unavailable";
        updateHud();
        return Promise.resolve({ ok: false, reason: "rendering-unavailable", engineState: state.engineState });
      }
      // Capture the frame we are dissolving *now* — this must be synchronous.
      try {
        buildParticles(video);
      } catch (err) {
        // A failed pixel readback can still degrade to a plain plate dissolve.
        particles.count = 0;
        console.info(TAG, "particle capture failed:", err);
      }
      if (!renderFrame(0, "webrtc-sender")) {
        state.renderError = "capture-render-failed";
        updateHud();
        return Promise.resolve({ ok: false, reason: "rendering-unavailable", engineState: state.engineState });
      }
      state.renderError = null;
      if (state.interceptionMode !== "webrtc-sender" && tileCanvas) {
        const visible = syncOverlayRect();
        tileCanvas.style.display = visible ? "block" : "none";
      }
      if (state.cfg.muteOnVanish) mutePlatformForVanish();
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
    if (goingOut) void attachSenderStream(video, requestedGeneration);

    return Promise.resolve({ ok: true, engineState: state.engineState, interceptionMode: state.interceptionMode });
  }

  function finishTransition() {
    if (state.engineState === "vanishing") {
      setEngineState("vanished");
      state.busy = false;
      updateHud();
      // keep the loop alive (low cadence) so the captured track stays fed
      startLoop();
      return;
    }
    if (state.engineState === "restoring") {
      setEngineState("live");
      state.busy = false;
      updateHud();
      if (tileCanvas) tileCanvas.style.display = "none";
      void bridgeRequest("RESTORE_ORIGINAL_TRACK").then((result) => {
        state.sendersCount = result.sendersCount ?? state.sendersCount;
        state.restoreError = result.ok ? null : (result.reason || "restore-failed");
        if (result.ok) { state.interceptionMode = "dom-overlay"; state.renderError = null; }
        else if (result.mode === "webrtc-sender") state.interceptionMode = "webrtc-sender";
        // Do not unmute automatically. User or platform mute choices may have
        // changed since vanish, and DOM labels cannot prove mute ownership.
        updateHud();
      });
      stopLoop();
    }
  }

  async function emergencyRestore() {
    if (plateCaptureDeadline) cancelCleanPlateCapture();
    transitionGeneration += 1;
    stopLoop();
    state.busy = true;
    setEngineState("live");
    state.busy = false;
    if (tileCanvas) {
      if (tileCtx) tileCtx.clearRect(0, 0, tileCanvas.width, tileCanvas.height);
      tileCanvas.style.display = "none";
    }
    const result = await bridgeRequest("RESTORE_ORIGINAL_TRACK");
    state.sendersCount = result.sendersCount ?? state.sendersCount;
    state.restoreError = result.ok ? null : (result.reason || "restore-failed");
    if (result.ok) { state.interceptionMode = "dom-overlay"; state.renderError = null; }
    else if (result.mode === "webrtc-sender") state.interceptionMode = "webrtc-sender";
    // Emergency camera recovery must not override the user's microphone state.
    const muted = platformMicControl()?.muted ?? null;
    if (muted === false) state.mutedByExtension = false;
    updateHud();
    return { ok: Boolean(result.ok), reason: result.reason, engineState: "live", muted };
  }

  /* ================================================================== *
   * 10. Host platform mic control
   * ================================================================== */

  function micSelectors() {
    const host = location.hostname;
    if (host === "meet.google.com" || host === "teams.microsoft.com" || host === "teams.live.com") {
      return ['button[aria-label*="microphone" i]', 'button[id*="microphone" i]'];
    }
    if (host === "zoom.us" || host.endsWith(".zoom.us")) {
      return ['button[aria-label*="microphone" i]', 'button[id*="microphone" i]'];
    }
    return [];
  }

  // Clicking a guessed toggle can accidentally unmute the user. Only act when
  // a microphone-specific control exposes a recognisable state; unknown or
  // localised labels are deliberately left alone.
  function platformMicControl() {
    const candidates = new Map();
    for (const selector of micSelectors()) {
      for (const button of document.querySelectorAll(selector)) {
        if (!(button instanceof HTMLElement) || button.hasAttribute("disabled") || button.getAttribute("aria-disabled") === "true") continue;
        const label = (button.getAttribute("aria-label") || "").trim().toLowerCase();
        const mutedLabel = /^(?:unmute (?:my |your |the )?microphone|turn on (?:my |your |the )?microphone)(?:\s*\([^)]*\))?$/.test(label);
        const liveLabel = /^(?:mute (?:my |your |the )?microphone|turn off (?:my |your |the )?microphone)(?:\s*\([^)]*\))?$/.test(label);
        if (!mutedLabel && !liveLabel) continue;
        const muted = mutedLabel;
        const data = button.getAttribute("data-is-muted");
        if ((data === "true" && !muted) || (data === "false" && muted)) continue;
        candidates.set(button, { button, muted });
      }
    }
    return candidates.size === 1 ? candidates.values().next().value : null;
  }

  let micClickInProgress = false;
  function clickPlatformMic(button) {
    micClickInProgress = true;
    try { button.click(); }
    finally { micClickInProgress = false; }
  }
  document.addEventListener("click", (event) => {
    if (micClickInProgress || !state.mutedByExtension) return;
    const control = platformMicControl();
    if (control && (control.button === event.target || control.button.contains(event.target))) {
      state.mutedByExtension = false;
      updateHud();
    }
  }, true);

  function mutePlatformForVanish() {
    const control = platformMicControl();
    if (!control || control.muted) return false;
    try {
      clickPlatformMic(control.button);
      state.mutedByExtension = true;
      return true;
    } catch { return false; }
  }

  function triggerGestureAction() {
    const action = state.cfg.gesture?.actionMapping || "toggle-vanish";
    if (action === "mute-only") {
      const control = platformMicControl();
      if (!control) return { ok: false, reason: "microphone-state-unknown" };
      if (control.muted) return { ok: true, muted: true };
      const ok = mutePlatformForVanish();
      updateHud();
      return { ok, muted: platformMicControl()?.muted ?? null };
    }
    if (action === "vanish-only") return startTransition("vanish");
    if (action === "restore-only") return startTransition("restore");
    return startTransition("toggle");
  }

  function togglePlatformMicByRequest() {
    const control = platformMicControl();
    if (!control) return { ok: false, reason: "microphone-state-unknown", muted: null };
    try {
      clickPlatformMic(control.button);
      state.mutedByExtension = false;
      return { ok: true, requestedMuted: !control.muted, muted: platformMicControl()?.muted ?? null };
    } catch {
      return { ok: false, reason: "microphone-control-failed", muted: control.muted };
    }
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
  const VALID_CFG_GESTURE_ACTIONS = new Set(["toggle-vanish", "vanish-only", "restore-only", "mute-only"]);
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
      gput("actionMapping", oneOf(g.actionMapping, VALID_CFG_GESTURE_ACTIONS));
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
    const audioWasAllowed = microphoneAllowed();
    const detectionWasActive = detectionActive();
    const previousConfidence = state.cfg.gesture?.minHandConfidence;
    const wasEnabled = state.cfg.enabled !== false;
    state.cfg = {
      ...state.cfg,
      ...patch,
      gesture: { ...state.cfg.gesture, ...(patch.gesture || {}) },
      audio: { ...state.cfg.audio, ...(patch.audio || {}) },
      camera: { ...state.cfg.camera, ...(patch.camera || {}) },
    };
    state.accentRgb = accentRgb(state.cfg.colorAccent);
    if (detectionWasActive && (!detectionActive() || previousConfidence !== state.cfg.gesture?.minHandConfidence)) releaseHandModel();
    else if (!detectionWasActive && detectionActive()) { handModelError = null; handModelRetryAt = 0; }
    // Release the microphone immediately when the policy no longer allows it
    // (mode switched away from Smart, detection paused, audio disabled…).
    if (!microphoneAllowed()) {
      releaseAudio();
      audioGateError = null;
    } else if (!audioWasAllowed) {
      // A deliberate re-enable can retry a denied/ended microphone once.
      audioStartFailed = false;
      audioGateError = null;
    }
    if (wasEnabled && state.cfg.enabled === false) {
      clearCleanPlate();
      if (state.engineState !== "live" || state.restoreError) void emergencyRestore();
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
    const muted = platformMicControl()?.muted ?? null;
    if (muted === false) state.mutedByExtension = false;
    const video = pickSelfVideo();
    const cameraPresent = Boolean(video);
    const cleanPlateAvailable = cleanPlateCanvas ? validCleanPlate(video) : false;
    const audioGateActive = Boolean(audioAnalyser && audioCtx?.state === "running" && micStream);
    let detectionStatus = "starting";
    if (!detectionActive()) detectionStatus = detectionMode() === "manual" ? "manual" : "disabled";
    else if (state.cfg.pauseWhenHidden && document.hidden) detectionStatus = "paused-hidden";
    else if (!cameraPresent) detectionStatus = "no-camera";
    else if (!handModelReady) detectionStatus = handModelError ? "model-unavailable" : "model-not-ready";
    else if (audioConfirmRequired() && !audioGateActive) detectionStatus = (audioGateError || state.cfg.audio?.enabled === false) ? "audio-unavailable" : "waiting-audio";
    else if (state.busy) detectionStatus = "transitioning";
    else if (lastSuccessfulInferenceAt !== null && nowMs() - lastSuccessfulInferenceAt < 3000) detectionStatus = "active";
    return {
      ok: true,
      host: location.hostname,
      engineState: state.engineState,
      interceptionMode: state.interceptionMode,
      restoreError: state.restoreError,
      renderError: state.renderError,
      cameraPresent,
      detectionEnabled: Boolean(state.cfg.gesture?.enabled),
      detectionMode: detectionMode(),
      detectionActive: detectionStatus === "active",
      detectionStatus,
      handModelReady,
      handModelBackend,
      handModelError,
      audioGateActive,
      audioGateError,
      cleanPlateStatus: plateCaptureDeadline ? "countdown" : cleanPlateAvailable ? (cleanPlateApproved ? "captured" : "review") : "none",
      cleanPlateRemaining: plateCaptureDeadline ? Math.max(1, Math.ceil((plateCaptureDeadline - Date.now()) / 1000)) : 0,
      cleanPlateError: plateCaptureError,
      backgroundMethod: plateMethod,
      webrtcSendersCount: state.sendersCount,
      muted,
      mutedByExtension: state.mutedByExtension && muted === true,
    };
  }

  const messageHandlers = {
    PING: () => bridgeRequest("PING_BRIDGE").then((b) => {
      state.sendersCount = b.sendersCount ?? state.sendersCount;
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
    MUTE_TOGGLE: () => Promise.resolve(togglePlatformMicByRequest()),
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
    CAPTURE_CLEAN_PLATE: () => Promise.resolve(beginCleanPlateCapture()),
    REVIEW_CLEAN_PLATE: () => Promise.resolve(showCleanPlatePreview()),
    CANCEL_CLEAN_PLATE: () => Promise.resolve(plateCaptureDeadline ? cancelCleanPlateCapture() : { ok: false, reason: "no-capture-pending" }),
    CLEAR_CLEAN_PLATE: () => Promise.resolve(clearCleanPlate()),
    CALIBRATE_GESTURE: () => Promise.resolve({ ok: false, reason: "use-studio-calibration" }),
    SYNC_DASHBOARD_STATE: () => Promise.resolve(snapshotState()),
    // The offscreen document does not supply acoustic confirmation for a gesture.
    OFFSCREEN_EVENT: () => Promise.resolve({ ok: false, reason: "unsupported-offscreen-event" }),
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
  let startupTimer = 0;
  async function teardown() {
    if (tornDown) return;
    tornDown = true;
    transitionGeneration += 1;
    stopLoop();
    stopDetection();
    releaseHandModel();
    if (startupTimer) window.clearTimeout(startupTimer);
    observer?.disconnect();
    clearCleanPlate();
    if (personCanvas) { personCanvas.width = 0; personCanvas.height = 0; }
    if (plateCanvas) { plateCanvas.width = 0; plateCanvas.height = 0; }
    // Stop listening before awaiting any potentially slow bridge request.
    releaseAudio();
    if (state.cfg.camera?.autoRestoreOnLeave !== false) {
      await bridgeRequest("RESTORE_ORIGINAL_TRACK");
    }
  }

  window.addEventListener("pagehide", () => void teardown());

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      if (plateCaptureDeadline) cancelCleanPlateCapture("capture-interrupted");
      if (state.cfg.pauseWhenHidden) {
        releaseAudio();
        if (handModelBackend === "offscreen") releaseHandModel();
      }
      return;
    }
    audioStartFailed = false;
    audioGateError = null;
    videoCacheDirty = true;
    scheduleRectSync();
    startLoop();
    scheduleDetection();
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
  startupTimer = window.setTimeout(() => {
    startupTimer = 0;
    if (tornDown) return;
    void handshakeBridge();
    invalidateVideoCache();
    scheduleDetection();
  }, 1200);
})();
