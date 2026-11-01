# Snap Vanish 2.0 — Chrome Extension & Local Disintegration Studio

Snap your fingers on camera to disintegrate into warm ember dust and shards — and snap again (or press `Alt+Shift+R`) to reassemble cleanly back into your live feed.

Snap Vanish 2.0 is a privacy-first **Manifest V3 Chrome Extension** paired with an interactive **Control Center & Personalization Studio** built with React 19, TypeScript, Vite, Tailwind CSS v4, and bundled local **MediaPipe Tasks Vision** WebAssembly models.

---

## Key Capabilities in 2.0

- **Real Local 21-Point Hand Landmark Detection**: Runs `hand_landmarker.task` via bundled MediaPipe Tasks Vision WASM (`vision_wasm_module_internal.{js,wasm}`) inside Chrome's `ISOLATED` world — zero external CDN fetches.
- **Multi-Phase Snap State Machine**: Palm-normalized millimeter geometry (`normalizeLandmarksToMm`), velocity-adaptive landmark smoothing, 4 profiles (`Beginner`, `Balanced`, `Precision`, `Custom`), and a **7-Step Guided Calibration** workflow.
- **Acoustic Transient Confirmation Gate**: Optional Web Audio 1.8–4.2 kHz bandpass transient monitor with adaptive room noise floor, live input-level indicator, device selector, and synthetic transient self-test. Never records or uploads audio.
- **Pooled Multi-Effect Particle Engine**: Fine dust + rotating polygon shard fragments, multi-plane z-depth parallax, configurable motion smoothness curves, `visibilitychange` loop suspension, and 6+ built-in presets (`Classic Dust`, `Cinematic Disintegration`, `Fine Particles`, `Energy Burst`, `Gentle Fade`, `Reverse Assembly`, plus Voxel Dissolve and Digital Glitch).
- **Honest Background Reconstruction & Conferencing Integration**:
  - Supports Captured Clean Plate, Temporal EMA Background Estimation, Local MediaPipe Selfie Segmentation (`selfie_segmentation.tflite`), and Peripheral Room Fallback.
  - Uses a `document_start` `MAIN`-world `RTCPeerConnection` / `RTCRtpSender.replaceTrack()` bridge for outgoing WebRTC stream replacement on **Google Meet** and **Microsoft Teams Web**, with automatic fallback to local tile overlay and transparent **OBS Virtual Camera** guidance for **Zoom Web Client**.
- **Unconditional Emergency Restore (`Alt+Shift+R`)**: Centralized 14-code error recovery service that always restores your hardware camera feed on errors or hotkey trigger.

---

## Folder Structure

```text
snap-vanish-extensions/
├── extension/                       # Ready-to-load Chrome Manifest V3 unpacked extension
│   ├── manifest.json                # MV3 manifest (quoted 'wasm-unsafe-eval', options_page)
│   ├── background.js                # Service worker (message validation, commands, badge)
│   ├── content/
│   │   ├── main-world-bridge.js     # MAIN-world RTCPeerConnection / replaceTrack bridge
│   │   ├── snap-vanish.js           # ISOLATED-world MediaPipe hand AI, HUD & particle loop
│   │   └── snap-vanish.css          # Non-intrusive meeting HUD & tile overlay styles
│   ├── popup/
│   │   ├── popup.html               # Compact toolbar popup (Obsidian Charcoal + Warm Ember)
│   │   ├── popup.css
│   │   └── popup.js
│   ├── icons/                       # Generated 16/32/48/128 RGBA PNG icons
│   ├── models/                      # Bundled local hand_landmarker.task & selfie_segmentation.tflite
│   ├── wasm/                        # Bundled MediaPipe WASM module loader & binary
│   ├── vendor/                      # Bundled @mediapipe/tasks-vision ESM runtime
│   └── studio/                      # Compiled Control Center & Studio (options_page)
├── scripts/
│   ├── prepare-assets.mjs           # Downloads & SHA-256-verifies local MediaPipe binaries
│   ├── generate-icons.mjs           # Pure-Node RGBA PNG icon generator
│   └── build-extension.mjs          # Full Vite build + manifest/CSP audit + zip packager
├── src/
│   ├── components/                  # SnapStage, Dashboard, VanishPopup, OnboardingModal, UI kit
│   ├── features/
│   │   ├── audio/                   # LiveAudioConfirmationEngine & device enumeration
│   │   ├── calibration/             # 7-step CalibrationModal
│   │   ├── camera/                  # BackgroundReconstructor & Platform Compatibility Matrix
│   │   ├── detection/               # HandLandmarkService (MediaPipe Tasks Vision wrapper)
│   │   ├── settings/                # 9-section SettingsView + JSON export/import
│   │   └── studio/                  # PersonalizationStudio & custom preset CRUD
│   ├── lib/                         # gestureEngine, dust, settings, analytics, diagnostics, messaging
│   ├── services/                    # Centralized 14-code errorService
│   ├── types/                       # Canonical v2 TypeScript interfaces
│   └── __tests__/                   # Vitest unit, integration, DOM/responsive & build tests
├── docs/                            # Audit report, architecture, feature status & testing docs
└── snap-vanish-chrome-extension.zip # Packaged unpacked extension release archive
```

---

## Development & Build Instructions

### Prerequisites
- **Node.js** `20+` (verified on Node `22.22.3`) and **npm** `10+`
- **Google Chrome** `121+` (Windows 10/11, macOS, or Linux)

### Setup & Commands

```bash
# 1. Install dependencies
npm install

# 2. Provision & SHA-256-verify local MediaPipe WASM & model binaries (if needed)
npm run prepare:assets

# 3. Start local Control Center & Effect Studio dev server
npm run dev

# 4. Run TypeScript strict typecheck and automated test suite
npm run typecheck
npm test

# 5. Build web app + sync extension/studio/ + validate MV3 CSP + package zip
npm run build:extension
```

---

## Loading the Unpacked Extension in Chrome (Windows / macOS / Linux)

1. Run `npm run build:extension` (or extract `snap-vanish-chrome-extension.zip`).
2. Open Google Chrome and navigate to `chrome://extensions`.
3. Enable **Developer mode** using the toggle in the top-right corner.
4. Click **Load unpacked** in the top-left toolbar.
5. Select the `extension` directory inside this repository (e.g., `C:\path\to\snap-vanish-extensions\extension` on Windows).
6. Pin **Snap Vanish** from the Chrome puzzle-piece toolbar menu for one-click popup access, or right-click the icon → **Options** to open the full Control Center & Personalization Studio.
7. Join (or refresh an already-open tab of) **Google Meet** or **Microsoft Teams Web**.

---

## Performance & Architecture Audit

The full principal-engineer optimization report — MV3 lifecycle audit, offscreen/CSP topology,
particle-engine measurements, WebGL/WebGPU migration path, and the phased roadmap — lives in
[`docs/OPTIMIZATION_REPORT.md`](docs/OPTIMIZATION_REPORT.md). Reproduce the frame-cost numbers with:

```bash
npm run bench      # DustScene render-loop micro-benchmark (before/after)
npm run verify     # typecheck + tests + extension packaging & manifest gates
```

## Permissions & Privacy Architecture

| Permission / Directive | Scope | Purpose |
| :--- | :--- | :--- |
| `storage` | Local, Sync & Session | Compact preferences in `chrome.storage.sync`, optional metadata-only counts/custom presets in `chrome.storage.local`, and per-tab routing state in `chrome.storage.session` (the service worker keeps no in-memory state). |
| `offscreen` | `AUDIO_PLAYBACK` document | Plays the snap-confirmation cue without an `AudioContext` in the meeting page, and without depending on page user activation (keyboard-shortcut path). |
| `host_permissions` | The five supported meeting origins | Lets the service worker resolve which meeting tab a command targets. No `tabs`, no `activeTab`, no `<all_urls>`. |
| `content_scripts` & `web_accessible_resources` | `meet.google.com`, `teams.microsoft.com`, `teams.live.com`, `*.zoom.us/wc/*` | Injects WebRTC sender bridge + isolated MediaPipe hand inference strictly on supported conferencing domains (never `<all_urls>`). |
| `'wasm-unsafe-eval'` | Extension pages CSP | Required by Chrome Manifest V3 to compile bundled local MediaPipe WebAssembly binaries. Inline scripts remain strictly forbidden. |

**Verified Privacy Guarantees:**
- **Zero Video or Audio Recording**: Camera frames and Web Audio `Float32Array` buffers exist strictly in volatile RAM for the current frame and are immediately overwritten. Neither `MediaRecorder` nor remote `fetch`/`WebSocket` upload calls exist anywhere in the runtime pipeline.
- **Zero External Network Requests**: Fonts use local/system stacks and ML models (`hand_landmarker.task`, `selfie_segmentation.tflite`, WASM) load directly from local extension files.

---

## Supported Conferencing Platforms & Limitations

| Platform | Outgoing Stream Modification | Self-View Tile Overlay | Verification Status & Notes |
| :--- | :--- | :--- | :--- |
| **Google Meet** (`meet.google.com`) | Implemented (`RTCRtpSender.replaceTrack`) | Supported | Tested in automated harness; **Untested in live multi-party call** in headless CI. Refresh Meet tab once if installed mid-call so `document_start` hooks attach. |
| **Microsoft Teams Web** (`teams.microsoft.com`, `teams.live.com`) | Implemented (`RTCRtpSender.replaceTrack`) | Supported | Tested in automated harness; **Untested in live call**. Disable Teams' built-in background blur to avoid double matting. |
| **Zoom Web Client** (`*.zoom.us/wc/*`) | Limited (WASM media pipeline) | Supported | Zoom Web frequently encodes video through custom WebAssembly/WebCodecs instead of standard `RTCRtpSender` video tracks. Local overlay works; for outgoing Zoom replacement, capture the Snap Vanish Studio Stage in **OBS Virtual Camera**. |

---

## Troubleshooting Guide

- **Installed extension while a call was already open**: Reload the Google Meet or Teams tab once so `content/main-world-bridge.js` (`document_start`) wraps `RTCPeerConnection` before the call negotiates senders.
- **Camera or Microphone Permission Denied**: Click the site/extension lock icon in Chrome's address bar, allow Camera (and optionally Microphone), then click **Retry** or **Enable Live Webcam + Hand AI**.
- **Hand snaps not triggering in dim lighting**: Ensure front-facing lighting on your hand, hold your hand 35–65 cm from the webcam, and run the **7-Step Calibration** wizard (`Calibrate` button in the Dashboard header) or select the `Beginner` profile.
- **Camera appears stuck or you need immediate recovery**: Press `Alt+Shift+R` or click **Emergency Restore** in the Meeting HUD, Toolbar Popup, or Dashboard header. This unconditionally cancels transitions and restores your original hardware `MediaStreamTrack`.
