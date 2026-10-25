// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BUILT_IN_PRESETS,
  DEFAULT_SETTINGS,
  MEETING_MODES,
  createPresetFromSettings,
  deletePreset,
  duplicatePreset,
  loadPresets,
  loadSettings,
  loadSettingsSync,
  mergeAndValidateSettings,
  renamePreset,
  saveSettings,
  validateSettings,
} from "../lib/settings";
import {
  sendExtensionMessage,
  validateExtensionMessage,
} from "../lib/messaging";
import { VanishEngineController } from "../lib/vanishEngine";
import {
  AcousticSnapConfirmer,
  SnapGestureDetector,
  createSyntheticHandFrame,
} from "../lib/gestureEngine";
import { DustScene, hexToRgb, windFor } from "../lib/dust";
import {
  clearAnalyticsData,
  getWeeklyUsageSummary,
  loadAnalytics,
  recordAnalyticsEvent,
} from "../lib/analytics";
import {
  FramePerformanceTracker,
  appendDiagnosticLog,
  clearDiagnosticLogs,
  loadDiagnosticLogs,
} from "../lib/diagnostics";
import {
  authenticateWithCloud,
  getCloudSyncStatus,
  getEntitlementState,
  resolvePresetSyncConflicts,
} from "../lib/cloudAndBilling";
import {
  clearAllFeedback,
  deleteFeedbackSubmission,
  submitFeedback,
} from "../lib/feedbackAndChangelog";

describe("1. Settings Validation & Persistence", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("validates DEFAULT_SETTINGS with zero issues", () => {
    const res = validateSettings(DEFAULT_SETTINGS);
    expect(res.valid).toBe(true);
    expect(res.issues).toHaveLength(0);
    expect(res.sanitized).toEqual(DEFAULT_SETTINGS);
  });

  it("clamps out-of-range numbers and rejects invalid enums/colors", () => {
    const res = validateSettings({
      enabled: "not-a-boolean",
      sensitivity: 185,
      duration: 0.1,
      speed: 9.5,
      particleSize: 0.1,
      density: 5,
      intensity: 999,
      direction: "diagonal",
      effect: "quantum-teleport",
      colorAccent: "not-a-hex",
      meetingMode: "invalid-mode",
      gesture: {
        cooldownMs: 100,
        calibratedCollapseThresholdMm: 99,
        actionMapping: "invalid-action",
      },
    });

    expect(res.valid).toBe(false);
    expect(res.issues.length).toBeGreaterThanOrEqual(11);
    expect(res.sanitized.enabled).toBe(true);
    expect(res.sanitized.sensitivity).toBe(100);
    expect(res.sanitized.duration).toBe(0.5);
    expect(res.sanitized.speed).toBe(2.5);
    expect(res.sanitized.particleSize).toBe(0.5);
    expect(res.sanitized.density).toBe(20);
    expect(res.sanitized.intensity).toBe(100);
    expect(res.sanitized.direction).toBe("right");
    expect(res.sanitized.effect).toBe("dust");
    expect(res.sanitized.colorAccent).toBe("#d2451e");
    expect(res.sanitized.meetingMode).toBe("creative");
    expect(res.sanitized.gesture.cooldownMs).toBe(500);
    expect(res.sanitized.gesture.calibratedCollapseThresholdMm).toBe(25);
    expect(res.sanitized.gesture.actionMapping).toBe("toggle-vanish");
  });

  it("persists and loads settings across localStorage and chrome.storage.sync", async () => {
    const mockSyncStore: Record<string, unknown> = {};
    (globalThis as Record<string, unknown>).chrome = {
      storage: {
        sync: {
          get: vi.fn(async () => ({ ...mockSyncStore })),
          set: vi.fn(async (items: Record<string, unknown>) => {
            Object.assign(mockSyncStore, items);
          }),
        },
      },
    };

    const updated = mergeAndValidateSettings(DEFAULT_SETTINGS, {
      effect: "digital-glitch",
      duration: 2.4,
      sensitivity: 77,
    }).sanitized;

    await saveSettings(updated);
    expect(loadSettingsSync().effect).toBe("digital-glitch");
    expect(loadSettingsSync().sensitivity).toBe(77);
    expect(loadSettingsSync().gesture.sensitivity).toBe(77);

    // Clear localStorage to verify chrome.storage.sync fallback restoration
    localStorage.clear();
    const restoredFromChrome = await loadSettings();
    expect(restoredFromChrome.effect).toBe("digital-glitch");
    expect(restoredFromChrome.duration).toBe(2.4);

    delete (globalThis as Record<string, unknown>).chrome;
  });

  it("applies Smart Meeting Modes with real parameter values", () => {
    const pro = mergeAndValidateSettings(
      DEFAULT_SETTINGS,
      MEETING_MODES.professional.settingsPatch,
    ).sanitized;
    expect(pro.effect).toBe("fade-out");
    expect(pro.sound).toBe(false);
    expect(pro.sensitivity).toBe(78);

    const lowPower = mergeAndValidateSettings(
      DEFAULT_SETTINGS,
      MEETING_MODES["low-power"].settingsPatch,
    ).sanitized;
    expect(lowPower.lowPowerMode).toBe(true);
    expect(lowPower.density).toBe(30);
  });
});

describe("2. Preset Creation, Editing, Duplication, Deletion & Restoration", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("loads built-in presets by default and supports full CRUD lifecycle", () => {
    const initial = loadPresets();
    expect(initial.length).toBe(BUILT_IN_PRESETS.length);

    // Create custom preset
    const afterCreate = createPresetFromSettings(
      "My Studio Glitch",
      "Custom cyan glitch exit",
      {
        ...DEFAULT_SETTINGS,
        effect: "digital-glitch",
        colorAccent: "#06b6d4",
      },
    );
    expect(afterCreate.length).toBe(BUILT_IN_PRESETS.length + 1);
    const created = afterCreate[afterCreate.length - 1];
    expect(created.name).toBe("My Studio Glitch");
    expect(created.isBuiltIn).toBe(false);

    // Rename custom preset
    const afterRename = renamePreset(
      created.id,
      "Renamed Studio Glitch",
      "Updated description",
    );
    const renamed = afterRename.find((p) => p.id === created.id);
    expect(renamed?.name).toBe("Renamed Studio Glitch");
    expect(renamed?.description).toBe("Updated description");

    // Duplicate preset
    const afterDup = duplicatePreset(created.id);
    expect(afterDup.length).toBe(BUILT_IN_PRESETS.length + 2);
    expect(afterDup[afterDup.length - 1].name).toBe(
      "Renamed Studio Glitch (Copy)",
    );

    // Protect built-in presets from deletion
    const afterTryDeleteBuiltIn = deletePreset(BUILT_IN_PRESETS[0].id);
    expect(
      afterTryDeleteBuiltIn.some((p) => p.id === BUILT_IN_PRESETS[0].id),
    ).toBe(true);

    // Delete custom preset
    const afterDeleteCustom = deletePreset(created.id);
    expect(afterDeleteCustom.some((p) => p.id === created.id)).toBe(false);
  });
});

describe("3. Extension Message Validation & Service-Worker Restart Handling", () => {
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).chrome;
  });

  it("accepts valid messages and rejects malformed or unknown messages", () => {
    expect(validateExtensionMessage({ type: "SNAP_TOGGLE" }).valid).toBe(true);
    expect(
      validateExtensionMessage({
        type: "SETTINGS_CHANGED",
        payload: { duration: 2.0 },
      }).valid,
    ).toBe(true);

    expect(validateExtensionMessage(null).valid).toBe(false);
    expect(validateExtensionMessage("SNAP_TOGGLE").valid).toBe(false);
    expect(validateExtensionMessage({ type: "UNKNOWN_HACK_CMD" }).valid).toBe(
      false,
    );
    expect(
      validateExtensionMessage({
        type: "SETTINGS_CHANGED",
        payload: ["invalid-array-payload"],
      }).valid,
    ).toBe(false);
  });

  it("retries sending message when service worker restarts on first attempt", async () => {
    let attempts = 0;
    const runtimeMock: {
      id: string;
      lastError?: { message: string };
      sendMessage: (
        msg: unknown,
        cb: (res?: { ok: boolean; host?: string }) => void,
      ) => void;
    } = {
      id: "test-extension-id",
      sendMessage: (_msg, cb) => {
        attempts += 1;
        if (attempts === 1) {
          runtimeMock.lastError = {
            message: "Extension context invalidated / SW waking up",
          };
          cb(undefined);
        } else {
          delete runtimeMock.lastError;
          cb({ ok: true, host: "service-worker" });
        }
      },
    };

    (globalThis as Record<string, unknown>).chrome = { runtime: runtimeMock };

    const res = await sendExtensionMessage(
      { type: "PING" },
      { retries: 2, timeoutMs: 300 },
    );
    expect(attempts).toBe(2);
    expect(res.ok).toBe(true);
    expect(res.host).toBe("service-worker");
  });
});

describe("4. Vanish & Restore Engine, Repeated Triggers, Track Recovery & Cleanup", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("transitions cleanly through live -> vanishing -> vanished -> restoring -> live", () => {
    const engine = new VanishEngineController({
      ...DEFAULT_SETTINGS,
      duration: 1.0,
      speed: 1.0,
    });

    const init1 = engine.initialize("preview-only");
    expect(init1.alreadyInitialized).toBe(false);
    const init2 = engine.initialize("preview-only");
    expect(init2.alreadyInitialized).toBe(true);

    // Trigger vanish
    const t1 = engine.toggle(1000);
    expect(t1.accepted).toBe(true);
    expect(engine.currentState).toBe("vanishing");
    expect(engine.isMuted).toBe(true);

    // Repeated trigger during transition must be rejected
    const duplicateTrigger = engine.toggle(1100);
    expect(duplicateTrigger.accepted).toBe(false);
    expect(duplicateTrigger.reason).toBe("transition-in-progress");

    // Advance timer to complete vanish
    vi.advanceTimersByTime(1050);
    expect(engine.currentState).toBe("vanished");
    expect(engine.currentProgress).toBe(1);

    // Trigger restore
    const t2 = engine.toggle(3500);
    expect(t2.accepted).toBe(true);
    expect(engine.currentState).toBe("restoring");
    expect(engine.isMuted).toBe(false);

    vi.advanceTimersByTime(1050);
    expect(engine.currentState).toBe("live");
    expect(engine.currentProgress).toBe(0);
  });

  it("recovers from permission failure, unexpected track end, and mid-transition via emergencyRestore()", () => {
    const engine = new VanishEngineController(DEFAULT_SETTINGS);
    engine.initialize("dom-overlay");

    // Create a mock MediaStreamTrack with EventTarget
    const listeners = new Set<EventListener>();
    const mockTrack = {
      kind: "video",
      readyState: "live",
      addEventListener: (_type: string, fn: EventListener) => listeners.add(fn),
      removeEventListener: (_type: string, fn: EventListener) =>
        listeners.delete(fn),
      stop: vi.fn(),
    } as unknown as MediaStreamTrack;

    engine.attachMediaTracks([mockTrack]);
    expect(engine.resourceStatus.mediaTracksActive).toBe(1);

    // Simulate unexpected hardware disconnect / track end
    for (const fn of listeners) {
      fn(new Event("ended"));
    }

    expect(engine.currentState).toBe("error");
    expect(engine.error).toContain("video");

    // Normal toggle is blocked while in error state
    expect(engine.toggle(5000).accepted).toBe(false);

    // Emergency restore unconditionally recovers to live state
    const restored = engine.emergencyRestore();
    expect(restored.accepted).toBe(true);
    expect(engine.currentState).toBe("live");
    expect(engine.error).toBeNull();
    expect(engine.isMuted).toBe(false);

    // Dispose cleans up tracks and listeners
    engine.dispose();
    expect(engine.resourceStatus.audioContextState).toBe("closed");
    expect(engine.resourceStatus.activeListeners).toBe(0);
  });

  it("falls back safely to fade-out when an effect error occurs", () => {
    const engine = new VanishEngineController(DEFAULT_SETTINGS);
    const fallback = engine.handleEffectFailure(new Error("WebGL context lost"));
    expect(fallback.fallbackEffect).toBe("fade-out");
    expect(engine.currentSettings.effect).toBe("fade-out");
  });
});

describe("5. Gesture Detection & Acoustic Transient Confirmation", () => {
  it("confirms a valid finger snap and rejects waves, mug reaches, and cooldown repeats", () => {
    const detector = new SnapGestureDetector(DEFAULT_SETTINGS.gesture);

    // 1. Hand wave (high wrist angular velocity) -> rejected
    detector.evaluateLandmarks(
      createSyntheticHandFrame({ thumbMiddleDistMm: 50, wristOffsetRad: 0 }),
      100,
    );
    const waveEval = detector.evaluateLandmarks(
      createSyntheticHandFrame({ thumbMiddleDistMm: 8, wristOffsetRad: 0.5 }),
      140,
    );
    expect(waveEval.triggered).toBe(false);
    expect(waveEval.reason).toBe("wrist-moving-too-fast");

    // 2. Reaching for mug (large bounding box delta) -> rejected
    detector.reset();
    detector.evaluateLandmarks(
      createSyntheticHandFrame({ thumbMiddleDistMm: 50, bboxScale: 1.0 }),
      500,
    );
    const reachEval = detector.evaluateLandmarks(
      createSyntheticHandFrame({ thumbMiddleDistMm: 8, bboxScale: 1.6 }),
      550,
    );
    expect(reachEval.triggered).toBe(false);
    expect(reachEval.reason).toBe("bbox-unstable");

    // 3. Valid finger snap (52mm -> 8mm within 120ms, steady wrist & bbox) -> confirmed
    detector.reset();
    detector.evaluateLandmarks(
      createSyntheticHandFrame({ thumbMiddleDistMm: 52 }),
      1000,
    );
    const snapEval = detector.evaluateLandmarks(
      createSyntheticHandFrame({ thumbMiddleDistMm: 8 }),
      1065,
    );
    expect(snapEval.triggered).toBe(true);
    expect(snapEval.reason).toBe("confirmed");

    // 4. Immediate repeat within cooldown -> blocked
    const cooldownEval = detector.evaluateLandmarks(
      createSyntheticHandFrame({ thumbMiddleDistMm: 8 }),
      1200,
    );
    expect(cooldownEval.triggered).toBe(false);
    expect(cooldownEval.reason).toBe("cooldown-active");
  });

  it("confirms short >=12dB acoustic transients and rejects sustained speech (>90ms)", () => {
    const confirmer = new AcousticSnapConfirmer();
    const silence = new Float32Array(256).fill(0.0005);
    const loudSnap = new Float32Array(256).fill(0.25);

    // Establish quiet floor
    expect(confirmer.evaluateSamples(silence, 100).onsetAt).toBeNull();

    // Crisp transient onset at t=200ms
    const onset = confirmer.evaluateSamples(loudSnap, 200);
    expect(onset.onsetAt).toBe(200);
    expect(onset.jumpDb).toBeGreaterThanOrEqual(12);

    // If loud signal sustains past 90ms (e.g. t=310ms), it is rejected as voice/noise
    const sustained = confirmer.evaluateSamples(loudSnap, 310);
    expect(sustained.onsetAt).toBeNull();
  });
});

function createMockCanvasContext(): CanvasRenderingContext2D {
  return {
    save: vi.fn(),
    restore: vi.fn(),
    clearRect: vi.fn(),
    fillRect: vi.fn(),
    drawImage: vi.fn(),
    beginPath: vi.fn(),
    closePath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    quadraticCurveTo: vi.fn(),
    ellipse: vi.fn(),
    arc: vi.fn(),
    fill: vi.fn(),
    stroke: vi.fn(),
    createLinearGradient: vi.fn(() => ({
      addColorStop: vi.fn(),
    })),
    createRadialGradient: vi.fn(() => ({
      addColorStop: vi.fn(),
    })),
    getImageData: vi.fn((_x: number, _y: number, w: number, h: number) => ({
      width: w,
      height: h,
      data: new Uint8ClampedArray(w * h * 4).fill(200),
    })),
    fillStyle: "#000",
    strokeStyle: "#000",
    lineWidth: 1,
    lineCap: "round",
    lineJoin: "round",
    filter: "none",
    globalAlpha: 1,
    globalCompositeOperation: "source-over",
  } as unknown as CanvasRenderingContext2D;
}

describe("6. Multi-Effect Visual Engine, Analytics, Diagnostics, Cloud & Feedback", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
      () => createMockCanvasContext() as unknown as RenderingContext,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders all 5 effects (dust, pixel-dissolve, digital-glitch, fade-out, light-burst) reversibly and falls back gracefully on error", () => {
    expect(hexToRgb("#d2451e")).toEqual({ r: 210, g: 69, b: 30 });
    expect(hexToRgb("invalid")).toEqual({ r: 210, g: 69, b: 30 });
    expect(windFor("left").x).toBeLessThan(0);
    expect(windFor("right").x).toBeGreaterThan(0);

    const scene = new DustScene();
    scene.build(null, null);
    expect(scene.status).toBe("fallback");
    expect(scene.particleCount).toBeGreaterThan(0);

    const ctx = createMockCanvasContext();
    const effects = [
      "dust",
      "pixel-dissolve",
      "digital-glitch",
      "fade-out",
      "light-burst",
    ] as const;

    for (const effect of effects) {
      // Forward vanish (t = 0.5)
      expect(() =>
        scene.render(ctx, 0.5, "right", 1.8, {
          effect,
          speed: 1.2,
          particleSize: 1.1,
          density: 60,
          colorAccent: "#8b5cf6",
          intensity: 80,
          lowPowerMode: false,
        }),
      ).not.toThrow();

      // Reassembly / low-power mode (t = 0.25)
      expect(() =>
        scene.render(ctx, 0.25, "toward", 1.5, {
          effect,
          lowPowerMode: true,
        }),
      ).not.toThrow();
    }

    // Verify graceful fallback when an internal effect draw call throws
    const throwingCtx = createMockCanvasContext();
    let fillRectCalls = 0;
    throwingCtx.fillRect = vi.fn(() => {
      fillRectCalls += 1;
      if (fillRectCalls === 1) {
        throw new Error("Simulated GPU canvas error");
      }
    });

    expect(() =>
      scene.render(throwingCtx, 0.5, "right", 1.8, { effect: "dust" }),
    ).not.toThrow();
    expect(scene.lastFallbackReason).toContain("Simulated GPU canvas error");
  });

  it("tracks local analytics accurately and clears data on request", () => {
    recordAnalyticsEvent({
      type: "vanish_activated",
      effect: "dust",
      timestamp: "2026-10-25T10:00:00.000Z",
    });
    recordAnalyticsEvent({
      type: "vanish_activated",
      effect: "digital-glitch",
      timestamp: "2026-10-25T11:00:00.000Z",
    });
    recordAnalyticsEvent({
      type: "emergency_restore",
      effect: "digital-glitch",
      timestamp: "2026-10-25T11:01:00.000Z",
    });

    const summary = loadAnalytics();
    expect(summary.totalActivations).toBe(2);
    expect(summary.emergencyRestorations).toBe(1);
    expect(summary.successfulRestorations).toBe(1);
    expect(summary.effectCounts.dust).toBe(1);
    expect(summary.effectCounts["digital-glitch"]).toBe(1);

    const weekly = getWeeklyUsageSummary(
      summary,
      new Date("2026-10-25T12:00:00.000Z"),
    );
    expect(weekly.totalWeekActivations).toBe(2);

    const cleared = clearAnalyticsData();
    expect(cleared.totalActivations).toBe(0);
  });

  it("computes real FPS and render latency from recorded frame timestamps", () => {
    const tracker = new FramePerformanceTracker();
    expect(tracker.getMeasuredFps()).toBeNull();
    expect(tracker.getMeasuredRenderMs()).toBeNull();

    // Simulate 10 frames spaced by ~16.67ms (60 FPS) with 2.5ms render time
    for (let i = 0; i < 10; i++) {
      const start = i * 16.67;
      tracker.recordFrame(start, start + 2.5);
    }

    expect(tracker.getMeasuredFps()).toBe(60);
    expect(tracker.getMeasuredRenderMs()).toBe(2.5);

    appendDiagnosticLog({
      level: "info",
      code: "TEST_LOG",
      message: "Verified diagnostic logger",
    });
    expect(loadDiagnosticLogs()).toHaveLength(1);
    expect(clearDiagnosticLogs()).toHaveLength(0);
  });

  it("reports BLOCKED cloud status honestly when Supabase env vars are absent and resolves preset conflicts", async () => {
    const status = getCloudSyncStatus();
    expect(status.configured).toBe(false);
    expect(status.statusLabel).toBe("BLOCKED");

    const authAttempt = await authenticateWithCloud({
      mode: "signin",
      email: "engineer@example.com",
      password: "securePassword123",
    });
    expect(authAttempt.ok).toBe(false);
    expect(authAttempt.status).toBe("BLOCKED");

    const entitlements = getEntitlementState(null);
    expect(entitlements.tier).toBe("free");
    expect(entitlements.verificationSource).toBe("unconfigured");
    expect(entitlements.entitlements.coreVanishRestore).toBe(true);

    // Preset sync conflict resolution (newest updatedAt wins)
    const older = {
      ...BUILT_IN_PRESETS[0],
      id: "preset-conflict-1",
      name: "Older Local",
      updatedAt: "2026-10-20T00:00:00.000Z",
    };
    const newer = {
      ...BUILT_IN_PRESETS[0],
      id: "preset-conflict-1",
      name: "Newer Remote",
      updatedAt: "2026-10-25T00:00:00.000Z",
    };
    const resolved = resolvePresetSyncConflicts([older], [newer]);
    expect(resolved.conflictsResolved).toBe(1);
    expect(resolved.merged[0].name).toBe("Newer Remote");
  });

  it("attaches diagnostic snapshot to feedback ONLY when user explicitly consents", () => {
    const withoutConsent = submitFeedback({
      category: "bug",
      title: "Popup button alignment",
      description: "Testing bug report without diagnostic consent",
      includeDiagnostics: false,
      diagnosticSnapshot: { measuredFps: 60 },
    });
    expect(withoutConsent.ok).toBe(true);
    expect(withoutConsent.submission?.diagnosticSnapshot).toBeUndefined();

    const withConsent = submitFeedback({
      category: "feature",
      title: "Custom shader export",
      description: "Testing feature request with explicit diagnostic consent",
      includeDiagnostics: true,
      diagnosticSnapshot: { measuredFps: 60 },
    });
    expect(withConsent.ok).toBe(true);
    expect(withConsent.submission?.diagnosticSnapshot?.measuredFps).toBe(60);

    deleteFeedbackSubmission(withoutConsent.submission!.id);
    clearAllFeedback();
  });
});
