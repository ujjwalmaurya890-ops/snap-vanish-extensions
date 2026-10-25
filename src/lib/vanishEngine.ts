import type {
  EngineState,
  InterceptionMode,
  ResourceCleanupStatus,
  SnapSettings,
} from "../types/snapVanish";
import { DEFAULT_SETTINGS, validateSettings } from "./settings";

export interface EngineTransitionResult {
  accepted: boolean;
  previousState: EngineState;
  nextState: EngineState;
  reason?: string;
}

export type EngineStateListener = (
  state: EngineState,
  progress: number,
  error: string | null,
) => void;

export class VanishEngineController {
  private state: EngineState = "live";
  private progress = 0; // 0 = live, 1 = vanished
  private lastError: string | null = null;
  private initialized = false;
  private settings: SnapSettings;
  private muted = false;
  private interceptionMode: InterceptionMode = "preview-only";
  private transitionTimer: ReturnType<typeof setTimeout> | null = null;
  private lastTriggerTimestamp = -Infinity;
  private listeners = new Set<EngineStateListener>();
  private attachedTracks: MediaStreamTrack[] = [];
  private trackEndedHandlers = new Map<MediaStreamTrack, () => void>();
  private cleanupStatus: ResourceCleanupStatus = {
    animationFrameActive: false,
    mediaTracksActive: 0,
    audioContextState: "uninitialized",
    activeListeners: 0,
    lastCleanedAt: null,
  };

  constructor(initialSettings: SnapSettings = DEFAULT_SETTINGS) {
    this.settings = validateSettings(initialSettings).sanitized;
  }

  /**
   * Idempotent initialization — protects against duplicate initialization.
   */
  initialize(mode: InterceptionMode = "preview-only"): {
    alreadyInitialized: boolean;
    state: EngineState;
  } {
    if (this.initialized) {
      return { alreadyInitialized: true, state: this.state };
    }
    this.initialized = true;
    this.interceptionMode = mode;
    this.state = "live";
    this.progress = 0;
    this.lastError = null;
    this.notify();
    return { alreadyInitialized: false, state: this.state };
  }

  get isInitialized(): boolean {
    return this.initialized;
  }

  get currentState(): EngineState {
    return this.state;
  }

  get currentProgress(): number {
    return this.progress;
  }

  get error(): string | null {
    return this.lastError;
  }

  get isMuted(): boolean {
    return this.muted;
  }

  get currentInterceptionMode(): InterceptionMode {
    return this.interceptionMode;
  }

  get currentSettings(): SnapSettings {
    return this.settings;
  }

  get resourceStatus(): ResourceCleanupStatus {
    return {
      ...this.cleanupStatus,
      mediaTracksActive: this.attachedTracks.filter(
        (t) => t.readyState === "live",
      ).length,
      activeListeners: this.listeners.size + this.trackEndedHandlers.size,
    };
  }

  updateSettings(patch: Partial<SnapSettings>): SnapSettings {
    this.settings = validateSettings(
      { ...this.settings, ...patch },
      this.settings,
    ).sanitized;
    return this.settings;
  }

  subscribe(listener: EngineStateListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Toggles between live and vanished states with protection against:
   * - disabled extension
   * - mid-transition repeated triggers
   * - rapid cooldown violations
   */
  toggle(now = Date.now(), bypassCooldown = false): EngineTransitionResult {
    const prev = this.state;
    if (!this.settings.enabled) {
      return {
        accepted: false,
        previousState: prev,
        nextState: prev,
        reason: "extension-disabled",
      };
    }

    if (prev === "vanishing" || prev === "restoring") {
      return {
        accepted: false,
        previousState: prev,
        nextState: prev,
        reason: "transition-in-progress",
      };
    }

    if (prev === "error") {
      return {
        accepted: false,
        previousState: prev,
        nextState: prev,
        reason: "engine-in-error-state-use-emergency-restore",
      };
    }

    if (
      !bypassCooldown &&
      now - this.lastTriggerTimestamp < Math.min(350, this.settings.gesture.cooldownMs)
    ) {
      return {
        accepted: false,
        previousState: prev,
        nextState: prev,
        reason: "cooldown-active",
      };
    }

    this.lastTriggerTimestamp = now;
    if (prev === "live") {
      return this.startVanish();
    } else {
      return this.startRestore();
    }
  }

  /**
   * Immediate vanish action (e.g., Alt+Shift+D command).
   */
  vanishNow(instant = false): EngineTransitionResult {
    const prev = this.state;
    if (!this.settings.enabled) {
      return {
        accepted: false,
        previousState: prev,
        nextState: prev,
        reason: "extension-disabled",
      };
    }
    if (prev === "vanished") {
      return {
        accepted: false,
        previousState: prev,
        nextState: prev,
        reason: "already-vanished",
      };
    }
    if (prev === "vanishing" && !instant) {
      return {
        accepted: false,
        previousState: prev,
        nextState: prev,
        reason: "transition-in-progress",
      };
    }
    if (instant) {
      this.clearTransitionTimer();
      this.state = "vanished";
      this.progress = 1;
      if (this.settings.muteOnVanish) {
        this.muted = true;
      }
      this.notify();
      return {
        accepted: true,
        previousState: prev,
        nextState: "vanished",
      };
    }
    return this.startVanish();
  }

  private startVanish(): EngineTransitionResult {
    const prev = this.state;
    this.clearTransitionTimer();
    this.state = "vanishing";
    if (this.settings.muteOnVanish) {
      this.muted = true;
    }
    this.notify();

    const durationMs = Math.max(
      350,
      Math.round((this.settings.duration / this.settings.speed) * 1000),
    );
    this.transitionTimer = setTimeout(() => {
      if (this.state === "vanishing") {
        this.state = "vanished";
        this.progress = 1;
        this.transitionTimer = null;
        this.notify();
      }
    }, durationMs);

    return {
      accepted: true,
      previousState: prev,
      nextState: "vanishing",
    };
  }

  private startRestore(): EngineTransitionResult {
    const prev = this.state;
    this.clearTransitionTimer();
    this.state = "restoring";
    this.muted = false;
    this.notify();

    const durationMs = Math.max(
      350,
      Math.round((this.settings.duration / this.settings.speed) * 1000),
    );
    this.transitionTimer = setTimeout(() => {
      if (this.state === "restoring") {
        this.state = "live";
        this.progress = 0;
        this.transitionTimer = null;
        this.notify();
      }
    }, durationMs);

    return {
      accepted: true,
      previousState: prev,
      nextState: "restoring",
    };
  }

  /**
   * Emergency Restore — unconditionally recovers the live camera feed and unmutes
   * from ANY state (including mid-transition, vanished, error, or disabled).
   */
  emergencyRestore(): EngineTransitionResult {
    const prev = this.state;
    this.clearTransitionTimer();
    this.state = "live";
    this.progress = 0;
    this.muted = false;
    this.lastError = null;
    this.notify();
    return {
      accepted: true,
      previousState: prev,
      nextState: "live",
      reason: "emergency-restored",
    };
  }

  toggleMute(): boolean {
    this.muted = !this.muted;
    this.notify();
    return this.muted;
  }

  /**
   * Attaches media tracks and monitors for unexpected track end or revocation.
   */
  attachMediaTracks(tracks: MediaStreamTrack[]) {
    this.detachMediaTracks();
    for (const track of tracks) {
      this.attachedTracks.push(track);
      const onEnded = () => {
        this.handleTrackEnded(track);
      };
      this.trackEndedHandlers.set(track, onEnded);
      track.addEventListener("ended", onEnded);
    }
  }

  detachMediaTracks() {
    for (const [track, handler] of this.trackEndedHandlers.entries()) {
      track.removeEventListener("ended", handler);
    }
    this.trackEndedHandlers.clear();
    this.attachedTracks = [];
  }

  /**
   * Invoked when a camera/mic track ends unexpectedly or permission is revoked.
   * Ensures safe recovery rather than leaving a stuck vanished state.
   */
  handleTrackEnded(track?: MediaStreamTrack): EngineTransitionResult {
    const prev = this.state;
    this.clearTransitionTimer();
    this.muted = false;
    this.progress = 0;
    this.state = "error";
    this.lastError = track
      ? `Media track (${track.kind}) ended unexpectedly. Restored safe state.`
      : "Camera/microphone permission was revoked or device disconnected.";
    this.notify();
    return {
      accepted: true,
      previousState: prev,
      nextState: "error",
      reason: "track-ended",
    };
  }

  handlePermissionDenied(detail = "Camera or microphone permission denied"): EngineTransitionResult {
    const prev = this.state;
    this.clearTransitionTimer();
    this.muted = false;
    this.progress = 0;
    this.state = "error";
    this.lastError = detail;
    this.notify();
    return {
      accepted: true,
      previousState: prev,
      nextState: "error",
      reason: "permission-denied",
    };
  }

  /**
   * Safe fallback when an effect throws during rendering: falls back to simple fade-out
   * without crashing the user's call.
   */
  handleEffectFailure(err: unknown): {
    fallbackEffect: "fade-out";
    message: string;
  } {
    const message =
      err instanceof Error ? err.message : "Effect failed; fell back to fade-out";
    this.settings = {
      ...this.settings,
      effect: "fade-out",
    };
    this.lastError = `Effect fallback activated: ${message}`;
    this.notify();
    return {
      fallbackEffect: "fade-out",
      message: this.lastError,
    };
  }

  setAnimationFrameActive(active: boolean) {
    this.cleanupStatus.animationFrameActive = active;
  }

  setAudioContextState(
    state: "closed" | "running" | "suspended" | "uninitialized",
  ) {
    this.cleanupStatus.audioContextState = state;
  }

  /**
   * Complete resource cleanup (timers, listeners, tracks).
   */
  dispose() {
    this.clearTransitionTimer();
    for (const track of this.attachedTracks) {
      try {
        if (typeof track.stop === "function") {
          track.stop();
        }
      } catch {
        // Ignore track stop errors
      }
    }
    this.detachMediaTracks();
    this.listeners.clear();
    this.initialized = false;
    this.state = "live";
    this.progress = 0;
    this.muted = false;
    this.cleanupStatus = {
      animationFrameActive: false,
      mediaTracksActive: 0,
      audioContextState: "closed",
      activeListeners: 0,
      lastCleanedAt: new Date().toISOString(),
    };
  }

  private clearTransitionTimer() {
    if (this.transitionTimer !== null) {
      clearTimeout(this.transitionTimer);
      this.transitionTimer = null;
    }
  }

  private notify() {
    for (const listener of this.listeners) {
      listener(this.state, this.progress, this.lastError);
    }
  }
}
