# Snap Vanish v2.0.0 — System Architecture

## 1. High-Level Overview

Snap Vanish is organized into two synchronized runtime surfaces built from a shared repository:

1. **Chrome Manifest V3 Extension (`extension/`)**:
   - `extension/manifest.json`: Declares least-privilege permissions (`activeTab`, `storage`) and host permissions (`meet.google.com`, `teams.microsoft.com`, `*.zoom.us`).
   - `extension/background.js`: Service worker that initializes default settings in `chrome.storage.sync`, validates incoming runtime messages, and dispatches keyboard shortcuts (`Alt+Shift+S`, `Alt+Shift+D`, `Alt+Shift+M`, `Alt+Shift+R`) to the active call tab.
   - `extension/content/snap-vanish.js` & `extension/content/snap-vanish.css`: Content script that manages the call-tab state machine (`live`, `vanishing`, `vanished`, `restoring`, `error`), hand-landmark + acoustic snap confirmation, reversible canvas overlay rendering, emergency restore HUD, and resource cleanup.
   - `extension/popup/popup.html`, `popup.css`, `popup.js`: 360px dark-theme popup controller for real-time call control, effect selection, Smart Meeting Mode switching, and recovery.

2. **Companion SaaS Web Application & Studio (`src/`)**:
   - Built with React 19, TypeScript 5.9, Tailwind CSS v4, and Vite 7.
   - Hosts the interactive 1280×720 60fps calibration stage (`SnapStage.tsx`), synchronized popup preview (`VanishPopup.tsx`), First-Run Onboarding Wizard (`OnboardingModal.tsx`), and full 8-module SaaS Control Center (`Dashboard.tsx`).

---

## 2. Separation of Concerns (`src/`)

| Layer | File Path | Responsibility |
| :--- | :--- | :--- |
| **Shared Types** | `src/types/snapVanish.ts` | Canonical TypeScript interfaces for `SnapSettings`, `EffectPreset`, `EngineState`, `InterceptionMode`, `ExtensionMessage`, `UsageAnalyticsSummary`, `DiagnosticSnapshot`, `EntitlementState`, and `FeedbackSubmission`. |
| **Settings & Presets** | `src/lib/settings.ts` | Schema validation (`validateSettings`, `mergeAndValidateSettings`), Smart Meeting Mode definitions (`MEETING_MODES`), built-in and custom preset CRUD, and dual persistence (`localStorage` + `chrome.storage.sync` + `BroadcastChannel`). |
| **Messaging Bridge** | `src/lib/messaging.ts` | Runtime message schema validator (`validateExtensionMessage`) and resilient `chrome.runtime.sendMessage` wrapper (`sendExtensionMessage`) with automatic retry on service-worker wake-up. |
| **Core Vanish Engine** | `src/lib/vanishEngine.ts` | Deterministic state machine (`live` -> `vanishing` -> `vanished` -> `restoring` -> `live` + `error`), repeated-trigger debounce/cooldown protection, idempotent initialization, `MediaStreamTrack` `ended` recovery, `emergencyRestore()`, and `dispose()`. |
| **Multi-Effect Renderer** | `src/lib/dust.ts` | Analytic, reversible (`t: 0 <-> 1`) 2D Canvas effect engine supporting `dust`, `pixel-dissolve`, `digital-glitch`, `fade-out`, and `light-burst`, with Low-Power density capping and automatic cross-dissolve fallback on error. |
| **Gesture & Audio Engine** | `src/lib/gestureEngine.ts` | 21-point hand landmark trajectory evaluator (`SnapGestureDetector`) with wrist angular velocity and bounding-box stability checks, plus short-transient acoustic confirmer (`AcousticSnapConfirmer`). |
| **Local Analytics** | `src/lib/analytics.ts` | Privacy-preserving local event counters, 7-day rolling usage aggregation (`getWeeklyUsageSummary`), and instant data wipe (`clearAnalyticsData`). |
| **Diagnostics & Telemetry** | `src/lib/diagnostics.ts` | Real frame-interval FPS and per-frame render latency tracker (`FramePerformanceTracker`), WebGL2/MediaDevices capability probing, and local diagnostic log rotation. |
| **Cloud Sync & Billing** | `src/lib/cloudAndBilling.ts` | Optional Supabase GoTrue/PostgREST client, deterministic `updatedAt` preset conflict resolver (`resolvePresetSyncConflicts`), and honest `BLOCKED` reporting when credentials are unconfigured. |
| **Feedback & Changelog** | `src/lib/feedbackAndChangelog.ts` | Local bug/feature report store with explicit opt-in consent before attaching diagnostic snapshots, plus structured release notes. |

---

## 3. Video Pipeline & WebRTC Interception Architecture

A critical architectural distinction in browser extensions is how camera effects are displayed:

1. **`preview-only` (Companion Web Dashboard / Studio)**:
   - Renders effects over the local calibration room and person plates on a 1280×720 `<canvas>` element while measuring real frame latency and FPS.
2. **`dom-overlay` (Default Content Script Mode on Meet / Teams / Zoom)**:
   - Content scripts declared in `manifest.json` execute in Chrome's `ISOLATED` JavaScript world.
   - When triggered on a call tab, `VanishController` captures the current video frame, constructs the particle/effect scene over the background plate, mounts `.snap-vanish-overlay-canvas` over the call video container, and synchronizes microphone mute state.
3. **`webrtc-sender` (Direct `RTCRtpSender.replaceTrack` Mode)**:
   - Replacing outgoing WebRTC tracks sent to remote peers requires page-level `RTCPeerConnection` references (`window.__snapVanishPeerConnections`).
   - Rather than claiming `replaceTrack()` succeeded when no `RTCPeerConnection` sender was intercepted, `VanishController` explicitly reports `interceptionMode` as `"webrtc-sender"` only when active peer connections are present, `"dom-overlay"` when overlaying the page's `<video>` element, or `"inactive"` when no video element is active.

---

## 4. Security & Privacy Architecture

- **Zero Default Egress:** No camera frames, background plates, or microphone audio buffers are ever serialized or transmitted over the network.
- **Least-Privilege Manifest V3:** Only `activeTab` and `storage` permissions are requested; the unused `offscreen` permission from the v1.4.0 baseline has been removed.
- **No Hardcoded Secrets:** Cloud sync and billing URLs are read strictly from `VITE_*` environment variables and remain disabled (`BLOCKED`) until configured by the operator.
