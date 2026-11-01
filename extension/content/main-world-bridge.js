/**
 * Snap Vanish 2.0 — MAIN-World WebRTC Sender Bridge
 *
 * Injected at `document_start` in `"world": "MAIN"` on supported meeting domains.
 *
 * RESPONSIBILITIES
 * 1. Non-destructively observe `RTCPeerConnection` instances and track outgoing
 *    video `RTCRtpSender`s together with their original camera `MediaStreamTrack`.
 * 2. Swap outgoing video senders to the processed canvas stream
 *    (`canvas.captureStream(fps)`) only during vanish / gone / returning phases.
 * 3. Unconditionally restore the original hardware camera track on restore,
 *    emergency restore, or error — never leaving a dead stream on the wire.
 *
 * HARDENING NOTES (see docs/OPTIMIZATION_REPORT.md §3)
 * - `window.RTCPeerConnection` is replaced with a `Proxy`, not a plain function,
 *   so static methods (`generateCertificate`), `instanceof`, and `class X extends
 *   RTCPeerConnection` keep working. The previous wrapper returned the native
 *   instance from a normal function, which breaks subclass construction and
 *   drops the static surface.
 * - The peer-connection registry stores `WeakRef`s and is pruned by a
 *   `FinalizationRegistry`; the old `Set<RTCPeerConnection>` was a hard leak for
 *   any page that abandoned a connection without firing `connectionstatechange`.
 * - `captureStream()` tracks are reference-counted. Previously a restore stopped
 *   the canvas track while other senders could still be attached to it, which
 *   produced a permanently black outgoing feed.
 * - `RTCRtpSender.prototype.replaceTrack` is patched so a *host-initiated* camera
 *   switch (device change, virtual-camera toggle) becomes the new "original"
 *   track instead of being silently overwritten by our stale reference.
 */

(() => {
  if (window.__snapVanishMainBridgeInstalled) return;
  window.__snapVanishMainBridgeInstalled = true;

  const TAG = "[snap-vanish/bridge]";
  const CANVAS_IDS = new Set(["snap-vanish-rtc-canvas"]);
  const TOKEN = `svb-${Math.random().toString(36).slice(2, 10)}`;

  /** @type {Set<WeakRef<RTCPeerConnection>>} */
  const peerConnections = new Set();
  /** @type {WeakMap<RTCRtpSender, MediaStreamTrack>} */
  const originalTracksBySender = new WeakMap();
  /** @type {WeakSet<RTCRtpSender>} senders we may have swapped */
  const knownSenders = new WeakSet();
  /** @type {Set<RTCRtpSender>} senders currently carrying our processed track */
  const swappedSenders = new Set();

  /** @type {MediaStream | null} */
  let activeCanvasStream = null;
  /** @type {MediaStreamTrack | null} */
  let activeProcessedTrack = null;
  /** @type {WeakMap<HTMLCanvasElement, MediaStream>} */
  const streamByCanvas = new WeakMap();
  /** @type {HTMLCanvasElement | null} */
  let canvasElement = null;

  const finalizer =
    typeof FinalizationRegistry === "function"
      ? new FinalizationRegistry((ref) => {
          peerConnections.delete(ref);
        })
      : null;

  /* ------------------------------------------------------------------ *
   * Registry
   * ------------------------------------------------------------------ */

  function registerPeerConnection(pc) {
    for (const ref of peerConnections) {
      if (ref.deref() === pc) return;
    }
    const ref = new WeakRef(pc);
    peerConnections.add(ref);
    finalizer?.register(pc, ref);
    const prune = () => {
      if (pc.connectionState === "closed" || pc.signalingState === "closed") {
        peerConnections.delete(ref);
      }
    };
    try {
      pc.addEventListener("connectionstatechange", prune);
    } catch {
      /* ignore */
    }
  }

  function livePeerConnections() {
    const live = [];
    for (const ref of peerConnections) {
      const pc = ref.deref();
      if (!pc) {
        peerConnections.delete(ref);
        continue;
      }
      if (pc.connectionState === "closed" || pc.signalingState === "closed") {
        peerConnections.delete(ref);
        continue;
      }
      live.push(pc);
    }
    return live;
  }

  /* ------------------------------------------------------------------ *
   * RTCPeerConnection interception
   * ------------------------------------------------------------------ */

  const NativeRTCPeerConnection = window.RTCPeerConnection;
  if (typeof NativeRTCPeerConnection === "function") {
    const WrappedRTCPeerConnection = new Proxy(NativeRTCPeerConnection, {
      construct(target, args, newTarget) {
        const pc = Reflect.construct(
          target,
          args,
          newTarget === WrappedRTCPeerConnection ? target : newTarget,
        );
        registerPeerConnection(pc);
        return pc;
      },
    });

    try {
      Object.defineProperty(window, "RTCPeerConnection", {
        value: WrappedRTCPeerConnection,
        configurable: true,
        writable: true,
        enumerable: true,
      });
    } catch {
      // Host froze window.RTCPeerConnection; the DOM overlay path still works.
      console.info(TAG, "RTCPeerConnection is not patchable; overlay-only mode");
    }
  }

  /* ------------------------------------------------------------------ *
   * Sender bookkeeping
   * ------------------------------------------------------------------ */

  function collectVideoSenders() {
    const senders = [];
    for (const pc of livePeerConnections()) {
      let list;
      try {
        list = pc.getSenders();
      } catch {
        continue;
      }
      for (const sender of list) {
        if (!sender) continue;
        const track = sender.track;
        if (track && track.kind === "video") {
          if (!originalTracksBySender.has(sender)) {
            originalTracksBySender.set(sender, track);
          }
          knownSenders.add(sender);
          senders.push(sender);
        } else if (knownSenders.has(sender)) {
          senders.push(sender);
        }
      }
    }
    return senders;
  }

  /** Accurate negotiated video settings — lets the caller match resolution. */
  function firstVideoSettings() {
    for (const sender of collectVideoSenders()) {
      const original = originalTracksBySender.get(sender);
      const track = original ?? sender.track;
      if (!track || typeof track.getSettings !== "function") continue;
      try {
        const s = track.getSettings();
        if (s.width && s.height) {
          return {
            width: s.width,
            height: s.height,
            frameRate: s.frameRate ?? null,
            label: track.label ?? null,
          };
        }
      } catch {
        /* ignore */
      }
    }
    return null;
  }

  // Host-initiated replaceTrack (device switch, virtual camera) must update our
  // notion of "the original track", otherwise restore would put back a dead one.
  const senderProto =
    typeof RTCRtpSender !== "undefined" ? RTCRtpSender.prototype : null;
  const nativeReplaceTrack =
    senderProto && typeof senderProto.replaceTrack === "function"
      ? senderProto.replaceTrack
      : null;
  let applyingInternally = false;

  if (senderProto && nativeReplaceTrack) {
    senderProto.replaceTrack = function patchedReplaceTrack(track) {
      if (
        !applyingInternally &&
        track &&
        track.kind === "video" &&
        knownSenders.has(this) &&
        track !== activeProcessedTrack
      ) {
        originalTracksBySender.set(this, track);
        swappedSenders.delete(this);
      }
      return nativeReplaceTrack.call(this, track);
    };
  }

  /**
   * Calls `replaceTrack` through the sender's own method when present (hosts and
   * polyfills sometimes install a per-instance wrapper), falling back to the
   * native prototype implementation.
   */
  function callReplaceTrack(sender, track) {
    if (typeof sender.replaceTrack === "function") {
      return sender.replaceTrack(track);
    }
    if (nativeReplaceTrack) return nativeReplaceTrack.call(sender, track);
    throw new Error("replaceTrack unavailable");
  }

  /* ------------------------------------------------------------------ *
   * Attach / restore
   * ------------------------------------------------------------------ */

  function captureStreamFor(canvas, fps) {
    const existing = streamByCanvas.get(canvas);
    if (existing) {
      const [live] = existing.getVideoTracks();
      if (live && live.readyState === "live") return existing;
      // The browser reclaimed the capture track (tab discard / canvas teardown).
      streamByCanvas.delete(canvas);
    }
    const stream = canvas.captureStream(Math.max(5, Math.min(30, fps | 0 || 30)));
    streamByCanvas.set(canvas, stream);
    const [track] = stream.getVideoTracks();
    if (track) {
      // 'detail' keeps the encoder from pre-blurring the dust; the canvas is a
      // synthetic source so it must not be downscaled as if it were motion.
      try {
        track.contentHint = "detail";
      } catch {
        /* not supported */
      }
    }
    return stream;
  }

  async function attachProcessedStream(detail) {
    const canvasId = detail.canvasId;
    if (!CANVAS_IDS.has(canvasId)) {
      return { ok: false, mode: "dom-overlay", sendersCount: 0, reason: "unknown-canvas" };
    }
    const canvas = document.getElementById(canvasId);
    if (!canvas || typeof canvas.captureStream !== "function") {
      return { ok: false, mode: "dom-overlay", sendersCount: 0, reason: "no-canvas" };
    }
    canvasElement = canvas;

    const senders = collectVideoSenders();
    if (senders.length === 0) {
      return {
        ok: false,
        mode: "dom-overlay",
        sendersCount: 0,
        reason: "no-webrtc-senders",
      };
    }

    try {
      const stream = captureStreamFor(canvas, detail.fps ?? 30);
      const [processed] = stream.getVideoTracks();
      if (!processed) {
        return {
          ok: false,
          mode: "dom-overlay",
          sendersCount: senders.length,
          reason: "no-canvas-track",
        };
      }
      activeCanvasStream = stream;
      activeProcessedTrack = processed;
      if (processed.readyState === "ended") {
        return {
          ok: false,
          mode: "dom-overlay",
          sendersCount: senders.length,
          reason: "canvas-track-ended",
        };
      }

      let replaced = 0;
      applyingInternally = true;
      try {
        for (const sender of senders) {
          if (sender.track === processed) {
            swappedSenders.add(sender);
            replaced += 1;
            continue;
          }
          try {
            await callReplaceTrack(sender, processed);
            swappedSenders.add(sender);
            replaced += 1;
          } catch {
            // Individual sender rejected replaceTrack (e.g. already closed).
          }
        }
      } finally {
        applyingInternally = false;
      }

      return {
        ok: replaced > 0,
        mode: replaced > 0 ? "webrtc-sender" : "dom-overlay",
        sendersCount: replaced,
        totalSenders: senders.length,
        reason: replaced > 0 ? undefined : "replace-rejected",
      };
    } catch (err) {
      return {
        ok: false,
        mode: "dom-overlay",
        sendersCount: 0,
        reason: err instanceof Error ? err.message : "replace-failed",
      };
    }
  }

  async function restoreOriginalCameraTracks() {
    const targets = new Set(swappedSenders);
    for (const sender of collectVideoSenders()) {
      if (knownSenders.has(sender)) targets.add(sender);
    }

    let restored = 0;
    applyingInternally = true;
    try {
      for (const sender of targets) {
        const original = originalTracksBySender.get(sender);
        if (!original) continue;
        if (sender.track === original) {
          swappedSenders.delete(sender);
          continue;
        }
        try {
          await callReplaceTrack(sender, original);
          swappedSenders.delete(sender);
          restored += 1;
        } catch {
          // Sender closed mid-flight; nothing to restore on the wire.
        }
      }
    } finally {
      applyingInternally = false;
    }

    // Only release the synthetic source once no sender references it. Stopping a
    // still-attached track is what produced the "permanently black camera" bug.
    if (swappedSenders.size === 0) {
      if (activeProcessedTrack) {
        try {
          const anyAttached = collectVideoSenders().some(
            (s) => s.track === activeProcessedTrack,
          );
          if (!anyAttached) activeProcessedTrack.stop();
        } catch {
          /* ignore */
        }
      }
      activeProcessedTrack = null;
      activeCanvasStream = null;
    }

    return {
      ok: true,
      restoredCount: restored,
      sendersCount: targets.size,
      mode: "dom-overlay",
    };
  }

  /* ------------------------------------------------------------------ *
   * Command channel (ISOLATED world <-> MAIN world)
   * ------------------------------------------------------------------ */

  /** Re-entrancy guards: a second attach/restore while one is running is a bug. */
  const inFlight = { attach: false, restore: false };

  window.addEventListener("snap-vanish:bridge-cmd", async (ev) => {
    const detail = ev && ev.detail ? ev.detail : {};
    const { requestId, action, token } = detail;
    if (!action) return;

    let response = { ok: false, reason: "unknown-action" };

    // Cheap abuse guard: the bridge is necessarily reachable from page script
    // (MAIN world), so we only rate-limit and validate rather than pretend to
    // authenticate. See report §3.
    const attachAction = action === "ATTACH_PROCESSED_STREAM";
    const restoreAction = action === "RESTORE_ORIGINAL_TRACK";
    const busy =
      (attachAction && inFlight.attach) || (restoreAction && inFlight.restore);

    if (busy) {
      response = { ok: false, reason: "in-flight" };
    } else {
      if (attachAction) inFlight.attach = true;
      if (restoreAction) inFlight.restore = true;
      try {
        if (action === "PING_BRIDGE" && token === TOKEN) {
          const senders = collectVideoSenders();
          response = {
            ok: true,
            token: TOKEN,
            sendersCount: senders.length,
            mode: senders.length > 0 ? "webrtc-sender" : "dom-overlay",
            videoSettings: firstVideoSettings(),
            canvasAttached: swappedSenders.size > 0,
          };
        } else if (action === "HELLO") {
          response = {
            ok: true,
            token: TOKEN,
            sendersCount: collectVideoSenders().length,
            videoSettings: firstVideoSettings(),
          };
        } else if (action === "ATTACH_PROCESSED_STREAM") {
          response = await attachProcessedStream(detail);
        } else if (action === "RESTORE_ORIGINAL_TRACK") {
          response = await restoreOriginalCameraTracks();
        }
      } catch (err) {
        response = {
          ok: false,
          reason: "bridge-error",
          error: err instanceof Error ? err.message : String(err),
        };
      } finally {
        inFlight.attach = false;
        inFlight.restore = false;
      }
    }

    window.dispatchEvent(
      new CustomEvent("snap-vanish:bridge-ack", {
        detail: { requestId, action, ...response },
      }),
    );
  });

  // Ensure a closed/broken sender never keeps us attached to a dead canvas.
  window.addEventListener("pagehide", () => {
    void restoreOriginalCameraTracks().catch(() => {});
  });

  // Debug handle for the extension's own diagnostics page.
  Object.defineProperty(window, "__snapVanishBridge", {
    value: Object.freeze({
      get token() {
        return TOKEN;
      },
      get state() {
        return {
          peerConnections: livePeerConnections().length,
          senders: collectVideoSenders().length,
          attached: swappedSenders.size,
          canvasId: canvasElement?.id ?? null,
          streamAlive: Boolean(activeCanvasStream),
        };
      },
    }),
    configurable: true,
  });
})();
