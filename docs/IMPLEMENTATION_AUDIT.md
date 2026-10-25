# Phase 0 & Phase 1 — Technical Implementation Audit

**Repository:** `ujjwalmaurya890-ops/snap-vanish-extensions`  
**Branch:** `arena/b1edc8aa-snap-vanish-extensions`  
**Audit Date:** 2026-10-25  

---

## 1. Repository Structure & Packaging State

At initial checkout (`39999257df00b66d0867c6af6460cf377cb45df7`), the repository root contained only two committed files:
- `README.md` (24 bytes: `# snap-vanish-extensions`)
- `snap-vanish-chrome-extension.zip` (796,977 bytes)

Unpacking `snap-vanish-chrome-extension.zip` reveals the project structure:

```text
snap-vanish-extensions/
├── README.md
├── snap-vanish-chrome-extension.zip
├── index.html
├── package.json
├── package-lock.json
├── tsconfig.json
├── vite.config.ts
├── extension/
│   ├── manifest.json
│   ├── background.js
│   ├── content/
│   │   └── snap-vanish.js
│   └── popup/
│       ├── popup.html
│       ├── popup.css
│       └── popup.js
├── public/
│   └── images/
│       ├── dust-macro.jpg
│       ├── feed-person.jpg
│       └── room-empty.jpg
└── src/
    ├── App.tsx
    ├── index.css
    ├── main.tsx
    ├── vite-env.d.ts
    ├── components/
    │   ├── Sections.tsx
    │   ├── SnapMark.tsx
    │   ├── SnapStage.tsx
    │   └── VanishPopup.tsx
    ├── lib/
    │   └── dust.ts
    └── utils/
        └── cn.ts
```

---

## 2. Baseline Build, Type-Check, and Test Execution

Before making any code edits, the existing commands from `package.json` were executed:

| Command | Executed | Exit Code | Result & Output | Pre-existing? |
| :--- | :---: | :---: | :--- | :---: |
| `npm install` | Yes | `0` | Installed 100 packages (`react@19.2.6`, `vite@7.3.2`, `@tailwindcss/vite@4.1.17`, `typescript@5.9.3`, `framer-motion`, etc.). | N/A |
| `npx tsc --noEmit` | Yes | `0` | Passed with no output because `vite/client` provides a wildcard `*.jpg` ambient module declaration that masks missing image paths during type-checking. | N/A |
| `npm run build` (`vite build`) | Yes | `1` (Failed) | `Could not resolve "../assets/room-empty.jpg" from "src/components/SnapStage.tsx"` | **Yes (Pre-existing)** |
| Automated tests (`npm test`) | No script in `package.json` | N/A | `package.json` only defines `dev`, `build`, and `preview`. Zero test files or test runners exist in the baseline repo. | **Yes (Pre-existing)** |

---

## 3. Architecture & Module Inspection

### 3.1 Web Application (`src/`)
- **Purpose in Baseline:** Currently a marketing/showcase single-page React 19 + Tailwind CSS v4 + Vite 7 application (`App.tsx`, `Sections.tsx`) with an interactive 2D Canvas particle disintegration stage (`SnapStage.tsx` + `src/lib/dust.ts`) and an embedded preview of the popup (`VanishPopup.tsx`).
- **Vite Config (`vite.config.ts`):** Uses `@vitejs/plugin-react`, `@tailwindcss/vite`, and `vite-plugin-singlefile`.
- **Broken Asset Imports (`src/components/SnapStage.tsx`, `src/components/Sections.tsx`):**
  - `SnapStage.tsx` imports `../assets/room-empty.jpg` and `../assets/feed-person.jpg`.
  - `Sections.tsx` imports `../assets/dust-macro.jpg` and `../assets/feed-person.jpg`.
  - However, `src/assets/` does **not** exist; the three JPEG files are located in `public/images/`. This causes `npm run build` to fail immediately.
- **Disconnect Between Web App and Extension:**
  - `src/components/VanishPopup.tsx` is a React replica of `extension/popup/popup.html` + `popup.js`, operating purely on local React state (`useState` in `App.tsx`).
  - There is no companion SaaS Web Dashboard yet, no preset management, no analytics store, no privacy center UI, and no synchronization bridge between the web app and the Chrome extension.

### 3.2 Chrome Extension (`extension/`)
- **Manifest (`extension/manifest.json`):**
  - Manifest V3 (`version: "1.4.0"`, `minimum_chrome_version: "121"`).
  - Permissions: `["activeTab", "storage", "offscreen"]`. Note: `"offscreen"` is requested in `manifest.json` but never used anywhere in `background.js` or `snap-vanish.js`.
  - Host permissions: `https://meet.google.com/*`, `https://teams.microsoft.com/*`, `https://*.zoom.us/*`.
  - **CRITICAL BUG (Missing Content Script CSS):** `content_scripts[0].css` specifies `["content/snap-vanish.css"]`, which **does not exist** in `extension/content/`. Chrome refuses to load an unpacked extension when any file declared in `content_scripts` is missing.
  - **Missing Web Accessible Resources:** `web_accessible_resources` references `["models/*"]`, which also does not exist in `extension/`.
- **Service Worker (`extension/background.js`):**
  - Initializes 5 settings (`enabled`, `sensitivity`, `duration`, `direction`, `sound`) in `chrome.storage.sync` on `runtime.onInstalled`.
  - Routes keyboard commands (`toggle-snap`, `vanish-now`, `mute-only`, `reset-frame`) and popup messages (`SNAP_NOW`, `SETTINGS_CHANGED`, `GET_STATE`, `PING`) to the active call tab.
  - **CRITICAL BUG (Unhandled Message Type):** `background.js` maps the `"vanish-now"` command (`Alt+Shift+D`) to `{ type: "SNAP_VANISH_NOW" }`. In `extension/content/snap-vanish.js`, the `onMessage` `switch` statement only handles `SNAP_TOGGLE`, `MUTE_TOGGLE`, `RESET_FRAME`, `SETTINGS`, and `STATE`. Consequently, `SNAP_VANISH_NOW` hits `default: respond({ ok: false })` and does nothing.
- **Content Script (`extension/content/snap-vanish.js`):**
  - **CRITICAL BUG (Throwing Stubs / Placeholder Functions):** Lines 224–228 define:
    - `function median3() { throw new Error("bound to bundled WASM model in the shipped build"); }`
    - `function segmentSelfie() { throw new Error("bound to bundled WASM model in the shipped build"); }`
    - `function estimateHands() { throw new Error("bound to bundled WASM model in the shipped build"); }`
    - `function buildDustScene() { throw new Error("see content/dust-engine.js — 22k particle curl-noise field"); }`
    - `function peerConnections() { return []; }`
  - Because `estimateHands()` throws unconditionally on the very first frame in `VanishController.loop()`, and `start()` is invoked with `.catch(() => {})` (line 264), the content script silently crashes on load after opening a webcam/mic stream.
  - **CRITICAL BUG (`toggle()` Crashes & Never Renders):**
    - `toggle()` calls `this.matte.frame(...)` -> `segmentSelfie()` (throws) and `buildDustScene()` (throws).
    - Even if `buildDustScene()` did not throw, `this.plate` is initialized to `null` and never populated, and `this.paint()` is never called anywhere in `VanishController`!
  - **CRITICAL BUG (WebRTC Isolation & Stream Handling Assumptions):**
    - Content scripts run in Chrome's `ISOLATED` execution world by default. In the isolated world, page-level `RTCPeerConnection` instances created by Google Meet, Zoom, or Teams are unreachable.
    - Furthermore, `peerConnections()` returns a hardcoded empty array `[]`.
    - `VanishController.start()` immediately calls `navigator.mediaDevices.getUserMedia({ video: true, audio: true })` on page load, acquiring a separate camera/mic stream that is never closed, cleaned up, or released if the user revokes permissions or leaves the call.
  - **LOGIC BUG in `AudioConfirmer.poll()`:**
    - Lines 126–128:
      ```js
      const transient = now - this.lastOnset;
      this.lastOnset = now;
      if (transient > SNAP.AUDIO_MAX_TRANSIENT_MS) return null;
      ```
    - On the first loud acoustic transient after silence, `now - this.lastOnset` is large (`> 90ms`), so `poll()` rejects it and returns `null`. It only returns `now` if a second loud poll occurs within 90ms of the previous loud poll, which selects sustained noise rather than a crisp transient onset.
- **Popup (`extension/popup/popup.html`, `popup.css`, `popup.js`):**
  - Basic 360px light-mode popup with 5 controls (`enabled`, `snap`, `sensitivity`, `duration`, `direction`, `sound`).
  - Lacks error state handling when no call tab is open (`SNAP_NOW` response is ignored; clicking "Snap now" on a non-call tab gives zero feedback).
  - Lacks effect selector, preset selector, meeting modes, emergency restore button, calibration/gesture status, onboarding, diagnostics, or link to dashboard/settings.

---

## 4. Explicit Search Findings (Anti-Hallucination Checklist)

| Category | Findings in Baseline Repository |
| :--- | :--- |
| **Empty / Throwing Function Bodies** | `median3()`, `segmentSelfie()`, `estimateHands()`, `buildDustScene()` in `extension/content/snap-vanish.js` (lines 224–227) all throw `new Error(...)`. `peerConnections()` (line 228) returns `[]`. `.catch(() => {})` on lines 264–265 swallows startup errors. |
| **TODO / FIXME Markers** | None using literal `TODO`/`FIXME` strings; instead, throwing stubs comment `/* --- small helpers the real build implements against the bundled model --- */`. |
| **Placeholder / Fake Metrics** | `src/App.tsx` (lines 84–89) hardcodes static marketing strings (`Latency: 41 ms`, `Matte: 25 fps`, `False triggers: 0 / 6 h`, `Egress: 0 B`). `src/components/Sections.tsx` (lines 422–430) lists non-existent files (`content/snap-vanish.css`, `models/hands.task`). |
| **Unhandled Promises** | `extension/popup/popup.js`: `chrome.storage.sync.set(state)` has no `try/catch`; `chrome.runtime.sendMessage({ type: "SNAP_NOW" })` ignores the response/error. `extension/background.js`: `send({ type: action })` in `chrome.commands.onCommand` is not awaited or `.catch()`-handled. |
| **Invalid / Mismatched Message Types** | `background.js` sends `{ type: "SNAP_VANISH_NOW" }` for the `vanish-now` command; `snap-vanish.js` does not handle `SNAP_VANISH_NOW`. |
| **Duplicate Listeners / Resource Leaks** | `VanishController.loop()` schedules `requestAnimationFrame(() => this.loop())` indefinitely with no cancellation token or `stop()` method. MediaStream tracks (`videoTrack`, `audioTrack`) and `AudioContext` are never closed. |
| **Race Conditions** | `VanishController.toggle()` has no state machine (`idle`, `vanishing`, `vanished`, `restoring`, `error`) and no cooldown/debounce lock against rapid repeated triggers. |
| **Missing Files Referenced in Code** | `src/assets/room-empty.jpg`, `src/assets/feed-person.jpg`, `src/assets/dust-macro.jpg`, `extension/content/snap-vanish.css`, `extension/models/*`. |

---

## 5. Security, Privacy, Accessibility, and Compatibility Risks

1. **Unnecessary Permission (`offscreen`):** `extension/manifest.json` requests `"offscreen"` without using `chrome.offscreen`. Removing unused permissions adheres to Chrome Web Store least-privilege guidelines.
2. **Unsolicited Camera/Mic Access on Page Load:** `snap-vanish.js` calls `getUserMedia({ video: true, audio: true })` immediately on `window.load` even before the user joins a meeting or enables gesture detection.
3. **WebRTC Track Replacement Limitation:**
   - In Chrome Manifest V3, modifying a web page's outgoing WebRTC camera stream requires either:
     - Wrapping `navigator.mediaDevices.getUserMedia` / `RTCPeerConnection` in the page's `MAIN` world prior to call initialization (`run_at: "document_start"`), **and/or**
     - Applying a direct visual canvas overlay over the meeting page's self-view and video elements while clearly reporting whether the outgoing WebRTC sender track (`RTCRtpSender.replaceTrack`) is actively intercepted or running in local overlay fallback mode.
   - We must never claim outgoing WebRTC stream replacement succeeded unless a real `RTCRtpSender` video track was intercepted and replaced via `replaceTrack()`, and we must report the exact interception status (`webrtc-replaced` vs `overlay-only` vs `standalone-preview`) honestly in the UI and diagnostics.
4. **Sandbox Verification Constraints:**
   - This build environment runs Node.js `v22.22.3` and `npm 10.9.8` on Linux without a graphical display, physical webcam/microphone hardware, or an installed Chrome/Chromium binary.
   - Therefore, unit and integration tests can be verified via Vitest + JSDOM/Canvas mocks, and both the web dashboard and extension bundle can be built and statically/programmatically verified, while real Chrome unpacked loading, physical webcam/mic capture, and live Google Meet / Teams / Zoom WebRTC calls must be explicitly marked `IMPLEMENTED, NOT VERIFIED` (requiring manual verification in Chrome with hardware).
