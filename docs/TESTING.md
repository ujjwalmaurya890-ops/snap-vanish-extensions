# Snap Vanish 2.0 — Testing & Verification Guide

## Automated Test Suite

Run all static type checks, unit tests, integration tests, DOM/responsive checks, and MV3 package checks:

```bash
npm run typecheck
npm test
npm run build:extension
```

### Test Coverage Breakdown (`31` Automated Tests across `3` Suites)

1. **`src/__tests__/snapVanish.test.ts` (17 tests)**
   - Settings validation, clamping, enum sanitization, and `chrome.storage.sync` persistence
   - Custom preset CRUD (`createPresetFromSettings`, `renamePreset`, `duplicatePreset`, `deletePreset`)
   - Extension message validation & retry bridge (`validateExtensionMessage`, `sendExtensionMessage`)
   - Core `VanishEngineController` state transitions, cooldown protection, and resource cleanup
   - `SnapGestureDetector` & `AcousticSnapConfirmer` false-positive rejection (hand waves, sustained speech)
   - `DustScene` deterministic particle count & reversible boundary conditions
   - Privacy-gated local analytics & `FramePerformanceTracker`

2. **`src/__tests__/extensionRuntime.test.ts` (2 tests)**
   - Manifest V3 structural validation and file existence checks
   - `extension/content/snap-vanish.js` JSDOM execution and full message protocol (`STATE`, `SNAP_VANISH_NOW`, `EMERGENCY_RESTORE`, `SETTINGS`, `RUN_DIAGNOSTICS`)

3. **`src/__tests__/snapVanish2Upgrade.test.tsx` (12 tests)**
   - `normalizeLandmarksToMm` (MediaPipe `worldLandmarks` in meters + `[0..1]` 2D/3D palm-referenced scaling)
   - `LandmarkSmoother` EMA jitter stabilization & `notifyNoHand` tracking-loss reset
   - Multi-profile gesture thresholds (`beginner`, `balanced`, `precision`) & cooldown echo blocking
   - `LiveAudioConfirmationEngine` synthetic transient confirmation & high-threshold rejection
   - `BackgroundReconstructor` clean-plate capture, temporal EMA estimation, border camera-motion detection, and foreground alpha matting
   - `DustScene` smoothness curves (`evaluateMotionCurve`) and live `<video>` passthrough at `t === 0`
   - v1 → v2 schema migration (`migrateSettingsPayload`) and JSON export/import round-tripping
   - Centralized 14-code `createAppError` recovery & automatic safe camera restoration
   - `MAIN`-world `RTCPeerConnection` + `RTCRtpSender.replaceTrack` attach & hardware camera track restore integration test
   - Full React 19 `App` render across `1920×1080`, `1440×900`, `1366×768`, `1024×768`, and `390×844` viewports, stepping through 8-step Onboarding, Personalization Studio, and all 9 Settings sections
   - Build & MV3 CSP audit (`'wasm-unsafe-eval'` quoting, SHA-256 verification of `hand_landmarker.task`, zero inline `<script>` tags, and `snap-vanish-chrome-extension.zip` integrity)

---

## Honest Environment Boundary Note

Automated tests run in Node.js + Vitest (`jsdom`). Because headless container environments do not attach physical USB webcams, microphones, or authenticated live Google Meet / Microsoft Teams / Zoom sessions, live hardware webcam inference and live multi-party WebRTC call behavior must be verified manually on a desktop machine using `chrome://extensions` → **Load unpacked** → `extension/`.
