/**
 * MAIN-world WebRTC bridge. Only camera tracks observed from getUserMedia, and
 * their observed clones, may be replaced. Screen capture and unrecognised tracks
 * are deliberately left untouched. A preview video must carry the same camera
 * source as an outgoing sender before it can be used to build the effect.
 *
 * The DOM event channel is visible to the meeting page; its token is diagnostic,
 * not authentication. Never send camera pixels or device identifiers over it.
 */
(() => {
  if (window.__snapVanishMainBridgeInstalled) return;
  window.__snapVanishMainBridgeInstalled = true;

  const TAG = "[snap-vanish/bridge]";
  const TOKEN = `svb-${Math.random().toString(36).slice(2, 10)}`;
  const CANVAS_ID = "snap-vanish-rtc-canvas";
  const peerConnections = new Set();
  const cameraSources = new WeakMap();
  const originalTracksBySender = new WeakMap();
  const swappedSenders = new Set();
  const internalCalls = new WeakSet();
  const hostOperations = new WeakMap();
  const streamByCanvas = new WeakMap();
  let activeCanvasStream = null;
  let activeProcessedTrack = null;
  let canvasElement = null;
  let generation = 0;
  let transaction = Promise.resolve();

  const finalizer = typeof FinalizationRegistry === "function"
    ? new FinalizationRegistry((ref) => peerConnections.delete(ref))
    : null;

  function registerPeerConnection(pc) {
    for (const ref of peerConnections) if (ref.deref() === pc) return;
    const ref = new WeakRef(pc);
    peerConnections.add(ref);
    finalizer?.register(pc, ref);
    try {
      pc.addEventListener("connectionstatechange", () => {
        if (pc.connectionState === "closed" || pc.signalingState === "closed") {
          peerConnections.delete(ref);
        }
      });
    } catch { /* The page may provide a partial WebRTC implementation. */ }
  }

  function livePeerConnections() {
    const live = [];
    for (const ref of peerConnections) {
      const pc = ref.deref();
      if (!pc || pc.connectionState === "closed" || pc.signalingState === "closed") {
        peerConnections.delete(ref);
      } else {
        live.push(pc);
      }
    }
    return live;
  }

  const NativeRTCPeerConnection = window.RTCPeerConnection;
  if (typeof NativeRTCPeerConnection === "function") {
    const WrappedRTCPeerConnection = new Proxy(NativeRTCPeerConnection, {
      construct(target, args, newTarget) {
        const pc = Reflect.construct(target, args,
          newTarget === WrappedRTCPeerConnection ? target : newTarget);
        registerPeerConnection(pc);
        return pc;
      },
    });
    try {
      Object.defineProperty(window, "RTCPeerConnection", {
        value: WrappedRTCPeerConnection, configurable: true, writable: true, enumerable: true,
      });
    } catch {
      console.info(TAG, "RTCPeerConnection is not patchable; camera interception unavailable");
    }
  }

  // Legacy Chromium display capture can arrive through getUserMedia rather than
  // getDisplayMedia. Treat any screen-related constraint as ambiguous, including
  // nested `mandatory` / `advanced` constraints; ambiguity must fail closed.
  function hasDisplayConstraint(value, visited = new WeakSet(), depth = 0) {
    if (!value || typeof value !== "object") return false;
    if (depth > 8) return true;
    if (visited.has(value)) return false;
    visited.add(value);
    for (const [key, child] of Object.entries(value)) {
      if (/^(chromeMediaSource|mediaSource|mozMediaSource|displaySurface)$/i.test(key)) return true;
      if (hasDisplayConstraint(child, visited, depth + 1)) return true;
    }
    return false;
  }

  function isCameraTrack(track) {
    if (!track || track.kind !== "video" || track.readyState !== "live" || !cameraSources.has(track)) {
      return false;
    }
    try {
      const settings = typeof track.getSettings === "function" ? track.getSettings() : {};
      const constraints = typeof track.getConstraints === "function" ? track.getConstraints() : {};
      return !settings?.displaySurface && !hasDisplayConstraint(constraints);
    } catch {
      return false;
    }
  }

  const mediaDevices = navigator.mediaDevices;
  const nativeGetUserMedia = mediaDevices?.getUserMedia;
  if (typeof nativeGetUserMedia === "function") {
    try {
      mediaDevices.getUserMedia = function observedGetUserMedia(constraints) {
        let cameraRequest = false;
        try { cameraRequest = Boolean(constraints?.video) && !hasDisplayConstraint(constraints.video); }
        catch { /* A malformed request is not evidence of a camera. */ }
        const result = Reflect.apply(nativeGetUserMedia, this, [constraints]);
        if (!cameraRequest) return result;
        return result.then((stream) => {
          try {
            for (const track of stream.getVideoTracks()) {
              const settings = typeof track.getSettings === "function" ? track.getSettings() : {};
              const trackConstraints = typeof track.getConstraints === "function" ? track.getConstraints() : {};
              if (track.kind === "video" && !settings?.displaySurface && !hasDisplayConstraint(trackConstraints)) {
                cameraSources.set(track, {});
              }
            }
          } catch { /* Unknown source: leave it unclassified. */ }
          return stream;
        });
      };
    } catch { /* Unpatchable mediaDevices: fail closed. */ }
  }

  const trackProto = typeof MediaStreamTrack !== "undefined" ? MediaStreamTrack.prototype : null;
  const nativeClone = trackProto?.clone;
  if (typeof nativeClone === "function") {
    try {
      trackProto.clone = function observedClone() {
        const clone = nativeClone.call(this);
        const source = cameraSources.get(this);
        if (source) cameraSources.set(clone, source);
        return clone;
      };
    } catch { /* Clones without provenance are ignored. */ }
  }

  function previewSources(element) {
    const sources = new Set();
    if (!element || element.tagName !== "VIDEO" || !element.isConnected) return sources;
    try {
      const stream = element.srcObject;
      if (!stream || typeof stream.getVideoTracks !== "function") return sources;
      for (const track of stream.getVideoTracks()) {
        if (isCameraTrack(track)) sources.add(cameraSources.get(track));
      }
    } catch { /* An inaccessible or non-MediaStream preview is not verified. */ }
    return sources;
  }

  function collectCameraSenders(sources = null) {
    const senders = [];
    for (const pc of livePeerConnections()) {
      let list;
      try { list = pc.getSenders(); } catch { continue; }
      for (const sender of list) {
        if (!sender) continue;
        const current = sender.track;
        const camera = current === activeProcessedTrack && swappedSenders.has(sender)
          ? originalTracksBySender.get(sender)
          : current;
        if (!isCameraTrack(camera)) continue;
        if (sources && !sources.has(cameraSources.get(camera))) continue;
        if (current !== activeProcessedTrack) originalTracksBySender.set(sender, camera);
        senders.push(sender);
      }
    }
    return senders;
  }

  function firstVideoSettings(sources = null) {
    for (const sender of collectCameraSenders(sources)) {
      const camera = originalTracksBySender.get(sender);
      try {
        const settings = camera?.getSettings?.();
        if (settings?.width && settings?.height) {
          return { width: settings.width, height: settings.height, frameRate: settings.frameRate ?? null };
        }
      } catch { /* Try the next camera. */ }
    }
    return null;
  }

  const senderProto = typeof RTCRtpSender !== "undefined" ? RTCRtpSender.prototype : null;
  const nativeReplaceTrack = senderProto?.replaceTrack;
  let observedReplaceTrack = null;
  const lastAcceptedHostTrack = new WeakMap();
  if (typeof nativeReplaceTrack === "function") {
    try {
      observedReplaceTrack = function observedReplaceTrack(track) {
        if (internalCalls.has(this)) return nativeReplaceTrack.call(this, track);
        const sender = this;
        const previous = hostOperations.get(sender);
        const operation = { version: (previous?.version ?? 0) + 1, track, succeeded: false, done: null };
        hostOperations.set(sender, operation);
        let result;
        try { result = nativeReplaceTrack.call(sender, track); }
        catch (error) { operation.done = Promise.resolve(); throw error; }
        operation.done = Promise.resolve(result).then(() => {
          operation.succeeded = true;
          if (sender.track === track) lastAcceptedHostTrack.set(sender, track);
          if (hostOperations.get(sender) === operation && sender.track === track) {
            if (isCameraTrack(track)) originalTracksBySender.set(sender, track);
            else originalTracksBySender.delete(sender);
            if (track !== activeProcessedTrack) swappedSenders.delete(sender);
          }
        });
        return operation.done;
      };
      senderProto.replaceTrack = observedReplaceTrack;
      if (senderProto.replaceTrack !== observedReplaceTrack) observedReplaceTrack = null;
    } catch { observedReplaceTrack = null; }
  }

  function callReplaceTrack(sender, track) {
    if (typeof sender.replaceTrack !== "function") throw new Error("replaceTrack unavailable");
    internalCalls.add(sender);
    try { return sender.replaceTrack(track); }
    finally { internalCalls.delete(sender); }
  }

  // If a host camera switch overlaps an extension replaceTrack, the browser may
  // settle them in either order. Reapply the host's latest successful choice
  // after our operation, instead of restoring a stale camera or undoing camera-off.
  async function honorHostChanges(sender, startingVersion, fallback) {
    let seen = startingVersion;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const operation = hostOperations.get(sender);
      if (!operation || operation.version === seen) return true;
      try { await operation.done; } catch { /* Failed host request: retain fallback. */ }
      if (hostOperations.get(sender) !== operation) continue;
      const desired = operation.succeeded
        ? operation.track
        : lastAcceptedHostTrack.has(sender) ? lastAcceptedHostTrack.get(sender) : fallback;
      if (sender.track !== desired) {
        try { await callReplaceTrack(sender, desired); }
        catch { return false; }
      }
      seen = operation.version;
      if (hostOperations.get(sender) === operation) return true;
    }
    return false;
  }

  function captureStreamFor(canvas, fps) {
    const existing = streamByCanvas.get(canvas);
    const [live] = existing?.getVideoTracks() ?? [];
    if (live?.readyState === "live") return existing;
    const stream = canvas.captureStream(Math.max(5, Math.min(30, fps | 0 || 30)));
    streamByCanvas.set(canvas, stream);
    const [track] = stream.getVideoTracks();
    if (track) {
      try { track.contentHint = "detail"; } catch { /* optional */ }
    }
    return stream;
  }

  function releaseProcessedIfUnused() {
    if (!activeProcessedTrack) return;
    for (const sender of swappedSenders) {
      if (sender.track !== activeProcessedTrack) swappedSenders.delete(sender);
    }
    let attached = swappedSenders.size > 0;
    for (const pc of livePeerConnections()) {
      try { if (pc.getSenders().some((sender) => sender.track === activeProcessedTrack)) attached = true; }
      catch { /* A closed connection does not retain a live sender. */ }
    }
    if (!attached) {
      try { activeProcessedTrack.stop(); } catch { /* already stopped */ }
      activeProcessedTrack = null;
      activeCanvasStream = null;
    }
  }

  async function restoreOriginalCameraTracks() {
    const targets = [...swappedSenders];
    let restored = 0;
    let failed = 0;
    for (const sender of targets) {
      if (sender.track !== activeProcessedTrack) {
        swappedSenders.delete(sender);
        continue;
      }
      const original = originalTracksBySender.get(sender);
      if (!isCameraTrack(original)) { failed += 1; continue; }
      const version = hostOperations.get(sender)?.version ?? 0;
      try {
        await callReplaceTrack(sender, original);
        const respectedHost = await honorHostChanges(sender, version, original);
        if (!respectedHost || sender.track === activeProcessedTrack) { failed += 1; continue; }
        swappedSenders.delete(sender);
        restored += 1;
      } catch { failed += 1; }
    }
    releaseProcessedIfUnused();
    return {
      ok: failed === 0,
      restoredCount: restored,
      failedCount: failed,
      sendersCount: swappedSenders.size,
      mode: failed ? "webrtc-sender" : "dom-overlay",
      reason: failed ? "restore-failed" : undefined,
    };
  }

  async function attachProcessedStream(detail, preview, requestedGeneration) {
    if (requestedGeneration !== generation) return { ok: false, reason: "cancelled" };
    const sources = previewSources(preview);
    if (!sources.size) return { ok: false, mode: "dom-overlay", sendersCount: 0, reason: "unverified-camera-preview" };
    if (detail.canvasId !== CANVAS_ID) return { ok: false, mode: "dom-overlay", sendersCount: 0, reason: "unknown-canvas" };
    const canvas = document.getElementById(CANVAS_ID);
    if (!canvas || typeof canvas.captureStream !== "function") {
      return { ok: false, mode: "dom-overlay", sendersCount: 0, reason: "no-canvas" };
    }
    const senders = collectCameraSenders(sources);
    if (!senders.length) return { ok: false, mode: "dom-overlay", sendersCount: 0, reason: "no-matching-camera-senders" };
    // A per-instance or overwritten method can bypass our host-change observer.
    // Refuse interception rather than risk undoing the meeting's camera controls.
    if (!observedReplaceTrack || senders.some((sender) => sender.replaceTrack !== observedReplaceTrack)) {
      return { ok: false, mode: "dom-overlay", sendersCount: 0, reason: "unobservable-sender" };
    }
    canvasElement = canvas;
    let reason = null;
    try {
      const stream = captureStreamFor(canvas, detail.fps ?? 30);
      const [processed] = stream.getVideoTracks();
      if (!processed || processed.readyState !== "live") {
        return { ok: false, mode: "dom-overlay", sendersCount: 0, reason: "no-live-canvas-track" };
      }
      activeCanvasStream = stream;
      activeProcessedTrack = processed;
      for (const sender of senders) {
        if (requestedGeneration !== generation) { reason = "cancelled"; break; }
        if (sender.track === processed && swappedSenders.has(sender)) continue;
        const original = sender.track;
        if (!isCameraTrack(original) || !sources.has(cameraSources.get(original))) {
          reason = "camera-changed";
          break;
        }
        const version = hostOperations.get(sender)?.version ?? 0;
        originalTracksBySender.set(sender, original);
        try { await callReplaceTrack(sender, processed); }
        catch { reason = "replace-rejected"; break; }
        if (sender.track === processed) swappedSenders.add(sender);
        if ((hostOperations.get(sender)?.version ?? 0) !== version) {
          const respectedHost = await honorHostChanges(sender, version, original);
          if (sender.track !== processed) swappedSenders.delete(sender);
          reason = respectedHost ? "camera-changed" : "host-change-reconciliation-failed";
          break;
        }
        if (sender.track !== processed) { reason = "camera-changed"; break; }
      }
      if (requestedGeneration !== generation && !reason) reason = "cancelled";
      if (!reason) {
        return { ok: true, mode: "webrtc-sender", sendersCount: senders.length };
      }
    } catch { reason = "replace-failed"; }

    const rollback = await restoreOriginalCameraTracks();
    return {
      ok: false,
      mode: rollback.ok ? "dom-overlay" : "webrtc-sender",
      sendersCount: rollback.sendersCount,
      reason: rollback.ok ? reason : "rollback-failed",
    };
  }

  function enqueue(work) {
    const next = transaction.then(work, work);
    transaction = next.then(() => undefined, () => undefined);
    return next;
  }

  // The listener observes the event target so the bridge itself can verify the
  // video preview; no DOM marker or track ID is trusted across worlds.
  window.addEventListener("snap-vanish:bridge-cmd", async (event) => {
    const detail = event?.detail ?? {};
    const { requestId, action, token } = detail;
    if (!action) return;
    let response = { ok: false, reason: "unknown-action" };
    try {
      if (action === "CHECK_CAMERA_PREVIEW") {
        response = { ok: previewSources(event.target).size > 0 };
      } else if (action === "HELLO" || (action === "PING_BRIDGE" && token === TOKEN)) {
        const sources = event.target?.tagName === "VIDEO" ? previewSources(event.target) : null;
        const senders = collectCameraSenders(sources);
        response = {
          ok: true, token: TOKEN, sendersCount: senders.length,
          mode: swappedSenders.size ? "webrtc-sender" : "dom-overlay",
          videoSettings: firstVideoSettings(sources), canvasAttached: swappedSenders.size > 0,
        };
      } else if (action === "ATTACH_PROCESSED_STREAM") {
        const requestedGeneration = generation;
        const preview = event.target;
        response = await enqueue(() => attachProcessedStream(detail, preview, requestedGeneration));
      } else if (action === "RESTORE_ORIGINAL_TRACK") {
        generation += 1;
        response = await enqueue(restoreOriginalCameraTracks);
      }
    } catch (error) {
      response = { ok: false, reason: "bridge-error", error: error instanceof Error ? error.message : String(error) };
    }
    window.dispatchEvent(new CustomEvent("snap-vanish:bridge-ack", {
      detail: { requestId, action, ...response },
    }));
  }, true);

  window.addEventListener("pagehide", () => {
    generation += 1;
    void enqueue(restoreOriginalCameraTracks).catch(() => {});
  });

  Object.defineProperty(window, "__snapVanishBridge", {
    value: Object.freeze({
      get token() { return TOKEN; },
      get state() {
        return {
          peerConnections: livePeerConnections().length,
          senders: collectCameraSenders().length,
          attached: swappedSenders.size,
          canvasId: canvasElement?.id ?? null,
          streamAlive: Boolean(activeCanvasStream),
        };
      },
    }),
    configurable: true,
  });
})();
