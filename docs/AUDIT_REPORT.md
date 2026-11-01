# Snap Vanish — Complete Project Audit (2.0 → 2.1)

**Audit date:** 2026-11-01 · **Branch:** `arena/6f19cffc-snap-vanish-extensions` · **Baseline:** `f06dea5` (v2.0.0, merged PR #3)

Every file in `extension/`, `src/`, `scripts/`, build config, and tests was inspected.
The previous upgrade had already taken the project from the v1.4.0 prototype to v2.0.0, so
this audit verifies the 2.0.0 codebase honestly against the full 20-section upgrade brief
and records what still had to be fixed to make it production-honest.

---

## 1. Existing functionality (verified working in code + automated tests)

| Area | Status | Evidence |
| --- | --- | --- |
| MV3 manifest | ✅ | Quoted `'wasm-unsafe-eval'` CSP, minimal perms (`storage`, `offscreen`), host perms scoped to 5 meeting origins, `options_page`, 4 commands with exact default keys (Alt+Shift+S/D/M/R), `minimum_chrome_version: 121` |
| Background service worker | ✅ | Stateless (all state re-read from storage — survives suspension), allowlist message router with foreign-sender rejection, per-tab session cache, badge sync, command routing, broadcast emergency restore, offscreen lifecycle (`extension/background.js`) |
| MAIN-world bridge | ✅ | `Proxy`-wrapped `RTCPeerConnection`, `WeakRef`+`FinalizationRegistry` PC registry, ref-counted canvas tracks, host `replaceTrack` patch keeps "original track" truthful (`extension/content/main-world-bridge.js`) |
| Content script | ✅ | Closed-shadow HUD (zero host-DOM mutation), cached self-view picker, SoA `Float32Array` particles (12 000 cap, zero per-frame allocs, counting-sorted buckets), clean-plate extrapolation, keep-alive while vanished, `visibilitychange` pause, full teardown (`extension/content/snap-vanish.js`) |
| Hand detection | ✅ (live-cam untested in sandbox) | Real MediaPipe `HandLandmarker` from bundled `extension/models/hand_landmarker.task` + WASM, GPU→CPU fallback, meters→mm / 82 mm palm normalization, cooldown, FPS cap, `requestVideoFrameCallback` |
| Audio confirmation | ✅ | Bandpass 2.8 kHz analyser gate, adaptive noise floor, mic opened only when confirmation is required; **sound can never trigger a vanish alone** (it only confirms a pending visual snap within ±220 ms) |
| Studio (React app / options page) | ✅ | Dashboard, SnapStage (live webcam + static fallback), Personalization Studio (preset CRUD), 7-step Calibration, 9-section Settings, 8-step Onboarding, Diagnostics, local-only metadata history |
| Dust engine (Studio) | ✅ | `src/lib/dust.ts` implements 7 effects (dust, cinematic, fine, pixel-dissolve, digital-glitch, fade, light-burst), pooled, reversible |
| Settings | ✅ | Schema v2, `validateSettings()` clamps/enums/hex, v1→v2 migration, JSON export/import, sync vs local separation |
| Privacy | ✅ | No `fetch`/WebSocket/beacon in the runtime pipeline; only network-capable code is the **env-gated, off-by-default** optional Supabase sync in `src/lib/cloudAndBilling.ts` (returns `BLOCKED` unless `VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY` are set at build time — the shipped extension build sets neither) |
| Tests | ✅ 30/31 | 3 suites: settings/presets/messaging/engine/gesture/audio/analytics, extension runtime (boots real content script in jsdom), DOM/responsive + build integrity |

## 2. Broken functionality found

| # | Bug | Severity | Fix in 2.1 |
| --- | --- | --- | --- |
| B1 | `npm run verify` fails on a fresh clone: the build-integrity test stats `snap-vanish-chrome-extension.zip` (git-ignored artifact) **before** `build:extension` runs in the verify chain | High (blocks CI/fresh setup) | Reorder `verify` → typecheck → build:extension → tests |
| B2 | Background `SETTINGS_CHANGED` spread the **unvalidated** message payload straight into `chrome.storage.sync` (any key/type/range accepted) — violates brief §9/§13 | High | New `sanitizeSettingsPatch()` allowlist + type/range/enum sanitization in the service worker |
| B3 | Content-script `applySettings()` likewise spread unvalidated payloads; an out-of-range or wrong-type value (e.g. `density: "x"`, `speed: 99`) would corrupt the render loop | High | New `sanitizeCfg()` in `snap-vanish.js` (clamps, enum allowlists, hex check, drops unknown keys) |
| B4 | `state.accentRgb` was only set inside `applySettings()`, which returns early on empty storage — a cinematic-effect vanish before first settings load dereferenced `accent.r` (frame silently dropped by try/catch) | Medium | Initialize `accentRgb` at state creation |
| B5 | Popup showed only 2 of 4 shortcuts and hard-coded them; no way to see **actually assigned** keys or conflicts (brief §7) | Medium | Popup now lists live bindings via `chrome.commands.getAll()` + "Customize" opens `chrome://extensions/shortcuts` |

## 3. Missing functionality found (vs brief)

| # | Missing | Brief § | Fix in 2.1 |
| --- | --- | --- | --- |
| M1 | Three detection modes (Smart / Gesture / Manual). 2.0 had sensitivity *profiles* (Beginner…Custom) but no trigger-mode concept; the mic could open even when the user only wanted gesture-only | §3 | New `gesture.detectionMode` (`smart` \| `gesture-only` \| `manual`) + pure `resolveDetectionPolicy()`; enforced in content script (Manual ⇒ detection loop never runs and mic is released; Gesture ⇒ mic never opened) and surfaced in Popup + Settings |
| M2 | Popup lacked live Camera / Microphone / Detection status, mode control, distinct Snap Now vs Return buttons, mic toggle, light theme | §2, §6 | Popup redesigned: 6-cell live status grid fed by real `GET_STATE` fields, mode segmented control, Snap Now (`SNAP_VANISH_NOW`) + Return (`SNAP_RESTORE_NOW`), mic toggle, dark/light theme persisted locally, version read from the manifest |
| M3 | Content script only varied particles by *direction* (+ cinematic heat tint) — the other 5 effects looked like Classic Dust **in real calls** (Studio preview was honest, the meeting path was not) | §4 | Per-effect velocity fields in `buildParticles()` + swirl/quantised-glitch terms in `emitParticles()`: Infinity spiral, radial Energy Burst, Smoke rise, Digital blocks, Pixel rain, Fine ash |
| M4 | Content script `GET_STATE` did not expose camera presence / audio-gate / detection-mode, so no surface could show truthful status without guessing | §2, §11 | `snapshotState()` now reports `cameraPresent`, `audioGateActive`, `detectionMode`, `detectionActive` |
| M5 | SEO/social metadata on the web build was minimal (title + description only) | §14 | Added `theme-color`, Open Graph + Twitter card tags to `index.html` |

## 4. Technical problems / risks noted (documented, not silently "fixed")

- **Zoom Web Client** often encodes video via custom WASM/WebCodecs, not `RTCRtpSender` — outgoing replacement is **Experimental**; local overlay works; OBS Virtual Camera is the documented guaranteed path. Unchanged from 2.0 and stated in UI/README.
- **Live Meet/Teams/Zoom calls, physical webcam and microphone cannot be tested in this sandbox** (no Chrome binary, no hardware, no accounts). All meeting-path code is exercised by a mocked-WebRTC harness and clearly labelled *Untested in live calls*.
- The optional cloud sync/billing module exists but is **compile-time opt-in** (env vars). The default build contains no configured endpoint; keep or delete is a product decision — documented in README.
- Single-webcam background reconstruction cannot see behind always-occluded furniture; clean-plate capture is the honest mitigation (already implemented).

## 5. Recommended improvements — implemented priorities

**P0 (correctness/security):** B1 verify ordering · B2 background sanitizer · B3 content-script sanitizer · B4 accent init
**P1 (brief features):** M1 detection modes end-to-end · M2 popup redesign · M3 in-call effect parity · M4 truthful state
**P2 (polish/docs):** M5 SEO meta · B5 live shortcut bindings · version 2.1.0 · README/FEATURE_STATUS/testing report refresh · new unit tests for detection-mode policy

Everything above was implemented and re-verified with `npm run verify` (typecheck → extension build → full test suite). See `docs/FEATURE_STATUS.md` for the honest per-feature classification.
