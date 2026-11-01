# Snap Vanish 2.0 — Technical Architecture

## 1. Dual-Surface Architecture

Snap Vanish 2.0 operates seamlessly across two synchronized surfaces sharing a single TypeScript core:

1. **Control Center & Personalization Studio (`src/` → `dist/` & `extension/studio/`)**
   - Full-featured React 19 + TypeScript application bundled with external CSP-safe assets (`base: "./"`).
   - Serves both as the standalone web Effect Studio (`npm run dev`) and as the Chrome Extension `options_page` (`extension/studio/index.html`).
2. **Manifest V3 Conferencing Runtime (`extension/`)**
   - **`extension/content/main-world-bridge.js` (`MAIN` world, `document_start`)**: Wraps `window.RTCPeerConnection` prior to call initialization, tracking active video `RTCRtpSender`s and their original hardware `MediaStreamTrack`s. Handles `ATTACH_PROCESSED_STREAM` (`sender.replaceTrack(canvasTrack)`) and `RESTORE_ORIGINAL_TRACK` (`sender.replaceTrack(originalHardwareTrack)`).
   - **`extension/content/snap-vanish.js` (`ISOLATED` world, `document_idle`)**: Loads bundled MediaPipe HandLandmarker WASM inside the isolated extension world, evaluates 21-point hand kinematics + optional Web Audio transient confirmation, renders pooled dust/fragment particles onto `#snap-vanish-rtc-canvas` and `#snap-vanish-overlay-canvas`, and manages the non-intrusive `#snap-vanish-hud`.
   - **`extension/background.js`**: Stateless MV3 service worker validating messages, routing Chrome `commands` (`Alt+Shift+S`, `Alt+Shift+D`, `Alt+Shift+M`, `Alt+Shift+R`), and updating toolbar badge state.
   - **`extension/popup/*`**: Lightweight zero-framework popup synchronized via `chrome.storage.sync`, `chrome.storage.local`, and runtime messaging.

---

## 2. MediaPipe MV3 `ISOLATED`-World WASM Loader

In `@mediapipe/tasks-vision`, the default `FilesetResolver.forVisionTasks()` helper injects a `<script src="...">` element into `document.body`. Inside a Chrome MV3 content script:
1. `<script>` tags injected into `document.body` execute in the host page's `MAIN` world (frequently blocked by Google Meet / Teams Trusted Types & CSP), and
2. `self.ModuleFactory` remains `undefined` inside the content script's `ISOLATED` world.

Snap Vanish solves this cleanly in both `src/features/detection/handTracker.ts` and `extension/content/snap-vanish.js` by:
1. Dynamically importing `wasm/vision_wasm_module_internal.js` via `await import(...)` inside the current JS realm, binding `globalThis.ModuleFactory = mod.default`.
2. Passing `{ wasmLoaderPath: "", wasmBinaryPath: wasmBinaryUrl }` to `HandLandmarker.createFromOptions()`, skipping `<script>` DOM injection completely while loading `models/hand_landmarker.task` from local extension storage with automatic GPU → CPU delegate fallback.

---

## 3. Storage Partitioning & Schema Migration

- **`chrome.storage.sync`**: Stores validated `SnapSettings` (`schemaVersion: 2`, compact preferences well under Chrome's 8 KB item quota). Legacy v1 payloads are automatically upgraded by `migrateSettingsPayload()`.
- **`chrome.storage.local`**: Stores custom `EffectPreset[]`, metadata-only `UsageAnalyticsSummary`, and the bounded 120-entry `DiagnosticLogEntry[]` ring buffer so logs never consume sync quota or leave the local machine.
