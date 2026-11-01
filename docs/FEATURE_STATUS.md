# Snap Vanish 2.0 — Honest Feature Status Matrix

Every major capability is classified transparently into one of four categories:
- **Fully implemented and tested** (implemented in production source code and verified via automated tests / build pipeline)
- **Partially implemented** (implemented with documented architectural or platform constraints)
- **Experimental** (functional in controlled conditions with hardware/platform variance)
- **Untested** (implemented in code, requires physical webcam/microphone or live authenticated conferencing session to verify end-to-end)

| Feature / Subsystem | Classification | Verification Details & Honest Notes |
| :--- | :--- | :--- |
| **Design System & Visual Redesign** (Obsidian Charcoal + Warm Ember) | **Fully implemented and tested** | Unified dark charcoal + warm ember palette across Dashboard, Studio, 9-Section Settings, Onboarding, Calibration, Popup, and Meeting HUD. Verified in DOM tests across 5 viewports. |
| **9-Section Settings + Schema v2 Migration + JSON Export/Import** | **Fully implemented and tested** | All 9 sections mutate real runtime state; v1→v2 migration and JSON export/import verified in unit & DOM tests. |
| **Pooled Multi-Effect Particle Engine & 6+ Presets** | **Fully implemented and tested** | Fine dust + rotating polygon shards, depth parallax, smoothness curves, `visibilitychange` pause, live `<video>` passthrough at `t=0`, and custom preset CRUD verified in unit & DOM tests. |
| **Snap Kinematic State Machine & 4 Profiles** (`Beginner`, `Balanced`, `Precision`, `Custom`) | **Fully implemented and tested** | `normalizeLandmarksToMm`, `LandmarkSmoother`, approach velocity, wrist stability, cooldown, and false-trigger protection verified in unit tests. |
| **Local MediaPipe 21-Point HandLandmarker WASM Pipeline** | **Partially implemented** (Live webcam inference **Untested** in container) | Official `hand_landmarker.task` (SHA-256 verified) + `ISOLATED`-world WASM module loader bundled locally with GPU→CPU fallback. Real webcam inference requires physical camera hardware. |
| **7-Step Guided Gesture Calibration** | **Fully implemented and tested** (Live camera path **Untested** in container) | Full 7-step UI workflow implemented with both live webcam MediaPipe mode and deterministic Synthetic Kinematic Benchmark mode. |
| **Acoustic Snap Confirmation Engine** | **Fully implemented and tested** (Physical mic hardware **Untested** in container) | Web Audio 1.8–4.2 kHz bandpass filter, adaptive noise floor, device enumeration, confirmation window, and synthetic transient self-test verified; zero audio recording/uploads. |
| **Background Reconstruction** (Captured Plate, Temporal EMA, Selfie Segmentation, Fallback) | **Partially implemented** | `BackgroundReconstructor` + bundled `selfie_segmentation.tflite` implemented and unit-tested; single-webcam inpainting cannot see behind permanently occluded furniture unless an empty plate is captured first. |
| **Google Meet & Microsoft Teams Outgoing Stream Replacement** (`MAIN`-world `RTCRtpSender.replaceTrack`) | **Partially implemented** (**Untested** in live authenticated calls) | `main-world-bridge.js` + `snap-vanish.js` verified in automated WebRTC mock harness. Requires tab load prior to `RTCPeerConnection` creation; live Meet/Teams sessions must be verified on desktop Chrome. |
| **Zoom Web Client Integration** | **Experimental** | Zoom Web frequently uses custom WASM/WebCodecs media transport rather than standard `RTCRtpSender` video tracks; local tile overlay works, while OBS Virtual Camera is documented for outgoing stream replacement. |
| **8-Step Onboarding, Metadata-Only Activity History, Shortcuts & 14-Code Error Service** | **Fully implemented and tested** | Verified across unit, integration, and DOM tests; `Emergency Restore` (`Alt+Shift+R`) unconditionally restores live camera state. |
| **Production MV3 Extension Build & Zip Package** | **Fully implemented and tested** | Quoted `'wasm-unsafe-eval'`, external CSP-safe bundles, generated PNG icons, validated `manifest.json`, and `snap-vanish-chrome-extension.zip` (10.40 MB) verified by `npm run build:extension`. |
