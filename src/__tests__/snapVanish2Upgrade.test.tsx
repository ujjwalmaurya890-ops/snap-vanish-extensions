// @vitest-environment jsdom
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import App from "../App";
import {
  LandmarkSmoother,
  SnapGestureDetector,
  createSyntheticHandFrame,
  getSettingsForDetectionMode,
  normalizeLandmarksToMm,
} from "../lib/gestureEngine";
import { LiveAudioConfirmationEngine } from "../features/audio/audioConfirmationEngine";
import {
  BACKGROUND_METHODS_EXPLAINED,
  BackgroundReconstructor,
  PLATFORM_COMPATIBILITY_MATRIX,
} from "../features/camera/backgroundReconstructor";
import { DustScene, evaluateMotionCurve } from "../lib/dust";
import {
  BUILT_IN_PRESETS,
  DEFAULT_SETTINGS,
  exportSettingsJson,
  importSettingsJson,
  migrateSettingsPayload,
} from "../lib/settings";
import { createAppError } from "../services/errorService";
import type { AppErrorCode } from "../types/snapVanish";

// Enable React 19 act environment
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

function createMock2dContext() {
  return {
    save: vi.fn(),
    restore: vi.fn(),
    clearRect: vi.fn(),
    fillRect: vi.fn(),
    strokeRect: vi.fn(),
    beginPath: vi.fn(),
    closePath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    quadraticCurveTo: vi.fn(),
    bezierCurveTo: vi.fn(),
    arc: vi.fn(),
    ellipse: vi.fn(),
    fill: vi.fn(),
    stroke: vi.fn(),
    translate: vi.fn(),
    scale: vi.fn(),
    rotate: vi.fn(),
    setLineDash: vi.fn(),
    drawImage: vi.fn(),
    putImageData: vi.fn(),
    createLinearGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
    createRadialGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
    getImageData: vi.fn((_x: number, _y: number, w: number, h: number) => ({
      width: w,
      height: h,
      data: new Uint8ClampedArray(w * h * 4).fill(140),
    })),
    fillStyle: "#000",
    strokeStyle: "#000",
    lineWidth: 1,
    globalAlpha: 1,
    globalCompositeOperation: "source-over",
    filter: "none",
  } as unknown as CanvasRenderingContext2D;
}

describe("Snap Vanish 2.0 — Comprehensive Unit, Integration, DOM & Build Suite", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
      () => createMock2dContext() as unknown as RenderingContext,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("Unit: 21-Point Landmark Normalization, Smoothing & Detection Profiles", () => {
    it("converts MediaPipe worldLandmarks in meters accurately to millimeters", () => {
      const worldMeters = Array.from({ length: 21 }, () => ({
        x: 0,
        y: 0,
        z: 0,
      }));
      worldMeters[4] = { x: 0.01, y: 0.02, z: 0 };
      worldMeters[12] = { x: 0.046, y: 0.02, z: 0 }; // 0.036 m = 36 mm apart

      const mm = normalizeLandmarksToMm(worldMeters, worldMeters);
      const dist = Math.hypot(mm[12].x - mm[4].x, mm[12].y - mm[4].y);
      expect(dist).toBeCloseTo(36, 1);
    });

    it("normalizes [0..1] MediaPipe 2D/3D landmarks using 82 mm palm reference", () => {
      const norm2d = Array.from({ length: 21 }, () => ({
        x: 0.5,
        y: 0.5,
        z: 0,
      }));
      norm2d[0] = { x: 0.5, y: 0.8, z: 0 };
      norm2d[9] = { x: 0.5, y: 0.6, z: 0 }; // palm length 0.2 -> scaled to 82 mm
      norm2d[4] = { x: 0.5, y: 0.5, z: 0 };
      norm2d[12] = { x: 0.525, y: 0.5, z: 0 }; // 0.025 * (82 / 0.2) = 10.25 mm

      const mm = normalizeLandmarksToMm(norm2d);
      const dist = Math.hypot(mm[12].x - mm[4].x, mm[12].y - mm[4].y);
      expect(dist).toBeCloseTo(10.25, 1);
    });

    it("stabilizes jitter via LandmarkSmoother and resets cleanly on tracking loss", () => {
      const smoother = new LandmarkSmoother();
      const f1 = createSyntheticHandFrame({ thumbMiddleDistMm: 35 });
      const f2 = createSyntheticHandFrame({ thumbMiddleDistMm: 37 });
      const s1 = smoother.smooth(f1, 0.5, 100);
      const s2 = smoother.smooth(f2, 0.5, 116);
      expect(s1).toHaveLength(21);
      expect(s2[12].x).toBeGreaterThan(f1[12].x);
      expect(s2[12].x).toBeLessThan(f2[12].x);

      const det = new SnapGestureDetector(getSettingsForDetectionMode("balanced"));
      det.evaluateLandmarks(createSyntheticHandFrame({ thumbMiddleDistMm: 38 }), 100);
      expect(det.notifyNoHand(140)).toBe("no-hand");
    });

    it("enforces distinct thresholds across beginner, balanced, and precision profiles and blocks cooldown echoes", () => {
      const beginner = getSettingsForDetectionMode("beginner");
      const precision = getSettingsForDetectionMode("precision");
      expect(beginner.calibratedCollapseThresholdMm).toBeGreaterThan(
        precision.calibratedCollapseThresholdMm,
      );
      expect(precision.minHandConfidence).toBeGreaterThan(
        beginner.minHandConfidence,
      );

      const det = new SnapGestureDetector({
        ...DEFAULT_SETTINGS.gesture,
        requireAudioConfirm: false,
        cooldownMs: 2000,
      });
      det.evaluateLandmarks(createSyntheticHandFrame({ thumbMiddleDistMm: 44 }), 1000);
      const first = det.evaluateLandmarks(
        createSyntheticHandFrame({ thumbMiddleDistMm: 9 }),
        1080,
      );
      expect(first.triggered).toBe(true);

      // Immediate second snap inside 2000ms cooldown must be blocked
      det.evaluateLandmarks(createSyntheticHandFrame({ thumbMiddleDistMm: 44 }), 1500);
      const echo = det.evaluateLandmarks(
        createSyntheticHandFrame({ thumbMiddleDistMm: 9 }),
        1580,
      );
      expect(echo.triggered).toBe(false);
      expect(echo.phase).toBe("cooldown");
      expect(echo.cooldownRemainingMs).toBeGreaterThan(0);
    });
  });

  describe("Unit: Audio Confirmation, Background Reconstruction & Particle Engine", () => {
    it("confirms sharp high-frequency transients and rejects higher dB thresholds cleanly", () => {
      const audio = new LiveAudioConfirmationEngine();
      const pass = audio.runSyntheticTransientTest(12);
      expect(pass.confirmed).toBe(true);
      expect(pass.jumpDb).toBeGreaterThanOrEqual(12);

      const strict = audio.runSyntheticTransientTest(95);
      expect(strict.confirmed).toBe(false);
    });

    it("reconstructs clean-plate and temporal backgrounds and detects camera border shifts", () => {
      const bg = new BackgroundReconstructor(64, 36);
      const emptyRoom = {
        width: 64,
        height: 36,
        data: new Uint8ClampedArray(64 * 36 * 4).fill(90),
      } as ImageData;
      bg.captureCleanPlate(emptyRoom);
      expect(bg.hasCapturedPlate).toBe(true);

      const brightShift = {
        width: 64,
        height: 36,
        data: new Uint8ClampedArray(64 * 36 * 4).fill(245),
      } as ImageData;
      bg.ingestLiveFrame(emptyRoom);
      bg.ingestLiveFrame(brightShift);
      expect(bg.isCameraMoving).toBe(true);

      const alpha = bg.computeForegroundAlpha(brightShift, emptyRoom);
      expect(alpha.length).toBe(64 * 36);
      expect(BACKGROUND_METHODS_EXPLAINED).toHaveLength(4);
      expect(PLATFORM_COMPATIBILITY_MATRIX).toHaveLength(3);
      bg.reset();
      expect(bg.hasCapturedPlate).toBe(false);
      expect(bg.hasTemporalPlate).toBe(false);
      expect(bg.isCameraMoving).toBe(false);
    });

    it("evaluates motion smoothness easing and passes live <video> directly at t === 0 on restore", () => {
      expect(evaluateMotionCurve(0, 80)).toBe(0);
      expect(evaluateMotionCurve(1, 80)).toBe(1);
      expect(evaluateMotionCurve(0.5, 80)).toBeCloseTo(0.5, 1);

      const scene = new DustScene();
      scene.build(null, null, 6000);
      expect(scene.particleCount).toBeGreaterThan(500);

      const ctx = createMock2dContext();
      const fakeVideo = document.createElement("video");
      Object.defineProperty(fakeVideo, "readyState", { value: 4 });
      Object.defineProperty(fakeVideo, "videoWidth", { value: 1280 });
      Object.defineProperty(fakeVideo, "videoHeight", { value: 720 });

      // At t = 0 (restored live camera), DustScene MUST draw the live <video> element directly
      scene.render(ctx, 0, "right", 1.8, {
        effect: "cinematic-disintegration",
        liveVideoSource: fakeVideo,
        mirrorLiveVideo: true,
      });
      expect(ctx.drawImage).toHaveBeenCalledWith(fakeVideo, 0, 0, 1280, 720);
    });
  });

  describe("Unit: Schema Migration, Export/Import & Centralized 14-Code Error Recovery", () => {
    it("migrates legacy v1 settings payloads to schemaVersion 2 and round-trips JSON export/import", () => {
      const legacyV1 = {
        enabled: true,
        sensitivity: 74,
        duration: 2.1,
        direction: "left",
        effect: "dust",
      };
      const migrated = migrateSettingsPayload(legacyV1);
      expect(migrated.migratedFrom).toBe(1);
      expect(migrated.payload.schemaVersion).toBe(2);

      const json = exportSettingsJson(DEFAULT_SETTINGS, BUILT_IN_PRESETS);
      const reimported = importSettingsJson(json);
      expect(reimported.ok).toBe(true);
      expect(reimported.settings.schemaVersion).toBe(2);
      expect(BUILT_IN_PRESETS.length).toBeGreaterThanOrEqual(6);
    });

    it("covers all 14 error codes and requests local preview reset on critical failures", () => {
      const allCodes: AppErrorCode[] = [
        "CAMERA_PERMISSION_DENIED",
        "MICROPHONE_PERMISSION_DENIED",
        "CAMERA_DISCONNECTED",
        "MICROPHONE_DISCONNECTED",
        "MODEL_LOAD_FAILED",
        "UNSUPPORTED_BROWSER",
        "UNSUPPORTED_PLATFORM",
        "TRACK_REPLACEMENT_FAILED",
        "AUDIO_INIT_FAILED",
        "INVALID_SETTINGS",
        "EXTENSION_MESSAGING_ERROR",
        "SERVICE_WORKER_RESTART",
        "MISSING_RESOURCE",
        "UNEXPECTED_EXCEPTION",
      ];

      let safeRestores = 0;
      for (const code of allCodes) {
        const rec = createAppError(code, {
          loggingEnabled: false,
          recordHistory: false,
          onSafeRestoreCamera: () => {
            safeRestores += 1;
          },
        });
        expect(rec.code).toBe(code);
        expect(rec.title.length).toBeGreaterThan(3);
        expect(rec.explanation.length).toBeGreaterThan(10);
      }
      // CAMERA_PERMISSION_DENIED, CAMERA_DISCONNECTED, TRACK_REPLACEMENT_FAILED, UNEXPECTED_EXCEPTION
      expect(safeRestores).toBe(4);
    });

    it("reports a reset request without claiming the meeting camera was restored", () => {
      const requested = createAppError("CAMERA_DISCONNECTED", {
        loggingEnabled: false, recordHistory: false, onSafeRestoreCamera: () => {},
      });
      expect(requested.autoRestoreRequested).toBe(true);
      expect(requested.explanation).toMatch(/recovery is not guaranteed/i);
      expect(requested).not.toHaveProperty("autoRestoredCamera");
      const failed = createAppError("UNEXPECTED_EXCEPTION", {
        loggingEnabled: false, recordHistory: false, onSafeRestoreCamera: () => { throw new Error("failed"); },
      });
      expect(failed.autoRestoreRequested).toBe(false);
      expect(failed.explanation).toMatch(/recovery can fail/i);
    });
  });

  describe("Integration: MAIN-World WebRTC RTCRtpSender.replaceTrack Bridge", () => {
    it("tracks RTCPeerConnection video senders, replaces track on vanish, and restores hardware track on restore", async () => {
      delete (window as unknown as Record<string, unknown>)
        .__snapVanishMainBridgeInstalled;

      const hardwareCameraTrack = {
        id: "hw-cam-1",
        kind: "video",
        readyState: "live",
        getSettings: () => ({ width: 640, height: 360 }),
        stop: vi.fn(),
      };
      const canvasVideoTrack = {
        id: "processed-canvas-1",
        kind: "video",
        readyState: "live",
        stop: vi.fn(),
      };

      // Spec-faithful double: `RTCRtpSender.track` reflects the most recently
      // replaced track, which is what makes the bridge's "already restored"
      // fast-path observable.
      class MockSender {
        track = hardwareCameraTrack as Record<string, unknown>;
        async replaceTrack(next: Record<string, unknown>) {
          this.track = next;
        }
      }
      const replaceTrackSpy = vi.spyOn(MockSender.prototype, "replaceTrack");
      const mockSender = new MockSender();
      (window as unknown as Record<string, unknown>).RTCRtpSender = MockSender;
      const originalMediaDevices = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
      Object.defineProperty(navigator, "mediaDevices", {
        configurable: true,
        value: { getUserMedia: async () => ({ getVideoTracks: () => [hardwareCameraTrack] }) },
      });

      class MockRTCPeerConnection extends EventTarget {
        connectionState = "connected";
        signalingState = "stable";
        getSenders() {
          return [mockSender];
        }
      }
      (window as unknown as Record<string, unknown>).RTCPeerConnection =
        MockRTCPeerConnection;

      const bridgeCode = fs.readFileSync(
        path.resolve(process.cwd(), "extension/content/main-world-bridge.js"),
        "utf8",
      );
      new Function(bridgeCode)();
      await navigator.mediaDevices.getUserMedia({ video: true });
      const video = document.createElement("video");
      Object.defineProperty(video, "srcObject", {
        value: { getVideoTracks: () => [hardwareCameraTrack] },
      });
      document.body.appendChild(video);

      // Simulate Google Meet / Teams creating a WebRTC PeerConnection
      const WrappedPC = (
        window as unknown as { RTCPeerConnection: typeof MockRTCPeerConnection }
      ).RTCPeerConnection;
      const pc = new WrappedPC();
      expect(pc).toBeDefined();

      // Mount processed canvas with captureStream mock
      const canvas = document.createElement("canvas");
      canvas.id = "snap-vanish-rtc-canvas";
      (canvas as unknown as { captureStream: () => unknown }).captureStream =
        () => ({
          getVideoTracks: () => [canvasVideoTrack],
          getTracks: () => [canvasVideoTrack],
        });
      document.body.appendChild(canvas);

      const sendCmd = (action: string) =>
        new Promise<Record<string, unknown>>((resolve) => {
          const requestId = `req-${Math.random()}`;
          const handler = (ev: Event) => {
            const detail = (ev as CustomEvent).detail;
            if (detail.requestId === requestId) {
              window.removeEventListener("snap-vanish:bridge-ack", handler);
              resolve(detail);
            }
          };
          window.addEventListener("snap-vanish:bridge-ack", handler);
          (action === "ATTACH_PROCESSED_STREAM" ? video : window).dispatchEvent(
            new CustomEvent("snap-vanish:bridge-cmd", {
              bubbles: true,
              detail: { requestId, action, canvasId: "snap-vanish-rtc-canvas" },
            }),
          );
        });

      const attachAck = await sendCmd("ATTACH_PROCESSED_STREAM");
      expect(attachAck.ok).toBe(true);
      expect(attachAck.mode).toBe("webrtc-sender");
      expect(replaceTrackSpy).toHaveBeenCalledWith(canvasVideoTrack);

      const restoreAck = await sendCmd("RESTORE_ORIGINAL_TRACK");
      expect(restoreAck.ok).toBe(true);
      expect(replaceTrackSpy).toHaveBeenLastCalledWith(hardwareCameraTrack);
      expect(canvasVideoTrack.stop).toHaveBeenCalled();

      canvas.remove();
      video.remove();
      if (originalMediaDevices) Object.defineProperty(navigator, "mediaDevices", originalMediaDevices);
      else Reflect.deleteProperty(navigator, "mediaDevices");
    });
  });

  describe("DOM & Responsive UI Integration: Dashboard, Studio, 9-Section Settings & Onboarding", () => {
    let container: HTMLDivElement;
    let root: Root;

    beforeEach(() => {
      container = document.createElement("div");
      document.body.appendChild(container);
      root = createRoot(container);
    });

    afterEach(async () => {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    });

    it("describes meeting transmission and keeps onboarding's effect preview local", async () => {
      const sent: string[] = [];
      (globalThis as Record<string, unknown>).chrome = { runtime: {
        id: "test-extension",
        sendMessage: (msg: { type: string }, callback: (value: unknown) => void) => {
          sent.push(msg.type);
          callback({ ok: true, host: "meet.google.com" });
        },
      } };
      try {
        await act(async () => { root.render(<App />); await new Promise((r) => setTimeout(r, 25)); });
        expect(container.textContent).toContain("Your meeting still sends video and audio to participants");
        const jump = container.querySelector('button[aria-label="Jump to step 6"]') as HTMLButtonElement;
        expect(jump).toBeTruthy();
        await act(async () => jump.click());
        const preview = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Trigger Disintegration Preview"));
        expect(preview).toBeTruthy();
        sent.length = 0;
        await act(async () => preview?.click());
        expect(sent).not.toContain("SNAP_VANISH_NOW");
      } finally { delete (globalThis as Record<string, unknown>).chrome; }
    });

    it("renders cleanly across all 5 target viewports and navigates Onboarding, Studio, Calibration, and all 9 Settings sections", async () => {
      const viewports = [
        [1920, 1080],
        [1440, 900],
        [1366, 768],
        [1024, 768],
        [390, 844],
      ] as const;

      await act(async () => {
        root.render(<App />);
      });
      // Allow initial async settings hydration
      await act(async () => {
        await new Promise((r) => setTimeout(r, 25));
      });

      for (const [w, h] of viewports) {
        Object.defineProperty(window, "innerWidth", {
          configurable: true,
          value: w,
        });
        Object.defineProperty(window, "innerHeight", {
          configurable: true,
          value: h,
        });
        window.dispatchEvent(new Event("resize"));
        expect(container.querySelector("header")).not.toBeNull();
        expect(container.querySelector("canvas")).not.toBeNull();
      }

      // 8-Step Onboarding opens automatically on fresh state; step through or complete it
      const skipBtn = container.querySelector(
        'button[aria-label="Skip setup guide"]',
      ) as HTMLButtonElement | null;
      expect(skipBtn).not.toBeNull();
      await act(async () => {
        skipBtn?.click();
      });

      // Switch to Personalization Studio tab
      const tabs = Array.from(
        container.querySelectorAll('button[role="tab"]'),
      ) as HTMLButtonElement[];
      expect(tabs).toHaveLength(4);
      await act(async () => {
        tabs[1].click(); // Personalization Studio
      });
      expect(container.textContent).toContain("Particle Physics & Preset Library");
      expect(container.textContent).toContain("Classic Dust");
      expect(container.textContent).toContain("Cinematic Disintegration");

      // Switch to 9-Section Settings tab and verify all 9 navigation items exist and switch
      await act(async () => {
        tabs[2].click(); // Settings (9 Sections)
      });
      const settingsNavButtons = Array.from(
        container.querySelectorAll('nav[aria-label="Settings sections"] button'),
      ) as HTMLButtonElement[];
      expect(settingsNavButtons).toHaveLength(9);
      const autoArm = container.querySelector('button[aria-label="Auto-arm on joining (not implemented)"]') as HTMLButtonElement;
      expect(autoArm.disabled).toBe(true);
      expect(autoArm.getAttribute("aria-checked")).toBe("false");
      await act(async () => settingsNavButtons[6].click());
      const localOnly = container.querySelector('button[aria-label="Strict local-only enforcement (not implemented)"]') as HTMLButtonElement;
      expect(localOnly.disabled).toBe(true);
      expect(localOnly.getAttribute("aria-checked")).toBe("false");
      expect(container.textContent).toContain("does not block configured cloud services or Chrome Sync");
      expect(container.textContent).toContain("meeting continues to transmit");

      for (const navBtn of settingsNavButtons) {
        await act(async () => {
          navBtn.click();
        });
      }
      expect(container.textContent).toContain("Google Meet");
      expect(container.textContent).toContain("Microsoft Teams");
      expect(container.textContent).toContain("Zoom");
    });
  });

  describe("Build & Extension Package Integrity Verification", () => {
    it("verifies local MediaPipe model SHA-256, MV3 CSP syntax, and zero inline scripts", () => {
      const rootDir = process.cwd();
      const manifest = JSON.parse(
        fs.readFileSync(path.join(rootDir, "extension/manifest.json"), "utf8"),
      );

      expect(manifest.content_security_policy.extension_pages).toContain(
        "'wasm-unsafe-eval'",
      );
      expect(manifest.options_page).toBe("studio/index.html");

      // Ensure web_accessible_resources never exposes <all_urls>
      for (const entry of manifest.web_accessible_resources) {
        expect(entry.matches).not.toContain("<all_urls>");
      }

      // Verify SHA-256 of official Google hand_landmarker.task
      const handTaskBuf = fs.readFileSync(
        path.join(rootDir, "extension/models/hand_landmarker.task"),
      );
      const sha256 = crypto
        .createHash("sha256")
        .update(handTaskBuf)
        .digest("hex");
      expect(sha256).toBe(
        "fbc2a30080c3c557093b5ddfc334698132eb341044ccee322ccf8bcf3607cde1",
      );

      // Verify zero inline executable scripts in extension HTML files
      for (const rel of ["extension/popup/popup.html", "extension/studio/index.html"]) {
        const html = fs.readFileSync(path.join(rootDir, rel), "utf8");
        const scriptTags = html.match(/<script\b[^>]*>/gi) || [];
        for (const tag of scriptTags) {
          expect(tag).toMatch(/\bsrc\s*=/i);
        }
      }

    });
  });
});
