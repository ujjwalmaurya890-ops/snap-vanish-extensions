# Snap Vanish — Testing & Verification Guide

## 1. Automated Test Suite

Automated tests are implemented using **Vitest** (`v5.0.5`) with the `jsdom` environment and located in `src/__tests__/`:

- `src/__tests__/snapVanish.test.ts` (17 tests):
  1. **Settings Validation & Persistence**: Verifies `DEFAULT_SETTINGS`, out-of-range numeric clamping (`duration`, `speed`, `particleSize`, `density`, `intensity`, `sensitivity`, `cooldownMs`), invalid enum/hex rejection, `localStorage` and `chrome.storage.sync` persistence, and Smart Meeting Mode patches (`professional`, `creative`, `minimal`, `low-power`).
  2. **Preset CRUD Lifecycle**: Verifies built-in preset loading, custom preset creation, renaming, duplication, built-in deletion protection, and custom preset deletion.
  3. **Extension Messaging & Service-Worker Restart Recovery**: Verifies `validateExtensionMessage` against valid and malformed payloads, and verifies `sendExtensionMessage` retry behavior when `chrome.runtime.lastError` occurs during service-worker wake-up.
  4. **Core Vanish & Restore Engine**: Verifies state transitions (`live` -> `vanishing` -> `vanished` -> `restoring` -> `live`), repeated-trigger rejection during active transitions, idempotent initialization, unexpected `MediaStreamTrack` `ended` event handling, `emergencyRestore()`, effect failure fallback to `fade-out`, and `dispose()` resource cleanup.
  5. **Gesture & Acoustic Transient Detection**: Verifies `SnapGestureDetector` confirming valid 52mm -> 8mm collapse within 120ms, rejecting fast wrist waves (`>2.2 rad/s`), rejecting reaching movements (`>40%` bbox area delta), enforcing cooldowns, and `AcousticSnapConfirmer` confirming short `>=12dB` transients while rejecting sustained speech (`>90ms`).
  6. **Visual Effects, Analytics, Diagnostics, Cloud Sync & Feedback Consent**: Verifies all 5 visual effects (`dust`, `pixel-dissolve`, `digital-glitch`, `fade-out`, `light-burst`) in forward, reverse, and Low-Power modes, canvas error fallback, local usage analytics & 7-day summary, `FramePerformanceTracker` FPS/latency math, honest `BLOCKED` cloud status when Supabase env vars are absent, deterministic `resolvePresetSyncConflicts`, and opt-in diagnostic attachment consent in `submitFeedback`.

- `src/__tests__/extensionRuntime.test.ts` (2 tests):
  1. **Manifest & Asset Integrity**: Parses `extension/manifest.json`, verifies Manifest V3 fields, confirms least-privilege permissions (`["activeTab", "storage"]`), and checks that every referenced service worker, popup, JS, and CSS file exists on disk.
  2. **Content Script Execution & Message Dispatch**: Loads and executes `extension/content/snap-vanish.js` in JSDOM and verifies `STATE`, `SNAP_VANISH_NOW`, `EMERGENCY_RESTORE`, `SETTINGS`, and `RUN_DIAGNOSTICS` message handlers execute without throwing.

---

## 2. Commands Executed & Actual Results

| Command | Executed | Exit Code | Result |
| :--- | :---: | :---: | :--- |
| `npm run typecheck` (`tsc --noEmit`) | Yes | `0` | Passed with zero TypeScript errors. |
| `npm test` (`vitest run`) | Yes | `0` | **2 test files passed, 19 tests passed** (`src/__tests__/snapVanish.test.ts`, `src/__tests__/extensionRuntime.test.ts`). |
| `npm run build` (`vite build`) | Yes | `0` | Built production web bundle (`dist/index.html`) cleanly. |

---

## 3. Manual Chrome & Hardware Verification Checklist

Because automated JSDOM/Vitest unit tests do not substitute for a physical webcam, microphone, or live WebRTC meeting tab, run the following manual verification steps in desktop Google Chrome (v121+):

1. **Load Unpacked Extension**:
   - Open `chrome://extensions` in Google Chrome.
   - Enable **Developer mode** (top-right toggle).
   - Click **Load unpacked** and select the `extension/` directory in this repository.
   - Confirm that the extension loads with version `2.0.0` and zero manifest or missing-file errors.
2. **Verify Popup & Keyboard Shortcuts**:
   - Click the Snap Vanish toolbar icon to open the 360px dark-theme popup.
   - Verify that when on a non-call tab, the popup displays the yellow compatibility banner (`No active call tab`).
   - Open `https://meet.google.com/` (or Microsoft Teams / Zoom Web client) and start/join a test meeting.
   - Press `Alt+Shift+S` (or click **Vanish Now** in the popup) and verify the on-call HUD transitions `LIVE -> VANISHING -> VANISHED` and the overlay canvas renders over the call video element.
   - Press `Alt+Shift+R` (or click **Restore**) at any point during or after the transition and verify immediate restoration to `LIVE`.
