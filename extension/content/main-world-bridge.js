/**
 * Snap Vanish 2.0 — MAIN-World WebRTC Sender Bridge
 *
 * Injected at `document_start` in `"world": "MAIN"` on supported meeting domains.
 * Responsibilities:
 * 1. Non-destructively observe `RTCPeerConnection` instances and track active
 *    outgoing video `RTCRtpSender`s along with their original camera `MediaStreamTrack`.
 * 2. Swap outgoing video senders to a processed canvas stream (`canvas.captureStream(30)`)
 *    ONLY during vanish/gone/returning phases via `RTCRtpSender.replaceTrack()`.
 * 3. Unconditionally restore the original hardware camera `MediaStreamTrack` upon
 *    restore completion, emergency restore, or error — never leaving a dead stream.
 */
(() => {
  if (window.__snapVanishMainBridgeInstalled) return;
  window.__snapVanishMainBridgeInstalled = true;

  const peerConnections = new Set();
  const originalTracksBySender = new WeakMap();
  let activeCanvasStream = null;

  const NativeRTCPeerConnection = window.RTCPeerConnection;
  if (typeof NativeRTCPeerConnection === "function") {
    const WrappedRTCPeerConnection = function (...args) {
      const pc = new NativeRTCPeerConnection(...args);
      peerConnections.add(pc);
      pc.addEventListener("connectionstatechange", () => {
        if (pc.connectionState === "closed") {
          peerConnections.delete(pc);
        }
      });
      return pc;
    };
    WrappedRTCPeerConnection.prototype = NativeRTCPeerConnection.prototype;
    Object.setPrototypeOf(WrappedRTCPeerConnection, NativeRTCPeerConnection);
    try {
      window.RTCPeerConnection = WrappedRTCPeerConnection;
    } catch {
      // Host froze window.RTCPeerConnection; fallback to DOM overlay cleanly
    }
  }

  function getActiveVideoSenders() {
    const senders = [];
    for (const pc of peerConnections) {
      if (pc.signalingState === "closed" || pc.connectionState === "closed") {
        peerConnections.delete(pc);
        continue;
      }
      try {
        for (const sender of pc.getSenders()) {
          if (sender && sender.track && sender.track.kind === "video") {
            if (!originalTracksBySender.has(sender)) {
              originalTracksBySender.set(sender, sender.track);
            }
            senders.push(sender);
          } else if (sender && originalTracksBySender.has(sender)) {
            senders.push(sender);
          }
        }
      } catch {
        // Ignore closed PC
      }
    }
    return senders;
  }

  async function attachCanvasStream(canvasId, fps = 30) {
    const canvas = document.getElementById(canvasId);
    if (!canvas || typeof canvas.captureStream !== "function") {
      return { ok: false, mode: "dom-overlay", sendersCount: 0, reason: "no-canvas" };
    }
    const senders = getActiveVideoSenders();
    if (senders.length === 0) {
      return { ok: false, mode: "dom-overlay", sendersCount: 0, reason: "no-webrtc-senders" };
    }

    try {
      if (!activeCanvasStream) {
        activeCanvasStream = canvas.captureStream(Math.min(30, Math.max(15, fps)));
      }
      const processedTrack = activeCanvasStream.getVideoTracks()[0];
      if (!processedTrack) {
        return { ok: false, mode: "dom-overlay", sendersCount: senders.length, reason: "no-canvas-track" };
      }

      let replaced = 0;
      for (const sender of senders) {
        try {
          if (!originalTracksBySender.has(sender) && sender.track) {
            originalTracksBySender.set(sender, sender.track);
          }
          await sender.replaceTrack(processedTrack);
          replaced += 1;
        } catch {
          // Individual sender rejected replaceTrack
        }
      }

      return {
        ok: replaced > 0,
        mode: replaced > 0 ? "webrtc-sender" : "dom-overlay",
        sendersCount: replaced,
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
    const senders = getActiveVideoSenders();
    let restored = 0;
    for (const sender of senders) {
      const origTrack = originalTracksBySender.get(sender);
      if (origTrack && origTrack.readyState === "live") {
        try {
          await sender.replaceTrack(origTrack);
          restored += 1;
        } catch {
          // Ignore closed sender
        }
      }
    }
    if (activeCanvasStream) {
      for (const tr of activeCanvasStream.getTracks()) {
        try {
          tr.stop();
        } catch {
          // Ignore
        }
      }
      activeCanvasStream = null;
    }
    return { ok: true, restoredCount: restored, sendersCount: senders.length };
  }

  window.addEventListener("snap-vanish:bridge-cmd", async (ev) => {
    const detail = ev && ev.detail ? ev.detail : {};
    const { requestId, action, canvasId, fps } = detail;
    if (!action) return;

    let response = { ok: false };
    if (action === "PING_BRIDGE") {
      const senders = getActiveVideoSenders();
      response = {
        ok: true,
        sendersCount: senders.length,
        mode: senders.length > 0 ? "webrtc-sender" : "dom-overlay",
      };
    } else if (action === "ATTACH_PROCESSED_STREAM") {
      response = await attachCanvasStream(canvasId || "snap-vanish-rtc-canvas", fps || 30);
    } else if (action === "RESTORE_ORIGINAL_TRACK") {
      response = await restoreOriginalCameraTracks();
    }

    window.dispatchEvent(
      new CustomEvent("snap-vanish:bridge-ack", {
        detail: { requestId, action, ...response },
      }),
    );
  });
})();
