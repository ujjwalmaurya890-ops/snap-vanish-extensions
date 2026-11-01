/**
 * Snap Vanish 2.0 — Isolated-World Conferencing Content Script
 *
 * Runs on Google Meet, Microsoft Teams Web, and Zoom Web Client.
 * Capabilities:
 * - Loads bundled local MediaPipe HandLandmarker WASM (`models/hand_landmarker.task`)
 *   entirely inside Chrome's ISOLATED world without external network requests.
 * - Multi-phase 21-landmark snap kinematics + optional 1.8–4.2 kHz acoustic gate.
 * - Coordinates with `main-world-bridge.js` to swap outgoing WebRTC video senders
 *   via `RTCRtpSender.replaceTrack()` during vanish/restore, with automatic DOM
 *   self-view overlay fallback and unconditional Emergency Restore (`Alt+Shift+R`).
 */
(() => {
  if (window.__snapVanishContentInitialized) return;
  window.__snapVanishContentInitialized = true;

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

  let cfg = structuredClone(DEFAULT_CFG);
  let engineState = "live"; // "live" | "vanishing" | "vanished" | "restoring"
  let interceptionMode = "dom-overlay"; // "webrtc-sender" | "dom-overlay"
  let webrtcSendersCount = 0;
  let mutedByExtension = false;

  // MediaPipe local hand landmarker state
  let handLandmarker = null;
  let handModelReady = false;
  let handModelLoading = false;
  let lastVideoTimestampMs = 0;

  // Snap state machine buffers
  const snapHistory = [];
  let lastSnapTriggeredAt = -Infinity;
  let pendingVisualSnapAt = null;

  // Optional RAM-only acoustic confirmation monitor
  let audioCtx = null;
  let audioAnalyser = null;
  let audioFloatBuf = null;
  let audioStream = null;
  let audioFloorDb = -60;
  let lastAudioOnsetAt = null;

  // Canvases & particle pool
  let rtcCanvas = null;
  let overlayCanvas = null;
  let bgPlateCanvas = null;
  let personSnapCanvas = null;
  let particles = [];
  let animRaf = 0;
  let animStartMs = 0;
  let hudEl = null;

  function sendBridgeCommand(action, extra = {}) {
    return new Promise((resolve) => {
      const requestId = `sv-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          window.removeEventListener("snap-vanish:bridge-ack", onAck);
          resolve({ ok: false, mode: "dom-overlay", sendersCount: 0 });
        }
      }, 600);

      function onAck(ev) {
        const d = ev && ev.detail ? ev.detail : {};
        if (d.requestId !== requestId) return;
        settled = true;
        clearTimeout(timer);
        window.removeEventListener("snap-vanish:bridge-ack", onAck);
        resolve(d);
      }

      window.addEventListener("snap-vanish:bridge-ack", onAck);
      window.dispatchEvent(
        new CustomEvent("snap-vanish:bridge-cmd", {
          detail: { requestId, action, ...extra },
        }),
      );
    });
  }

  function findSelfVideoElement() {
    const videos = Array.from(document.querySelectorAll("video")).filter(
      (v) => v.readyState >= 2 && v.videoWidth > 64 && v.videoHeight > 64,
    );
    if (videos.length === 0) return null;

    // Prefer mirrored / self-preview labeled video tiles on Meet/Teams/Zoom
    const selfCandidate = videos.find((v) => {
      const style = window.getComputedStyle(v);
      const label = (
        (v.getAttribute("aria-label") || "") +
        " " +
        (v.parentElement?.getAttribute("aria-label") || "")
      ).toLowerCase();
      return (
        style.transform.includes("-1") ||
        label.includes("you") ||
        label.includes("self") ||
        v.muted === true
      );
    });
    return selfCandidate || videos[0];
  }

  function togglePlatformMicMute(wantMuted) {
    const host = location.hostname;
    let selectors = [];
    if (host.includes("meet.google.com")) {
      selectors = [
        'button[aria-label*="microphone" i]',
        'button[data-is-muted]',
      ];
    } else if (host.includes("teams.")) {
      selectors = [
        'button[id*="microphone" i]',
        'button[aria-label*="Mute" i]',
        'button[aria-label*="Unmute" i]',
      ];
    } else if (host.includes("zoom.us")) {
      selectors = [
        'button[aria-label*="mute my microphone" i]',
        'button[aria-label*="unmute my microphone" i]',
      ];
    }

    for (const sel of selectors) {
      const btn = document.querySelector(sel);
      if (btn instanceof HTMLElement) {
        const label = (
          (btn.getAttribute("aria-label") || "") +
          " " +
          (btn.getAttribute("data-is-muted") || "")
        ).toLowerCase();
        const currentlyMuted =
          label.includes("unmute") ||
          label.includes("turn on microphone") ||
          btn.getAttribute("data-is-muted") === "true";
        if (wantMuted && !currentlyMuted) {
          btn.click();
          mutedByExtension = true;
          return true;
        }
        if (!wantMuted && currentlyMuted && mutedByExtension) {
          btn.click();
          mutedByExtension = false;
          return true;
        }
      }
    }
    return false;
  }

  function playConfirmationClick() {
    if (!cfg.sound) return;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      const ctx = new AC();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "triangle";
      osc.frequency.setValueAtTime(1450, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(340, ctx.currentTime + 0.065);
      gain.gain.setValueAtTime(0.16, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.075);
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.08);
      setTimeout(() => void ctx.close().catch(() => {}), 150);
    } catch {
      // Ignore optional sound errors
    }
  }

  function ensureCanvases(video) {
    const w = Math.min(1280, (video && video.videoWidth) || 640);
    const h = Math.min(720, (video && video.videoHeight) || 360);

    if (!rtcCanvas) {
      rtcCanvas = document.createElement("canvas");
      rtcCanvas.id = "snap-vanish-rtc-canvas";
      document.documentElement.appendChild(rtcCanvas);
    }
    if (rtcCanvas.width !== w || rtcCanvas.height !== h) {
      rtcCanvas.width = w;
      rtcCanvas.height = h;
    }

    if (!overlayCanvas) {
      overlayCanvas = document.createElement("canvas");
      overlayCanvas.id = "snap-vanish-overlay-canvas";
    }
    if (overlayCanvas.width !== w || overlayCanvas.height !== h) {
      overlayCanvas.width = w;
      overlayCanvas.height = h;
    }

    const parent = video ? video.parentElement : document.body;
    if (parent && overlayCanvas.parentElement !== parent) {
      const pos = window.getComputedStyle(parent).position;
      if (pos === "static") parent.style.position = "relative";
      parent.appendChild(overlayCanvas);
    }
  }

  function buildParticlesFromVideo(video) {
    const w = rtcCanvas.width;
    const h = rtcCanvas.height;

    if (!personSnapCanvas) personSnapCanvas = document.createElement("canvas");
    personSnapCanvas.width = w;
    personSnapCanvas.height = h;
    const pctx = personSnapCanvas.getContext("2d");
    if (video) {
      pctx.drawImage(video, 0, 0, w, h);
    } else {
      pctx.fillStyle = "#181a22";
      pctx.fillRect(0, 0, w, h);
    }

    if (!bgPlateCanvas) bgPlateCanvas = document.createElement("canvas");
    bgPlateCanvas.width = w;
    bgPlateCanvas.height = h;
    const bctx = bgPlateCanvas.getContext("2d");

    if (video) {
      // Extrapolate peripheral room strips for clean ambient background plate
      bctx.filter = "blur(22px) brightness(0.94)";
      bctx.drawImage(video, 0, 0, w, h);
      bctx.filter = "none";
      const borderW = Math.floor(w * 0.16);
      bctx.drawImage(video, 0, 0, borderW, h, 0, 0, borderW, h);
      bctx.drawImage(video, w - borderW, 0, borderW, h, w - borderW, 0, borderW, h);
    } else {
      bctx.fillStyle = "#0e1016";
      bctx.fillRect(0, 0, w, h);
    }

    const imgData = pctx.getImageData(0, 0, w, h).data;
    const maxCount = cfg.lowPowerMode ? 5500 : 12000;
    const stride = Math.max(3, Math.round(Math.sqrt((w * h * 0.45) / maxCount)));

    particles = [];
    const cx = w * 0.5;
    const cy = h * 0.56;
    const rx = w * 0.34;
    const ry = h * 0.46;

    for (let y = 0; y < h; y += stride) {
      for (let x = 0; x < w; x += stride) {
        const nx = (x - cx) / rx;
        const ny = (y - cy) / ry;
        if (nx * nx + ny * ny > 1.25) continue;
        const idx = (y * w + x) * 4;
        particles.push({
          x,
          y,
          r: imgData[idx],
          g: imgData[idx + 1],
          b: imgData[idx + 2],
          size: stride * (0.85 + Math.random() * 1.15) * (cfg.particleSize || 1),
          delay: (x / w) * 0.42 + Math.random() * 0.16,
          vx:
            cfg.direction === "left"
              ? -(95 + Math.random() * 140)
              : cfg.direction === "up"
                ? (Math.random() - 0.5) * 70
                : 95 + Math.random() * 140,
          vy:
            cfg.direction === "down"
              ? 65 + Math.random() * 110
              : -(45 + Math.random() * 115),
          spin: (Math.random() - 0.5) * 4.2,
          shard: Math.random() < 0.16,
        });
      }
    }
  }

  function renderTransitionFrame(t) {
    if (!rtcCanvas || !bgPlateCanvas || !personSnapCanvas) return;
    const w = rtcCanvas.width;
    const h = rtcCanvas.height;
    const ctx = rtcCanvas.getContext("2d");

    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(bgPlateCanvas, 0, 0, w, h);

    if (t <= 0.001) {
      const vid = findSelfVideoElement();
      if (vid) ctx.drawImage(vid, 0, 0, w, h);
    } else if (t < 0.999) {
      // Intact portion with smooth fade front
      ctx.save();
      ctx.globalAlpha = Math.max(0, 1 - t * 1.35);
      ctx.drawImage(personSnapCanvas, 0, 0, w, h);
      ctx.restore();

      const densityLimit = Math.floor(
        particles.length * Math.min(1, Math.max(0.2, (cfg.density || 80) / 100)),
      );
      for (let i = 0; i < densityLimit; i++) {
        const p = particles[i];
        const local = Math.max(0, Math.min(1, (t - p.delay) / 0.55));
        if (local <= 0 || local >= 1) continue;
        const ease = local * local * (3 - 2 * local);
        const px = p.x + p.vx * ease * (cfg.speed || 1);
        const py = p.y + p.vy * ease * (cfg.speed || 1);
        const alpha = (1 - ease) * 0.92;
        ctx.fillStyle =
          local < 0.22 && cfg.effect === "cinematic-disintegration"
            ? cfg.colorAccent || "#e0532c"
            : `rgba(${p.r},${p.g},${p.b},${alpha.toFixed(2)})`;
        if (p.shard) {
          ctx.save();
          ctx.translate(px, py);
          ctx.rotate(p.spin * ease);
          ctx.fillRect(-p.size * 0.6, -p.size * 0.4, p.size * 1.2, p.size * 0.8);
          ctx.restore();
        } else {
          ctx.fillRect(px, py, p.size, p.size);
        }
      }
    }

    if (overlayCanvas) {
      const octx = overlayCanvas.getContext("2d");
      octx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
      octx.drawImage(rtcCanvas, 0, 0, overlayCanvas.width, overlayCanvas.height);
    }
  }

  async function startTransition(target) {
    if (!cfg.enabled) return { ok: false, reason: "disabled" };
    if (engineState === "vanishing" || engineState === "restoring") {
      return { ok: false, reason: "busy", engineState };
    }
    const video = findSelfVideoElement();

    const goingOut =
      target === "vanish"
        ? true
        : target === "restore"
          ? false
          : engineState === "live";

    if (goingOut && engineState === "vanished") return { ok: true, engineState };
    if (!goingOut && engineState === "live") return { ok: true, engineState };

    ensureCanvases(video);
    engineState = goingOut ? "vanishing" : "restoring";
    if (goingOut) {
      buildParticlesFromVideo(video);
      if (overlayCanvas) overlayCanvas.style.display = "block";
      if (video) {
        const bridgeRes = await sendBridgeCommand("ATTACH_PROCESSED_STREAM", {
          canvasId: "snap-vanish-rtc-canvas",
          fps: cfg.lowPowerMode ? 20 : 30,
        });
        interceptionMode = bridgeRes.mode || "dom-overlay";
        webrtcSendersCount = bridgeRes.sendersCount || 0;
      } else {
        interceptionMode = "dom-overlay";
      }
      if (cfg.muteOnVanish) togglePlatformMicMute(true);
    }

    animStartMs = performance.now();
    playConfirmationClick();
    updateHud();

    cancelAnimationFrame(animRaf);
    const totalMs = Math.max(400, ((cfg.duration || 1.8) * 1000) / Math.max(0.5, cfg.speed || 1));

    const step = (now) => {
      const k = Math.min(1, (now - animStartMs) / totalMs);
      const t = goingOut ? k : 1 - k;
      renderTransitionFrame(t);

      if (k < 1) {
        animRaf = requestAnimationFrame(step);
      } else if (goingOut) {
        engineState = "vanished";
        updateHud();
        // Keep clean background plate alive at low cadence for WebRTC sender
        const keepAlive = () => {
          if (engineState !== "vanished") return;
          if (!(cfg.pauseWhenHidden && document.hidden)) {
            renderTransitionFrame(1);
          }
          setTimeout(() => {
            if (engineState === "vanished") animRaf = requestAnimationFrame(keepAlive);
          }, 120);
        };
        animRaf = requestAnimationFrame(keepAlive);
      } else {
        awaitLiveRestore();
      }
    };
    animRaf = requestAnimationFrame(step);
    return { ok: true, engineState, interceptionMode };
  }

  async function awaitLiveRestore() {
    cancelAnimationFrame(animRaf);
    engineState = "live";
    if (overlayCanvas) {
      const octx = overlayCanvas.getContext("2d");
      octx?.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
      overlayCanvas.style.display = "none";
    }
    await sendBridgeCommand("RESTORE_ORIGINAL_TRACK");
    if (cfg.muteOnVanish) togglePlatformMicMute(false);
    mutedByExtension = false;
    updateHud();
  }

  // Local MediaPipe HandLandmarker initialization inside ISOLATED world
  async function initLocalHandLandmarker() {
    if (handModelReady || handModelLoading || !chrome?.runtime?.getURL) return;
    handModelLoading = true;
    try {
      const wasmJsUrl = chrome.runtime.getURL("wasm/vision_wasm_module_internal.js");
      const wasmBinUrl = chrome.runtime.getURL("wasm/vision_wasm_module_internal.wasm");
      const bundleUrl = chrome.runtime.getURL("vendor/vision_bundle.mjs");
      const modelUrl = chrome.runtime.getURL("models/hand_landmarker.task");

      const wasmMod = await import(wasmJsUrl);
      if (wasmMod?.default && !globalThis.ModuleFactory) {
        globalThis.ModuleFactory = wasmMod.default;
      }
      const vision = await import(bundleUrl);
      const HandLandmarker = vision.HandLandmarker;

      try {
        handLandmarker = await HandLandmarker.createFromOptions(
          { wasmLoaderPath: "", wasmBinaryPath: wasmBinUrl },
          {
            baseOptions: { modelAssetPath: modelUrl, delegate: "GPU" },
            runningMode: "VIDEO",
            numHands: 1,
            minHandDetectionConfidence: cfg.gesture?.minHandConfidence || 0.62,
          },
        );
      } catch {
        handLandmarker = await HandLandmarker.createFromOptions(
          { wasmLoaderPath: "", wasmBinaryPath: wasmBinUrl },
          {
            baseOptions: { modelAssetPath: modelUrl, delegate: "CPU" },
            runningMode: "VIDEO",
            numHands: 1,
            minHandDetectionConfidence: cfg.gesture?.minHandConfidence || 0.62,
          },
        );
      }
      handModelReady = true;
    } catch {
      handModelReady = false;
    } finally {
      handModelLoading = false;
      updateHud();
    }
  }

  async function ensureAudioTransientGate() {
    if (!cfg.audio?.enabled || !cfg.gesture?.requireAudioConfirm || audioAnalyser) {
      return;
    }
    try {
      audioStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        video: false,
      });
      const AC = window.AudioContext || window.webkitAudioContext;
      audioCtx = new AC();
      const src = audioCtx.createMediaStreamSource(audioStream);
      const bp = audioCtx.createBiquadFilter();
      bp.type = "bandpass";
      bp.frequency.value = 2800;
      bp.Q.value = 1.2;
      audioAnalyser = audioCtx.createAnalyser();
      audioAnalyser.fftSize = 512;
      audioFloatBuf = new Float32Array(audioAnalyser.fftSize);
      src.connect(bp).connect(audioAnalyser);
    } catch {
      // Optional mic gate unavailable; fall back cleanly to visual gesture
      audioAnalyser = null;
    }
  }

  function pollAudioOnset(now) {
    if (!audioAnalyser || !audioFloatBuf) return null;
    audioAnalyser.getFloatTimeDomainData(audioFloatBuf);
    let sum = 0;
    for (let i = 0; i < audioFloatBuf.length; i++) {
      sum += audioFloatBuf[i] * audioFloatBuf[i];
    }
    const db = 20 * Math.log10(Math.sqrt(sum / audioFloatBuf.length) + 1e-9);
    const jump = db - audioFloorDb;
    if (jump < 3) {
      audioFloorDb += (db - audioFloorDb) * 0.04;
    }
    if (jump >= (cfg.audio?.sensitivityDb || 12)) {
      lastAudioOnsetAt = now;
    }
    return lastAudioOnsetAt;
  }

  function dist3(a, b) {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    const dz = (a.z || 0) - (b.z || 0);
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  function evaluateHandSnap(landmarks, worldLandmarks, now) {
    if (now - lastSnapTriggeredAt < (cfg.gesture?.cooldownMs || 2000)) {
      return false;
    }

    let pts;
    if (worldLandmarks && worldLandmarks.length === 21) {
      pts = worldLandmarks.map((p) => ({ x: p.x * 1000, y: p.y * 1000, z: (p.z || 0) * 1000 }));
    } else {
      const palm = Math.max(1e-4, dist3(landmarks[0], landmarks[9]));
      const scale = 82 / palm;
      pts = landmarks.map((p) => ({ x: p.x * scale, y: p.y * scale, z: (p.z || 0) * scale }));
    }

    const d = dist3(pts[4], pts[12]);
    snapHistory.push({ d, now });
    while (snapHistory.length > 0 && now - snapHistory[0].now > 240) {
      snapHistory.shift();
    }

    const maxRecent = snapHistory.reduce((m, s) => Math.max(m, s.d), 0);
    const gateMm = cfg.gesture?.calibratedCollapseThresholdMm || 12;

    if (maxRecent >= 26 && d <= gateMm) {
      pendingVisualSnapAt = now;
    }

    if (pendingVisualSnapAt !== null) {
      const win = cfg.audio?.confirmWindowMs || 220;
      if (now - pendingVisualSnapAt > win) {
        pendingVisualSnapAt = null;
        return false;
      }
      if (!cfg.gesture?.requireAudioConfirm || !audioAnalyser) {
        pendingVisualSnapAt = null;
        lastSnapTriggeredAt = now;
        snapHistory.length = 0;
        return true;
      }
      const onset = pollAudioOnset(now);
      if (onset !== null && Math.abs(onset - pendingVisualSnapAt) <= win) {
        pendingVisualSnapAt = null;
        lastSnapTriggeredAt = now;
        snapHistory.length = 0;
        return true;
      }
    }
    return false;
  }

  // Periodic low-overhead CV polling loop (respects visibilitychange and inferenceFpsLimit)
  function startDetectionLoop() {
    const tick = () => {
      const fpsCap = cfg.lowPowerMode ? 12 : (cfg.gesture?.inferenceFpsLimit || 20);
      const delay = Math.round(1000 / Math.max(8, fpsCap));

      if (
        cfg.enabled &&
        cfg.gesture?.enabled &&
        !(cfg.pauseWhenHidden && document.hidden) &&
        (engineState === "live" || engineState === "vanished")
      ) {
        const video = findSelfVideoElement();
        if (video) {
          if (!handModelReady && !handModelLoading) {
            void initLocalHandLandmarker();
            void ensureAudioTransientGate();
          } else if (handLandmarker && handModelReady) {
            const now = performance.now();
            pollAudioOnset(now);
            const ts = Math.max(lastVideoTimestampMs + 1, Math.floor(now));
            lastVideoTimestampMs = ts;
            try {
              const res = handLandmarker.detectForVideo(video, ts);
              if (res?.landmarks?.length > 0) {
                const triggered = evaluateHandSnap(
                  res.landmarks[0],
                  res.worldLandmarks?.[0],
                  now,
                );
                if (triggered) {
                  void startTransition("toggle");
                }
              }
            } catch {
              // Ignore single-frame video decode hiccup
            }
          }
        }
      }
      setTimeout(tick, delay);
    };
    setTimeout(tick, 1200);
  }

  function ensureHud() {
    if (!hudEl) {
      hudEl = document.createElement("div");
      hudEl.id = "snap-vanish-hud";
      hudEl.innerHTML = `
        <span class="sv-dot"></span>
        <span class="sv-label" id="sv-hud-text">Snap Vanish · Armed</span>
        <button type="button" class="sv-btn" id="sv-hud-toggle">Vanish</button>
        <button type="button" class="sv-btn sv-btn-restore" id="sv-hud-restore" title="Emergency Restore (Alt+Shift+R)">Restore</button>
      `;
      document.documentElement.appendChild(hudEl);
      hudEl.querySelector("#sv-hud-toggle")?.addEventListener("click", () => {
        void startTransition("toggle");
      });
      hudEl.querySelector("#sv-hud-restore")?.addEventListener("click", () => {
        void awaitLiveRestore();
      });
    }
    updateHud();
  }

  function updateHud() {
    if (!hudEl) return;
    hudEl.setAttribute("data-pos", cfg.hudPosition || "bottom-right");
    hudEl.setAttribute("data-hidden", cfg.showCallHud === false ? "true" : "false");
    hudEl.setAttribute("data-state", engineState);
    hudEl.setAttribute("data-enabled", String(Boolean(cfg.enabled)));

    const textEl = hudEl.querySelector("#sv-hud-text");
    const toggleBtn = hudEl.querySelector("#sv-hud-toggle");
    if (textEl) {
      if (!cfg.enabled) {
        textEl.textContent = "Snap Vanish · Paused";
      } else if (engineState === "vanished") {
        textEl.textContent = `Vanished · ${interceptionMode === "webrtc-sender" ? "WebRTC" : "Tile"}`;
      } else if (engineState === "vanishing" || engineState === "restoring") {
        textEl.textContent = "Transitioning…";
      } else {
        textEl.textContent = `Armed${handModelReady ? " · 21-Pt AI" : ""}`;
      }
    }
    if (toggleBtn) {
      toggleBtn.textContent = engineState === "vanished" ? "Return" : "Vanish";
    }
  }

  // Load initial settings from chrome.storage.sync (supports Promise and callback)
  if (chrome?.storage?.sync) {
    try {
      const applyStored = (stored) => {
        if (stored && typeof stored === "object") {
          const s = stored.snap_vanish_settings_v2 || stored;
          cfg = {
            ...cfg,
            ...s,
            gesture: { ...cfg.gesture, ...(s.gesture || {}) },
            audio: { ...cfg.audio, ...(s.audio || {}) },
          };
        }
        ensureHud();
      };
      const maybePromise = chrome.storage.sync.get(null, applyStored);
      if (maybePromise && typeof maybePromise.then === "function") {
        maybePromise.then(applyStored).catch(() => ensureHud());
      }
    } catch {
      ensureHud();
    }
  } else {
    ensureHud();
  }

  // Expose controlled diagnostic/test API on window.__snapVanish
  window.__snapVanish = {
    getState: () => ({
      engineState,
      interceptionMode,
      handModelReady,
      webrtcSendersCount,
      muted: mutedByExtension,
    }),
    triggerVanish: () => startTransition("vanish"),
    emergencyRestore: () => awaitLiveRestore(),
  };

  // Message listener from Popup, Studio, and Background Service Worker
  chrome?.runtime?.onMessage?.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg.type !== "string") return false;

    if (msg.type === "PING" || msg.type === "GET_STATE" || msg.type === "STATE") {
      sendBridgeCommand("PING_BRIDGE").then((b) => {
        webrtcSendersCount = b.sendersCount || 0;
        interceptionMode = b.mode || interceptionMode;
        sendResponse({
          ok: true,
          host: location.hostname,
          engineState,
          interceptionMode,
          detectionEnabled: Boolean(cfg.gesture?.enabled),
          handModelReady,
          webrtcSendersCount,
          muted: mutedByExtension,
        });
      });
      return true;
    }

    if (msg.type === "RUN_DIAGNOSTICS") {
      sendResponse({
        ok: true,
        engineState,
        interceptionMode,
        handModelReady,
        webrtcSendersCount,
        muted: mutedByExtension,
        diagnostics: {
          engineState,
          interceptionMode,
          lowPowerActive: Boolean(cfg.lowPowerMode),
        },
      });
      return false;
    }

    if (msg.type === "SNAP_NOW" || msg.type === "SNAP_TOGGLE") {
      startTransition("toggle").then(sendResponse);
      return true;
    }
    if (msg.type === "SNAP_VANISH_NOW") {
      startTransition("vanish").then(sendResponse);
      return true;
    }
    if (msg.type === "SNAP_RESTORE_NOW") {
      startTransition("restore").then(sendResponse);
      return true;
    }
    if (msg.type === "MUTE_TOGGLE") {
      const toggled = togglePlatformMicMute(!mutedByExtension);
      sendResponse({ ok: toggled, muted: mutedByExtension });
      return false;
    }
    if (msg.type === "EMERGENCY_RESTORE" || msg.type === "RESET_FRAME") {
      awaitLiveRestore().then(() =>
        sendResponse({ ok: true, engineState: "live", muted: mutedByExtension }),
      );
      return true;
    }
    if (msg.type === "SETTINGS_CHANGED" || msg.type === "SETTINGS") {
      const p = msg.payload || msg.settings || {};
      cfg = {
        ...cfg,
        ...p,
        gesture: { ...cfg.gesture, ...(p.gesture || {}) },
        audio: { ...cfg.audio, ...(p.audio || {}) },
      };
      updateHud();
      sendResponse({ ok: true });
      return false;
    }
    return false;
  });

  window.addEventListener("pagehide", () => {
    if (cfg.camera?.autoRestoreOnLeave !== false) {
      void awaitLiveRestore();
    }
    if (audioStream) {
      for (const tr of audioStream.getTracks()) tr.stop();
    }
    if (handLandmarker && typeof handLandmarker.close === "function") {
      try {
        handLandmarker.close();
      } catch {
        // Ignore
      }
    }
  });

  startDetectionLoop();
})();
