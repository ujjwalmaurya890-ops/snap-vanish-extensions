import { AcousticSnapConfirmer, SNAP_CONSTANTS } from "../../lib/gestureEngine";

export interface AudioDeviceOption {
  deviceId: string;
  label: string;
}

export interface AudioMonitorSnapshot {
  active: boolean;
  permission: "granted" | "denied" | "prompt" | "unknown";
  currentDb: number;
  floorDb: number;
  jumpDb: number;
  levelPercent: number; // 0 - 100 UI meter
  lastTransientAt: number | null;
  deviceLabel: string;
}

export async function enumerateAudioInputDevices(): Promise<AudioDeviceOption[]> {
  if (
    typeof navigator === "undefined" ||
    !navigator.mediaDevices ||
    typeof navigator.mediaDevices.enumerateDevices !== "function"
  ) {
    return [];
  }
  try {
    const all = await navigator.mediaDevices.enumerateDevices();
    return all
      .filter((d) => d.kind === "audioinput")
      .map((d, idx) => ({
        deviceId: d.deviceId,
        label: d.label || `Microphone ${idx + 1}`,
      }));
  } catch {
    return [];
  }
}

/**
 * Live Web Audio API Acoustic Confirmation Engine.
 *
 * Security & Privacy Guarantee:
 * - Processes only ephemeral 512-sample Float32Array frames via AnalyserNode.
 * - Never instantiates MediaRecorder, never stores PCM buffers, and never uploads audio.
 * - Disables browser noiseSuppression/autoGainControl on the local analysis stream so
 *   crisp 2.5-5.5 kHz finger-snap transients are not filtered out by WebRTC voice DSP.
 */
export class LiveAudioConfirmationEngine {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private analyser: AnalyserNode | null = null;
  private buffer: Float32Array<ArrayBuffer> | null = null;
  private confirmer = new AcousticSnapConfirmer();
  private sensitivityDb: number = SNAP_CONSTANTS.AUDIO_MIN_DB_JUMP;
  private permissionState: "granted" | "denied" | "prompt" | "unknown" = "unknown";
  private activeDeviceLabel = "Default Microphone";
  private lastSnapshot: AudioMonitorSnapshot = {
    active: false,
    permission: "unknown",
    currentDb: -90,
    floorDb: -60,
    jumpDb: 0,
    levelPercent: 0,
    lastTransientAt: null,
    deviceLabel: "Microphone Off",
  };
  private onDisconnectCallback: (() => void) | null = null;
  private generation = 0;

  setSensitivityDb(db: number) {
    this.sensitivityDb = Math.max(6, Math.min(28, db));
  }

  async start(options: {
    preferredDeviceId?: string;
    sensitivityDb?: number;
    onDisconnected?: () => void;
  } = {}): Promise<{ ok: boolean; error?: unknown; cancelled?: boolean }> {
    this.stop();
    const requestedGeneration = this.generation;
    if (options.sensitivityDb !== undefined) {
      this.setSensitivityDb(options.sensitivityDb);
    }
    this.onDisconnectCallback = options.onDisconnected ?? null;

    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      return { ok: false, error: new Error("MediaDevices unavailable") };
    }

    let stream: MediaStream | null = null;
    let ctx: AudioContext | null = null;
    const disposeUnowned = () => {
      if (stream && this.stream !== stream) {
        for (const track of stream.getTracks()) {
          try { if (track.readyState !== "ended") track.stop(); } catch { /* best effort */ }
        }
      }
      if (ctx && this.ctx !== ctx && ctx.state !== "closed") {
        void ctx.close().catch(() => {});
      }
    };

    try {
      const audioConstraints: MediaTrackConstraints = {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      };
      if (options.preferredDeviceId) {
        audioConstraints.deviceId = { exact: options.preferredDeviceId };
      }
      stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints, video: false });
      if (requestedGeneration !== this.generation) {
        disposeUnowned();
        return { ok: false, cancelled: true };
      }

      const AC = window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!AC) throw new Error("AudioContext unavailable");
      ctx = new AC();
      // Publish resources before resuming so stop() can release a pending start.
      this.stream = stream;
      this.ctx = ctx;
      if (ctx.state === "suspended") await ctx.resume();
      if (requestedGeneration !== this.generation) {
        disposeUnowned();
        return { ok: false, cancelled: true };
      }
      if (ctx.state !== "running") throw new Error("AudioContext is not running");
      const source = ctx.createMediaStreamSource(stream);
      const bandpass = ctx.createBiquadFilter();
      bandpass.type = "bandpass";
      bandpass.frequency.value =
        (SNAP_CONSTANTS.AUDIO_BAND_HZ[0] + SNAP_CONSTANTS.AUDIO_BAND_HZ[1]) / 2;
      bandpass.Q.value = 1.15;
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      source.connect(bandpass).connect(analyser);

      const audioTrack = stream.getAudioTracks()[0];
      if (audioTrack) {
        this.activeDeviceLabel = audioTrack.label || "Microphone Active";
        audioTrack.addEventListener("ended", () => {
          if (this.stream !== stream) return;
          const onDisconnected = this.onDisconnectCallback;
          this.stop();
          onDisconnected?.();
        }, { once: true });
      }

      this.analyser = analyser;
      this.buffer = new Float32Array(new ArrayBuffer(analyser.fftSize * 4));
      this.confirmer.reset();
      this.permissionState = "granted";
      this.lastSnapshot = {
        ...this.lastSnapshot,
        active: true,
        permission: "granted",
        deviceLabel: this.activeDeviceLabel,
      };
      return { ok: true };
    } catch (err) {
      if (requestedGeneration !== this.generation) {
        disposeUnowned();
        return { ok: false, cancelled: true };
      }
      const name = err instanceof DOMException ? err.name : "";
      if (name === "NotAllowedError" || name === "PermissionDeniedError") {
        this.permissionState = "denied";
      }
      if (this.stream === stream || this.ctx === ctx) this.stop();
      disposeUnowned();
      this.lastSnapshot = { ...this.lastSnapshot, active: false, permission: this.permissionState };
      return { ok: false, error: err };
    }
  }

  /**
   * Polls the current audio frame and updates transient onset + level telemetry.
   */
  poll(now = performance.now()): AudioMonitorSnapshot {
    if (!this.analyser || !this.buffer || !this.stream || this.ctx?.state !== "running") {
      return { ...this.lastSnapshot, active: false };
    }

    this.analyser.getFloatTimeDomainData(this.buffer);
    const res = this.confirmer.evaluateSamples(
      this.buffer,
      now,
      this.sensitivityDb,
    );

    const normalizedLevel = Math.max(
      0,
      Math.min(100, Math.round(((res.currentDb + 65) / 55) * 100)),
    );

    this.lastSnapshot = {
      active: true,
      permission: this.permissionState,
      currentDb: Number(res.currentDb.toFixed(1)),
      floorDb: Number(res.floorDb.toFixed(1)),
      jumpDb: Number(res.jumpDb.toFixed(1)),
      levelPercent: normalizedLevel,
      lastTransientAt:
        res.onsetAt ?? this.confirmer.getLastConfirmedOnset() ?? null,
      deviceLabel: this.activeDeviceLabel,
    };
    return this.lastSnapshot;
  }

  getSnapshot(): AudioMonitorSnapshot {
    return this.lastSnapshot;
  }

  /**
   * Runs a self-contained synthetic acoustic transient test to verify
   * threshold settings even when no hardware microphone is connected.
   */
  runSyntheticTransientTest(
    sensitivityDbOverride?: number,
    now = performance.now(),
  ): {
    confirmed: boolean;
    jumpDb: number;
    thresholdDb: number;
  } {
    const threshold =
      typeof sensitivityDbOverride === "number"
        ? sensitivityDbOverride
        : this.sensitivityDb;
    const tester = new AcousticSnapConfirmer();
    const quiet = new Float32Array(256).fill(0.0006);
    const snap = new Float32Array(256).fill(0.22);
    tester.evaluateSamples(quiet, now - 80, threshold);
    const evalRes = tester.evaluateSamples(snap, now, threshold);
    return {
      confirmed: evalRes.onsetAt !== null,
      jumpDb: Number(evalRes.jumpDb.toFixed(1)),
      thresholdDb: threshold,
    };
  }

  stop() {
    this.generation += 1;
    this.onDisconnectCallback = null;
    if (this.stream) {
      for (const track of this.stream.getTracks()) {
        try {
          track.stop();
        } catch {
          // Ignore
        }
      }
      this.stream = null;
    }
    if (this.ctx && this.ctx.state !== "closed") {
      void this.ctx.close().catch(() => {});
    }
    this.ctx = null;
    this.analyser = null;
    this.buffer = null;
    this.lastSnapshot = {
      ...this.lastSnapshot,
      active: false,
      levelPercent: 0,
      currentDb: -90,
      jumpDb: 0,
      deviceLabel: "Microphone Off",
    };
  }
}
