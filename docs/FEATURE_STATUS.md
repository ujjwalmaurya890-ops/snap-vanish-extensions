# Evidence-Based Feature Status Ledger

This ledger tracks every required product feature using strict verification status labels:

- **VERIFIED**: Inspected, implemented, and confirmed via automated test execution and/or build verification in this environment.
- **IMPLEMENTED, NOT VERIFIED**: Code is implemented and unit-tested with mocks/JSDOM, but end-to-end verification requires a real desktop Chrome browser, physical webcam/microphone hardware, or live Google Meet / Teams / Zoom call.
- **BLOCKED**: Requires external credentials (`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_BILLING_CHECKOUT_URL`), payment provider account, or remote deployment access not present in the sandbox.
- **NOT IMPLEMENTED**: Optional future scope not built in this release.
- **FAILED**: Verification failed (0 features currently in `FAILED` state).

---

## Feature Implementation Ledger

### A. Core Vanish and Restore Engine
- **Baseline Files:** `extension/content/snap-vanish.js`, `extension/background.js`, `src/components/SnapStage.tsx`
- **Baseline Issues Found:**
  - `segmentSelfie()`, `median3()`, `estimateHands()`, and `buildDustScene()` in `extension/content/snap-vanish.js` all threw `new Error(...)`.
  - `extension/content/snap-vanish.css` was missing (breaking unpacked extension loading).
  - `SNAP_VANISH_NOW` (`Alt+Shift+D`) was sent by `background.js` but unhandled in `snap-vanish.js`.
  - No state machine protection against mid-transition triggers, no `emergencyRestore()` action, and no `MediaStreamTrack` `ended` recovery.
- **Changes Made:**
  - Created `src/lib/vanishEngine.ts` (`VanishEngineController`) with explicit states (`live`, `vanishing`, `vanished`, `restoring`, `error`), repeated-trigger debounce, `emergencyRestore()`, `attachMediaTracks()`, and `dispose()`.
  - Rewrote `extension/content/snap-vanish.js` with working `segmentSelfie`, `median3`, `estimateHands`, `buildDustScene`, `SNAP_VANISH_NOW` and `EMERGENCY_RESTORE` handlers, and created `extension/content/snap-vanish.css`.
- **Permissions Required:** `activeTab`, `storage`, host permissions (`meet.google.com`, `teams.microsoft.com`, `*.zoom.us`).
- **Tests Executed:** `src/__tests__/snapVanish.test.ts` (Suite 4), `src/__tests__/extensionRuntime.test.ts` (Suite 7).
- **Status:**
  - Engine state machine, emergency restore, track-end recovery & message routing: **VERIFIED** (via Vitest).
  - Live Google Meet / Microsoft Teams / Zoom Web camera stream transformation in desktop Chrome: **IMPLEMENTED, NOT VERIFIED** (no Chrome binary or physical webcam inside sandbox).

---

### B. Advanced Visual Effects
- **Baseline Files:** `src/lib/dust.ts`
- **Baseline Issues Found:** Only implemented the single `dust` effect; lacked `pixel-dissolve`, `digital-glitch`, `fade-out`, `light-burst`, speed/size/density/color/intensity controls, Low-Power cap, and error fallback.
- **Changes Made:**
  - Upgraded `src/lib/dust.ts` (`DustScene.render`) to support all 5 effects (`dust`, `pixel-dissolve`, `digital-glitch`, `fade-out`, `light-burst`) with full reversibility (`t: 0 <-> 1`), configurable `speed`, `particleSize`, `density`, `colorAccent`, `intensity`, `lowPowerMode` (caps density at 35% and skips secondary motion smear), and `try/catch` cross-dissolve fallback.
- **Tests Executed:** `src/__tests__/snapVanish.test.ts` (Suite 6).
- **Status:** **VERIFIED**

---

### C. Custom Effect Studio & Preset Management
- **Baseline Files:** None (only 3 basic controls existed in `VanishPopup.tsx`).
- **Changes Made:**
  - Created `src/lib/settings.ts` with schema validation (`validateSettings`), 6 built-in presets (`BUILT_IN_PRESETS`), and full custom preset CRUD (`createPresetFromSettings`, `renamePreset`, `duplicatePreset`, `deletePreset`).
  - Built the Custom Effect Studio tab in `src/components/Dashboard.tsx` and connected all controls to live stage rendering and persistent storage.
- **Tests Executed:** `src/__tests__/snapVanish.test.ts` (Suites 1 & 2).
- **Status:** **VERIFIED**

---

### D. Gesture Studio & Calibration
- **Baseline Files:** `SnapDetector` and `AudioConfirmer` in `extension/content/snap-vanish.js`.
- **Baseline Issues Found:**
  - `AudioConfirmer.poll()` rejected the first loud transient after silence because `now - this.lastOnset > 90ms` was true after quiet periods.
  - Higher `sensitivity` made the distance threshold looser instead of stricter.
  - No cooldown protection, calibration flow, or gesture-to-action mapping existed.
- **Changes Made:**
  - Created `src/lib/gestureEngine.ts` (`SnapGestureDetector`, `AcousticSnapConfirmer`, `createSyntheticHandFrame`) fixing sensitivity direction, transient onset detection, wrist angular velocity (`>2.2 rad/s`) wave rejection, bounding-box (`>40%`) reach rejection, and cooldown enforcement.
  - Added interactive Gesture Studio & Calibration verification harness in `src/components/Dashboard.tsx`.
- **Tests Executed:** `src/__tests__/snapVanish.test.ts` (Suite 5).
- **Status:**
  - Landmark & acoustic transient algorithms, calibration settings, and false-positive rejection: **VERIFIED** (via Vitest).
  - Live webcam MediaPipe hand tracking in Chrome: **IMPLEMENTED, NOT VERIFIED** (requires physical webcam & bundled MediaPipe WASM task in Chrome).

---

### E. Smart Meeting Modes
- **Baseline Files:** None.
- **Changes Made:**
  - Defined `MEETING_MODES` (`professional`, `creative`, `minimal`, `low-power`) in `src/lib/settings.ts` with documented real parameter patches.
  - Added mode selectors in `extension/popup/popup.html`, `src/components/VanishPopup.tsx`, and `src/components/Dashboard.tsx`.
- **Tests Executed:** `src/__tests__/snapVanish.test.ts` (Suite 1).
- **Status:** **VERIFIED**

---

### F. Premium Popup UI/UX
- **Baseline Files:** `extension/popup/popup.html`, `popup.css`, `popup.js`, `src/components/VanishPopup.tsx`.
- **Changes Made:**
  - Upgraded both the unpacked extension popup (`extension/popup/*`) and the React popup (`src/components/VanishPopup.tsx`) to a cohesive dark theme (`#0d0e14` / `#151722`) with violet (`#7c3aed`) and ember (`#d2451e`) accents, status badges, Emergency Restore button, Effect & Preset selectors, Smart Meeting Mode buttons, Low-Power toggle, and shortcut guide.
- **Tests Executed:** Build & type-check verification + `src/__tests__/extensionRuntime.test.ts`.
- **Status:** **VERIFIED**

---

### G. First-Run Onboarding
- **Baseline Files:** None.
- **Changes Made:**
  - Created 6-step `src/components/OnboardingModal.tsx` covering extension overview, permission disclosures, live capability probing (`WebGL2`, `MediaDevices`, camera/mic permission states), shortcut guidance, interactive test effect trigger, and emergency restoration training.
- **Tests Executed:** `npm run typecheck` and `npm run build`.
- **Status:** **VERIFIED**

---

### H. Performance and Diagnostics
- **Baseline Files:** Static hardcoded strings in `src/App.tsx`.
- **Changes Made:**
  - Created `src/lib/diagnostics.ts` (`FramePerformanceTracker`, `checkWebGL2Support`, `checkMediaDevicesSupport`, `queryMediaPermissions`, `appendDiagnosticLog`, `clearDiagnosticLogs`).
  - Wired `SnapStage.tsx` to measure actual frame intervals (FPS) and canvas draw duration (`ms`) and display them in `App.tsx` and `Dashboard.tsx`.
- **Tests Executed:** `src/__tests__/snapVanish.test.ts` (Suite 6).
- **Status:** **VERIFIED**

---

### I. Privacy Center & J. Personal Usage Analytics
- **Baseline Files:** Static `PrivacyBand` in `src/components/Sections.tsx`.
- **Changes Made:**
  - Created `src/lib/analytics.ts` for local-only event tracking (`vanish_activated`, `restore_completed`, `emergency_restore`, `trigger_failed`, `preset_selected`), 7-day rolling usage chart (`getWeeklyUsageSummary`), and data deletion (`clearAnalyticsData`).
  - Added Privacy Center and Usage Analytics screens in `src/components/Dashboard.tsx`.
- **Tests Executed:** `src/__tests__/snapVanish.test.ts` (Suite 6).
- **Status:** **VERIFIED**

---

### K. SaaS Web Dashboard
- **Baseline Files:** `src/App.tsx` (marketing page only).
- **Changes Made:**
  - Created `src/components/Dashboard.tsx` with 8 synchronized views (`Overview`, `Effect Studio & Presets`, `Gesture Studio & Modes`, `Usage Analytics`, `Diagnostics & Perf`, `Privacy Center`, `Account, Cloud & Plans`, `Feedback & Changelog`) wired to `localStorage`, `chrome.storage.sync`, and `BroadcastChannel("snap_vanish_channel")`.
- **Tests Executed:** `npm run typecheck`, `npm test`, `npm run build`.
- **Status:** **VERIFIED**

---

### L. Authentication & Cloud Sync / M. Free & Pro Plans / N. Billing
- **Baseline Files:** None.
- **Changes Made:**
  - Created `src/lib/cloudAndBilling.ts` implementing Supabase REST authentication (`authenticateWithCloud`), deterministic `updatedAt` preset conflict resolution (`resolvePresetSyncConflicts`), and transparent entitlement checking (`getEntitlementState`).
  - Explicitly reports `BLOCKED` when `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, or `VITE_BILLING_CHECKOUT_URL` are not configured, preventing any fake login or fake billing behavior.
- **Tests Executed:** `src/__tests__/snapVanish.test.ts` (Suite 6).
- **Status:**
  - Local conflict resolution, input validation, and honest entitlement logic: **VERIFIED**
  - Live Supabase Auth/PostgREST sync & Stripe checkout: **BLOCKED** (requires external `VITE_SUPABASE_*` and `VITE_BILLING_*` credentials).

---

### O. Feedback and Updates
- **Baseline Files:** None.
- **Changes Made:**
  - Created `src/lib/feedbackAndChangelog.ts` with validated local feedback/bug report submission, strict opt-in consent check before attaching diagnostic telemetry, and v2.0.0 / v1.4.0 changelog entries.
- **Tests Executed:** `src/__tests__/snapVanish.test.ts` (Suite 6).
- **Status:** **VERIFIED**

---

### P. Optional Future Features
- **Status:** **NOT IMPLEMENTED** (treated as separate future modules per Section 4.P: AI meeting note summaries, creator marketplace, custom 3D scene backgrounds).
