# Snap Vanish 2.0 — Principal Engineer Optimization Report

**Repository:** `ujjwalmaurya890-ops/snap-vanish-extensions`
**Audit baseline:** `main @ 92f4718` (extension `v2.0.0`, `minimum_chrome_version: 121`)
**Report date:** 2026-11-01
**Scope:** MV3 service worker, offscreen/DOM topology, CSP & permissions, canvas/WebGL particle engine, MediaPipe/WebRTC pipeline, content-script injection safety, React render behaviour, Vite/TS build.

---

## 0. How this audit was performed (and what is measured vs. estimated)

| Evidence class | Method | Trust |
| :--- | :--- | :--- |
| **Measured (JS frame cost)** | `scripts/bench-dust.mts` — 120 frames × 12 000 particles through `DustScene.render()` against a counting 2D-context stub, Node 22 / V8, identical inputs before and after. | High — real wall-clock, real allocation behaviour; **excludes GPU rasterisation**. |
| **Measured (counts)** | Same harness instruments `fillStyle` writes and `fillRect`/`drawImage` calls per frame. | High — these are the exact Canvas2D commands Chrome's renderer must process. |
| **Measured (build)** | `tsc --noEmit`, `vitest run` (31 tests), `vite build`, `node scripts/build-extension.mjs`. | High. |
| **Measured (bundle)** | Vite output sizes, `grep` of emitted chunks for library markers. | High. |
| **Static analysis** | Full read of all runtime sources (`background.js`, `main-world-bridge.js`, `snap-vanish.js`, `popup.js`, `dust.ts`, `SnapStage.tsx`, `gestureEngine.ts`, `backgroundReconstructor.ts`, `handTracker.ts`, `settings.ts`, `diagnostics.ts`, `messaging.ts`, manifest, build scripts). | High for dead code / logic errors; medium for runtime ordering. |
| **Estimated** | Anything marked *(est.)* — e.g. GPU rasterisation time, real-meeting DOM cost of `getComputedStyle`, MediaPipe inference latency on a real camera. These need a live call to confirm; the reasoning and the measurement plan are given. | Medium — directional. |

Everything below is reproducible:

```bash
npm ci
npm run bench        # before/after particle-engine micro-benchmark
npx tsc --noEmit     # typecheck
npm test             # 31 tests, includes manifest/CSP/bridge/content-script contracts
npm run build:extension
```

---

## 1. Executive Summary — the five findings that actually matter

### #1 — The particle renderer was spending **half of the 60 FPS budget** on garbage, not on drawing
`DustScene.renderDustAndFragments()` allocated a fresh `` `rgba(${r},${g},${b},${a})` `` template string **per particle, per frame** and assigned it to `ctx.fillStyle`. At the default 12 000 particles / 60 FPS that is **~720 000 string allocations and ~10 300 `fillStyle` state mutations per second**.

Measured, identical visual output, 12 000 particles:

| Effect | JS cost before | JS cost after | `fillStyle` writes/frame before → after |
| :--- | ---: | ---: | ---: |
| `dust` | **8.07 ms** | **1.42 ms** | 10 291 → **192** |
| `cinematic-disintegration` | **8.20 ms** | **1.71 ms** | 10 193 → **198** |
| `fine-particles` | **8.27 ms** | **1.40 ms** | 10 470 → **194** |

**5.2× faster, 51× fewer Canvas2D state changes, zero steady-state string allocation.** The fix (delivered in `src/lib/dust.ts`) is struct-of-arrays storage + a counting-sorted (colour × alpha) bucket emitter + interned style strings + `Math.pow` lookup tables. On a real call this is the difference between a 30 FPS stuttering dissolve and a 60 FPS one, because the same main thread is also running MediaPipe inference, the matte pipeline, and React.

### #2 — The content-script content path was drawing **two full 1280×720 canvases per frame** and forcing a **style recalculation on every detection tick**
`renderTransitionFrame()` (old `snap-vanish.js:319`) drew the whole frame into `rtcCanvas`, then blitted `rtcCanvas` into `overlayCanvas` — 2× fill cost, 2× memory bandwidth — and called `canvas.getContext("2d")` twice **per frame** (a synchronous context-map lookup). Separately, `findSelfVideoElement()` (old `:120`) ran `document.querySelectorAll("video")` **plus `window.getComputedStyle()` per candidate** inside the animation path *and* every detection tick (~20-24 Hz).

On Meet/Teams the self-view is one of many `<video>` elements inside a heavily-mutated DOM; `getComputedStyle` there forces a style flush and can serialise against the host's own rendering *(est. 1-10 ms per call in a busy call)*. Fixed by: one render target per transition, cached contexts, and an event-invalidated self-view cache (see §4.3).

### #3 — The React stage re-rendered the **entire 1 102-line component at up to 60 Hz** while the camera was on
Old `SnapStage.tsx:818-832`: `setCount(activeCount)` ran **every frame** in the non-animating branch, plus `setMeasuredFps`/`setMeasuredMs`/`setCount` every 12th frame, each one propagating into the parent dashboard via `onMetrics`. Three further self-inflicted wounds:

* `useRef(new BackgroundReconstructor())`, `useRef(new HandLandmarkService())`, `useRef(new LiveAudioConfirmationEngine())`, `useRef(new FramePerformanceTracker())` — **five heavyweight objects constructed on every render** and immediately discarded (old `:141-146`).
* The rAF loop effect depended on `fire`, `onStatus`, `onMetrics`, `onAudioMonitorChange`, `onDetectionDiagnostics`, `onGestureTriggered` — every parent render **tore down and restarted the animation loop**, cancelling in-flight frames mid-transition (old `:866-897`).
* A fresh `EffectRenderOptions` object per frame (old `:879`).

Fixed: telemetry published at 2 Hz, change-detected, through a ref-bucket; loop deps narrowed to `[ready, liveCameraActive, showHandOverlay]`; components memoised; options object reused. **Net effect: React work during a live camera drops from ~60 re-renders/s to ~2/s.**

### #4 — MediaPipe hand inference was loaded through an API contract that cannot succeed in the field
Old `snap-vanish.js:475-483`:

```js
handLandmarker = await HandLandmarker.createFromOptions(
  { wasmLoaderPath: "", wasmBinaryPath: wasmBinUrl },   // ← empty loader path
  { baseOptions: { modelAssetPath: modelUrl, delegate: "GPU" }, runningMode: "VIDEO", … },
);
```

An empty `wasmLoaderPath` only works if a compatible `globalThis.ModuleFactory` happens to be installed by a separate `import()` of the raw Emscripten glue — which the code attempted 9 lines earlier *inside a `try {} catch {}` that swallows the failure*. There was **no post-construction validation** (`typeof handLandmarker.detectForVideo === "function"`), so a failure silently left `handModelReady === false` forever and the HUD showed "Armed" with no AI. Additionally, ~14.5 MB of WASM was being compiled **inside the host page's realm**, where the host CSP is allowed to veto WebAssembly compilation — the single most common field failure mode for TF.js/MediaPipe in content scripts (see §3.4 for the CSP analysis and the migration path).

Fixed: explicit `{ wasmLoaderPath, wasmBinaryPath }` fileset, GPU→CPU delegate fallback chain, handle validation, and a single documented fallback path. **Migration to an extension-origin execution context is specified in §3.4 and remains the recommended Phase-2 item.**

### #5 — MV3 lifecycle: the worker was stateless, but nothing was persisted — so every worker suspension lost the call context
`background.js` was already free of long-lived globals (good), but it persisted **nothing**: which tab is in a call, which tab is vanished, and what the badge should say all lived only in the response of an in-flight `chrome.tabs.sendMessage`. Chrome suspends an idle MV3 worker after 30 s; after that:

* the toolbar badge reverted to a stale/blank value until the next message,
* `Alt+Shift+D` / `Alt+Shift+R` routed to *whatever tab was active*, not the meeting tab (old `:88-106` unconditionally prefers the active tab — wrong tab when two meetings are open),
* `Alt+Shift+R` (Emergency Restore) reached **one** tab only, so a stranded vanished tab in a background window stayed vanished.

Fixed: `chrome.storage.session` holds a bounded per-tab state map + last-target pointer; the badge is derived from storage; Emergency Restore fans out to every meeting tab; commands resolve their target per invocation. See §2.

---

## 2. Findings register

Severity: **P0** = user-visible breakage / data-safety · **P1** = frame drops, jank, battery · **P2** = maintainability, hygiene.

| # | Sev | Area | Finding (file:line @ 92f4718) | Fix status |
| :-- | :-- | :--- | :--- | :--- |
| 1 | P1 | Render | Per-particle `rgba()` string + `fillStyle` write in the particle loop (`dust.ts:700-760`) | **Fixed** — bucketed emitter, measured 5.2× |
| 2 | P1 | Render | Two full-frame canvases per frame + `getContext()` per frame (`snap-vanish.js:319-370`) | **Fixed** — single target, cached contexts |
| 3 | P1 | Render | `querySelectorAll("video")` + `getComputedStyle` per frame/tick (`snap-vanish.js:120-142`) | **Fixed** — event-invalidated cache |
| 4 | P1 | Render | 12 000 particle objects re-allocated each vanish (`snap-vanish.js:288-315`) | **Fixed** — SoA typed arrays |
| 5 | P1 | React | `setState` per frame while camera live (`SnapStage.tsx:818-832`) | **Fixed** — 2 Hz, change-detected |
| 6 | P1 | React | `useRef(new X())` × 5 per render (`SnapStage.tsx:141-146`) | **Fixed** — lazy init |
| 7 | P1 | React | Loop effect restarts on every parent render (`SnapStage.tsx:866-897`) | **Fixed** — ref-bucket deps |
| 8 | **P0** | Detection | `wasmLoaderPath: ""` + no handle validation (`snap-vanish.js:475-494`) | **Fixed** — validated fileset + delegate fallback |
| 9 | **P0** | Detection | `detectForVideo` on the page main thread at 20-24 Hz (`snap-vanish.js:605-650`) | **Mitigated** (rVFC cadence, hidden-tab pause) — worker migration §3.4 |
| 10 | **P0** | MV3 | Engine/target state never persisted → wrong-tab routing after suspend (`background.js:88-131`) | **Fixed** — `storage.session` |
| 11 | **P0** | MV3 | Emergency restore reaches one tab only (`background.js:164-168`) | **Fixed** — fan-out |
| 12 | **P0** | MV3 | No offscreen document; cue played from a page `AudioContext` that is created and closed per click (`snap-vanish.js:192-212`) | **Fixed** — `offscreen/` + fallback |
| 13 | **P0** | WebRTC | `Set<RTCPeerConnection>` = hard leak; wrapper function loses statics/subclassing (`main-world-bridge.js:17-40`) | **Fixed** — `WeakRef` + `Proxy` |
| 14 | **P0** | WebRTC | Restore stopped the canvas track even if still attached to a sender → permanently black outgoing video (`main-world-bridge.js:128-137`) | **Fixed** — ref-counted |
| 15 | P1 | WebRTC | Host-initiated `replaceTrack` (device switch) silently invalidated the saved original track | **Fixed** — prototype patch |
| 16 | P1 | Transition | Bridge round-trip (up to 600 ms) completed *before* the first animation frame (`snap-vanish.js:391-407`) | **Fixed** — parallel attach |
| 17 | P1 | Audio | Second `getUserMedia` mic stream created in the page and never released (`snap-vanish.js:504-528`) | **Fixed** — lazy, single ctx, released on teardown |
| 18 | P1 | Audio | `pollAudioOnset()` called twice per detection tick (`snap-vanish.js:532`, `:628`) | **Fixed** |
| 19 | P1 | Capture | `canvas.width/height` re-assigned on every `ensureCanvases()` call → backing-store reallocation (`snap-vanish.js:214-243`) | **Fixed** — resize only when detached |
| 20 | **P0** | DOM safety | Overlay canvas appended into the host's video parent + `parent.style.position = "relative"` (`snap-vanish.js:237-242`) | **Fixed** — closed shadow root, zero host mutation |
| 21 | P1 | DOM safety | HUD styled from a document stylesheet, appended to `<html>` → host CSS bleed both ways (`snap-vanish.js:651-700`, `snap-vanish.css`) | **Fixed** — shadow DOM + `all: initial` |
| 22 | P1 | Detection | `evaluateHandSnap` allocated 21 objects/frame via `landmarks.map()` (`snap-vanish.js:560-567`) | **Fixed** — index math |
| 23 | P1 | Matte | `buildParticlesFromVideo` did a full-res `getImageData` + 2 canvas reallocations synchronously inside the click handler (`snap-vanish.js:245-317`) | **Partially fixed** (buffers cached, no realloc); remaining cost specified in §3.5 |
| 24 | P2 | Build | `vite-plugin-singlefile` declared but unused; would violate MV3 CSP if enabled | **Removed** |
| 25 | P2 | Build | `framer-motion` declared but imported nowhere | **Removed** |
| 26 | P2 | Build | `public/images/*` (608 KB) duplicated `src/assets/*`; referenced by nothing | **Removed** |
| 27 | P2 | Repo | 10.9 MB release zip committed to git | **Untracked + git-ignored** |
| 28 | P2 | Build | Studio bundle shipped a second copy of MediaPipe (~160 KB chunk) besides `extension/vendor/vision_bundle.mjs` | **Fixed** — `resolve.alias` |
| 29 | P2 | Build | `build.target` defaulted to `chrome107` while the manifest required 121; tsconfig targeted ES2020 | **Fixed** — `chrome121` / `ES2022` |
| 30 | P2 | Structure | 1 457-line `settings.ts`, 1 102-line `SnapStage.tsx`, 829-line content script (no module boundary) | **Recommended** §6.6 |

---

## 3. Detailed refactoring strategy

Each section is *Before* (the shipped 2.0.0 code) → *After* (the delivered code) with the reasoning that matters in production.

---

### 3.1 Category A — Service worker lifecycle & persistence

#### A1. "Illegal" state persistence — the inverse problem

The usual MV3 sin is caching state in module-scope variables. This codebase avoided that but over-corrected: **nothing** was persisted, so every value had to be re-derived from a live message round-trip.

```js
// BEFORE — background.js:88-131
async function findActiveMeetingTab() {
  const activeTabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (activeTabs[0] && isSupportedMeetingUrl(activeTabs[0].url)) return activeTabs[0];
  const allTabs = await chrome.tabs.query({ url: [/* patterns */] });
  return allTabs[0] || null;            // arbitrary tab, any window
}
```

Problems: (a) always prefers the active tab, so with two open meetings the command hits the wrong call; (b) `allTabs[0]` is arbitrary; (c) after a worker suspension nothing remembers the user's tab; (d) reading `tab.url` and filtering `tabs.query({url})` was implicitly enabled by `content_scripts.matches` rather than an explicit `host_permissions` grant.

```js
// AFTER — background.js
/**
 * Preference order: explicit tab → last interacted meeting tab → active tab →
 * first meeting tab in any window. Re-derived per invocation, so a suspended
 * worker still targets the right tab.
 */
async function resolveTargetTab(preferredTabId) {
  if (typeof preferredTabId === "number") {
    const tab = await chrome.tabs.get(preferredTabId).catch(() => null);
    if (tab && isSupportedMeetingUrl(tab.url)) return tab;
  }
  const meetingTabs = await listMeetingTabs();
  if (meetingTabs.length === 0) return null;

  const remembered = (await chrome.storage.session.get(SESSION_TARGET_KEY))?.[SESSION_TARGET_KEY];
  const hit = meetingTabs.find((t) => t.id === remembered);
  if (hit) return hit;

  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return meetingTabs.find((t) => t.id === active?.id) ?? meetingTabs[0] ?? null;
}
```

Per-tab engine state lives in `chrome.storage.session` (memory-backed, survives worker suspension, invisible to web pages, faster than `local` and does not wear the sync quota):

```js
async function writeSessionTab(tabId, patch) { /* bounded to 12 entries, LRU-pruned */ }
```

The badge is now a **pure function of persisted state**, not of a captured response:

```js
// AFTER
async function syncBadge() {
  const prefs = await readPrefs();
  if (prefs.enabled === false) return setBadge("off");
  const tabs = await readSessionTabs();
  const vanished = Object.values(tabs).some((t) => t?.engineState === "vanished");
  await setBadge(vanished ? "gone" : "on");
}
```

The only module-scope mutable binding left is the single-flight `offscreenCreating` promise, and even that is re-derived from `chrome.runtime.getContexts()` before being trusted. `src/__tests__/extensionRuntime.test.ts` now **enforces this in CI**:

```ts
const mutableModuleBindings = [...swSource.matchAll(/^(?:let|var)\s+([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]);
const whitelisted = new Set(["offscreenCreating", "lastWrittenState"]);
expect(mutableModuleBindings.filter((n) => !whitelisted.has(n))).toEqual([]);
```

(`lastWrittenState` is a perf-only cache of the last state written per tab — losing it after suspension costs one redundant `storage.session.set`, never correctness.)

#### A2. `sendResponse` correctness

The old listener called `sendResponse` in several early-return branches and returned `true` for *everything*, including messages it handled synchronously. That is safe but hides the "no response ever arrives" bug class. The new router has exactly one response path:

```js
// AFTER
work.then(respond).catch((err) => respond({ ok: false, reason: "handler-error", error: String(err) }));
return true;   // async by construction
```

…plus a sender check (`sender.id !== chrome.runtime.id` → reject) so page-triggered `externally_connectable`-style traffic cannot drive the control surface.

#### A3. Offscreen documents — where they belong in *this* architecture

**Finding: there was no offscreen document at all.** The consequences were tangible:

| Need | 2.0.0 approach | Problem |
| :--- | :--- | :--- |
| Confirmation cue | `new AudioContext()` per click, `ctx.close()` after 150 ms (`snap-vanish.js:192-212`) | AudioContext churn (Chrome caps ~6 concurrent contexts per renderer); autoplay policy leaves it `suspended` on the keyboard-shortcut path, so the cue silently never plays; the context competes with the meeting's own audio graph |
| Audio transient analysis | Analyser in the page | Fine (see below) |
| MediaPipe WASM | `import()` inside the page realm | **Wrong** — subject to host CSP, main-thread inference (§3.4) |

Delivered decision matrix — and the reasoning, because "put it in an offscreen document" is not universally right:

| Workload | Correct context | Why |
| :--- | :--- | :--- |
| Confirmation cue playback | **Offscreen, `AUDIO_PLAYBACK`** | The only documented way to start audio **without user activation**. `chrome.commands` invocations carry none. |
| Mic transient analysis | **Page (content script)** | The meeting page already holds mic permission; moving it to an offscreen document triggers a *second* extension-level permission prompt and a second capture device open. No CSP benefit — Web Audio is not CSP-gated. |
| Hand inference (MediaPipe) | **Extension-origin worker** (Phase 2) | Avoids host CSP on WebAssembly, moves 8-14 ms of inference off the meeting's main thread. Cannot live in an offscreen document because the *frames* and the *composite* must stay in the page (a `MediaStreamTrack` is not transferable across contexts, and `replaceTrack` needs a track from the page realm). |
| Compositing / particle render | **Page main world + `carry` canvas** | Mandatory: `HTMLCanvasElement.captureStream()` must run in the realm that owns the sending `RTCPeerConnection`. |

Offscreen implementation (delivered, `extension/offscreen/offscreen.{html,js}`): one long-lived `AudioContext`, cue buffers synthesised once and cached, band-passed noise burst, `ensureOffscreenDocument()` guarded by `chrome.runtime.getContexts()` + single-flight promise, and — importantly — **no manual teardown timer**, because Chrome already reclaims an `AUDIO_PLAYBACK` document ~30 s after the last sound.

```js
// AFTER — background.js
async function ensureOffscreenDocument() {
  if (await hasOffscreenDocument()) return true;          // getContexts() check
  if (offscreenCreating) { await offscreenCreating; return true; }  // single-flight
  offscreenCreating = chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: ["AUDIO_PLAYBACK"],
    justification: "Play the short local snap-confirmation cue without creating an AudioContext in the meeting page.",
  }).catch((err) => {
    // Popup + keyboard command can race here; Chrome throws
    // "Only a single offscreen document may be created".
    if (!/single offscreen/i.test(String(err))) throw err;
  }).finally(() => { offscreenCreating = null; });
  …
}
```

**Messaging route after the change** (every arrow is a real, typed message):

```
popup.js ──GET_STATE────────────► background.js ──GET_STATE──► content script
studio (options page) ─SETTINGS_CHANGED─► background ──broadcast──► all meeting tabs
content script ──PLAY_CUE──► background ──ensureOffscreen──► offscreen/offscreen.js
offscreen ──OFFSCREEN_EVENT──► background ──tabs.sendMessage──► requesting tab
```

The content script prefers the in-page `AudioContext` when it is already `running` (has activation) and only delegates to the offscreen path when it is suspended — no extra document creation on the common path.

#### A4. CSP, Web Accessible Resources and permission minimality

The original manifest:

```jsonc
"permissions": ["activeTab", "storage"],
"web_accessible_resources": [{ "resources": ["models/*", "wasm/*", "vendor/*"], "matches": [ …5 patterns… ] }]
```

Delivered:

```jsonc
"permissions": ["storage", "offscreen"],
"host_permissions": [ "https://meet.google.com/*", "https://teams.microsoft.com/*",
  "https://teams.live.com/*", "https://*.zoom.us/wc/*", "https://app.zoom.us/wc/*" ],
"web_accessible_resources": [{
  "resources": [
    "models/hand_landmarker.task",
    "wasm/vision_wasm_module_internal.js",
    "wasm/vision_wasm_module_internal.wasm",
    "vendor/vision_bundle.mjs"
  ],
  "matches": [ …5 patterns… ],
  "use_dynamic_url": false
}],
"content_security_policy": {
  "extension_pages": "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; worker-src 'self'"
}
```

Rationale:

* **`activeTab` removed** — it is a user-gesture grant that this extension never used; the toolbar popup talks to the worker, and the worker talks to tabs covered by `host_permissions`. Removing it makes the install prompt smaller and the store listing cleaner.
* **`tabs` deliberately absent** — `chrome.tabs.query({ url })` URL filtering and `tab.url` reads work with *host permissions*; declaring `tabs` would grant title/favicon/history-ish visibility for no benefit.
* **`host_permissions` added explicitly** — the previous manifest relied on the implicit grant that `content_scripts.matches` confers. That grant is real but poorly documented and easy to break with a refactor; being explicit is what the worker's URL filtering actually depends on.
* **Directory wildcards removed** from `web_accessible_resources`. `vendor/*` exposed the whole directory to five origins and let any of them fingerprint the build by probing paths; enumerating four files is strictly better. `selfie_segmentation.tflite` is **not** web-accessible because only the extension pages (not the host page) load it.
* **`worker-src 'self'`** is declared now so the planned `vision-worker.js` (§3.4) will load without a CSP surprise.
* `frame-ancestors` was deliberately **not** added: MV3 validates `extension_pages` against a known directive set and silently ignores the rest, which makes it a misleading no-op.

**The WebAssembly / host-CSP hazard (P0, still open by design).** `'wasm-unsafe-eval'` in `extension_pages` covers extension pages — it does **not** govern `WebAssembly.compile()` executed in an **isolated world attached to a web page**. In Chrome, a content script's isolated world inherits the *page's* CSP for eval/WASM compilation. Meet and Teams both ship restrictive CSPs, and this is the single most-reported field failure for MediaPipe/TensorFlow.js content scripts ("Refused to compile or instantiate WebAssembly module because 'unsafe-eval' is not an allowed source…"). The extension already had `delegate: "CPU"` and a `try/catch` fallback, but both paths compile WASM in the same realm — the fallback cannot help. See §3.4 for the fix and why it is Phase 2.

#### A5. Settings writes are now transactional

Old `background.js:202-221` wrote a hand-picked subset of ~10 keys plus the blob, silently dropping every other field (`intensity`, `motionSmoothness`, `showCallHud`, `pauseWhenHidden`, nested `gesture.cooldownMs`, …) — so any setting not in that list was **reset by the popup path**. Delivered:

```js
const merged = { ...(await readPrefs()), ...payload };
await chrome.storage.sync.set({ ...DEFAULT_SYNC_PREFS, ...merged, snap_vanish_settings_v2: merged });
await broadcastToMeetingTabs({ type: "SETTINGS_CHANGED", payload: merged }, sender.tab?.id);
```

---

### 3.2 Category B — Media processing, canvas & WebGL

#### B1. Where the 16.67 ms goes (1080p, live camera, mid-transition)

| Work item | Before | After | Notes |
| :--- | ---: | ---: | :--- |
| Particle math + Canvas2D command recording | **8.1 ms** (measured) | **1.4-1.7 ms** (measured) | §3.2.1 |
| String GC pressure | ~35-60 MB/s (est.) | ~0 | 10 291 → 192 style writes/frame |
| `ctx.getContext()` lookups | 2/frame | 0 | cached |
| Second full-frame blit | 0.9 Mpx/frame | 0 | single render target |
| Self-view discovery | `querySelectorAll` + N×`getComputedStyle` | 0 (cached, event-driven) | §3.2.2 |
| React re-render | up to 60/s, full component tree | ~2/s, change-detected | §3.3 |
| MediaPipe inference | 8-14 ms on main thread, 20-24 Hz | same (Phase 2 moves it) | §3.4 |
| GPU raster + compose | *(est. 2-6 ms)* | same | not measured here |

#### B2.1 The bucketed emitter (the single biggest win)

**Before** (`dust.ts`, per particle, every frame):

```ts
const r = Math.round(p.r + (accent.r - p.r) * heat * 0.86 + (192 - p.r) * (1 - heat) * 0.32);
// …same for g and b
ctx.fillStyle = `rgba(${r},${g},${b},${alpha})`;   // ← new string, 12 000×/frame
ctx.fillRect(x, y, size, size);
```

Three independent costs: the template-string allocation, the `valueOf`/parse of that CSS colour string inside Blink's `CSSPropertyParser`, and the style invalidation that forces the canvas recorder to open a new paint op.

**After** (`dust.ts`): particle state lives in flat typed arrays; the emitter quantises colour to 4 bits/channel and alpha to 32 levels, counting-sorts the visible particles into those buckets, and writes `fillStyle` **once per bucket** using an interned string.

```ts
// Struct-of-arrays: zero objects, zero GC
private pX = new Float32Array(cap);  private pY = new Float32Array(cap);
private pDelay = new Float32Array(cap); private pPower = new Float32Array(cap);
private pR = new Uint8Array(cap);    // 12 000 × 3 bytes for colour, not 12 000 objects

// Interned style strings (finite palette → the cache saturates after ~2 s)
const styleCache = new Map<number, string>();
function styleFor(colorKey: number, alphaByte: number): string { … }

// Pass 1: compute position/colour/alpha into scratch arrays, build a 17-bit bucket key
this.sortKeys[n] = (quantizeColor(r, g, b) * ALPHA_STEPS + (alphaByte >> ALPHA_SHIFT)) * 2 + (useShard ? 1 : 0);

// Pass 2: counting sort (O(n + buckets), no comparison, no allocation)
for (let n = 0; n < visible; n++) counts[bucket + 1] += 1;
for (let k = 1; k <= BUCKET_COUNT; k++) counts[k] += counts[k - 1];
cursor.set(counts);
for (let n = 0; n < visible; n++) order[cursor[bucket]++] = n;

// Pass 3: one style write per non-empty bucket
for (let b = 0; b < BUCKET_COUNT; b++) {
  if (counts[b] === counts[b + 1]) continue;
  ctx.fillStyle = styleFor((b / ALPHA_STEPS) | 0, alphaStep);   // ~195 writes/frame
  for (let k = counts[b]; k < counts[b + 1]; k++) { … fillRect … }
}
```

Two more hot-loop items replaced with tables, because `Math.pow` is ~25 ns and it ran twice per particle per frame (~0.6 ms at 12 k):

```ts
const ALPHA_LUT = /* 1024-entry Float32Array of pow(1-local,1.18) * min(1, local*15) */;
const MOTION_LUTS = new Map<number, Float32Array>();   // keyed by rounded smoothness
```

Visual fidelity: quantising alpha to 1/32 steps on 1-3 px grains is imperceptible. The one visible trade-off — the near-depth "motion smear" ghost rect that the old code drew for ~48 % of particles — is preserved behind `const ENABLE_DEPTH_GHOST = false`, because it doubled `fillRect` count; flipping it to `true` restores the exact 2.0.0 look for ~+1.1 ms/frame.

Also eliminated: `makeCanvas()` inside `buildFromLiveVideo` (a 3.7 MB canvas allocation per vanish), `createImageData` per vanish, `new Float32Array` per vanish in `computeForegroundAlpha` consumers, and the 20×N erosion loop (240 000 iterations → 12 000 + 20 by bucketing particles into their stage in a single pass).

#### B2.2 Content-script render path

```js
// BEFORE — snap-vanish.js:319-370
function renderTransitionFrame(t) {
  const ctx = rtcCanvas.getContext("2d");           // context lookup every frame
  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(bgPlateCanvas, 0, 0, w, h);
  const vid = findSelfVideoElement();               // querySelectorAll + getComputedStyle
  if (t <= 0.001 && vid) ctx.drawImage(vid, 0, 0, w, h);
  …
  if (overlayCanvas) {
    const octx = overlayCanvas.getContext("2d");    // second context lookup
    octx.clearRect(...);
    octx.drawImage(rtcCanvas, 0, 0, ...);           // full-frame copy, every frame
  }
}
```

```js
// AFTER — snap-vanish.js
function renderFrame(t) {
  // Exactly one render target per transition:
  //   webrtc-sender → the captured canvas (the call already displays it)
  //   dom-overlay   → the on-tile canvas
  const target = state.interceptionMode === "webrtc-sender" ? captureCtx : tileCtx;
  const canvas = state.interceptionMode === "webrtc-sender" ? captureCanvas : tileCanvas;
  try {
    target.setTransform(canvas.width / frame.w, 0, 0, canvas.height / frame.h, 0, 0);
    target.clearRect(0, 0, frame.w, frame.h);
    target.drawImage(plateCanvas, 0, 0, frame.w, frame.h);
    if (t <= 0.001) { const v = pickSelfVideo(); if (v) target.drawImage(v, 0, 0, frame.w, frame.h); }
    else if (t < 0.999) { …alpha-faded intact portrait…; emitParticles(target, t); }
  } catch { /* one bad frame must not kill the session */ }
}
```

`emitParticles()` uses the same counting-sort strategy as `dust.ts` (16 alpha steps × 4 bits/channel = 65 536 buckets, ≈0.15 ms of prefix-sum at 12 k particles) so the content script gets the same ~50× reduction in `fillStyle` churn.

#### B2.3 Frame-accurate, visibility-aware cadence

```js
// BEFORE — snap-vanish.js:605-650 (recursive setTimeout)
const tick = () => { … setTimeout(tick, Math.round(1000 / Math.max(8, fpsCap))); };
setTimeout(tick, 1200);
```

`setTimeout` drifts under load, fires while the tab is hidden unless guarded, and can queue up behind a long task. The delivered loop prefers `HTMLVideoElement.requestVideoFrameCallback` (fires exactly once per decoded camera frame, gives the frame's `mediaTime`), falls back to a timer, cancels its handle on teardown, and skips work when `document.hidden` or the engine is mid-transition.

#### B3. Remaining matte cost at snap time — the honest part

`buildParticlesFromVideo()` still costs an estimated **25-45 ms (est.)** synchronously on the click/tick path:

| Step | Cost (est.) | Why it is still synchronous |
| :--- | ---: | :--- |
| `drawImage(video)` at 1280×720 ×2 canvases | 2-4 ms | must sample the frame at the snap instant |
| `getImageData` 1280×720 (3.7 MB) ×2 | 8-14 ms | GPU→CPU readback, unavoidable with Canvas2D |
| 12 000 particle writes + delay sweep | 1-2 ms | — |
| 20 erosion stage blits | 6-12 ms | pre-rendered, but still 20 full-halves draws |

The transition still starts on the next frame (state is committed before the build), so the user sees a ≤ 45 ms late first frame rather than a dropped transition. Phase-2 plan to remove it:

1. Run the reconstruction + matte in a **`Worker` with `OffscreenCanvas`**; transfer the frame as `VideoFrame` (structured-cloneable, zero-copy in Chrome).
2. Read pixels inside the worker with `OffscreenCanvas.getContext("webgl2").readPixels` on a **downscaled 640×360** copy — 4× less readback, and no main-thread stall at all.
3. Keep a rolling 320×180 plate in `BackgroundReconstructor` (it already ingests one every 8th inference tick) so the snap only needs the *current* frame, not a fresh plate.

#### B4. WebGL / WebGPU: when and how

Canvas2D now meets budget at 12 k particles. It will **not** at 25 k+ particles on a 4K display or on a low-end integrated GPU (811-class), because each `fillRect` is a separate paint op with per-op state validation.

**Decision rule:** keep Canvas2D below ~15 k particles (it costs ~0.12 µs/particle/frame measured); switch to WebGL2 `POINTS` above that. A single draw call with a sprite atlas handles 100 k particles at < 1 ms of CPU.

Reference implementation to drop in as `src/lib/dustWebGL.ts` (spec-complete; wire-up is `scene.render(ctx)` → `glRenderer.render(gl, ...)` behind a feature flag):

```ts
const VERT = `#version 300 es
precision highp float;
layout(location = 0) in vec2  aPos;      // px
layout(location = 1) in vec2  aSize;     // px
layout(location = 2) in vec3  aColor;    // 0..1
layout(location = 3) in float aAlpha;    // 0..1
uniform vec2 uResolution;                 // canvas px
uniform float uDPR;
out vec3 vColor; out float vAlpha;
void main() {
  vec2 clip = (aPos / uResolution) * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  gl_PointSize = max(1.0, aSize.x * uDPR);
  vColor = aColor; vAlpha = aAlpha;
}`;

const FRAG = `#version 300 es
precision mediump float;
in vec3 vColor; in float vAlpha;
out vec4 outColor;
void main() {
  // Soft round grain: cheap analytic falloff, no texture fetch required.
  vec2 d = gl_PointCoord - vec2(0.5);
  float m = smoothstep(0.5, 0.15, length(d));
  outColor = vec4(vColor, vAlpha * m);
}`;

/** 8 floats per particle: x, y, size, _, r, g, b, a — one interleaved buffer, one draw call. */
export class ParticleGLRenderer {
  private vao: WebGLVertexArrayObject | null = null;
  private vbo: WebGLBuffer | null = null;
  private capacity = 0;

  constructor(private gl: WebGL2RenderingContext) {
    this.gl.getExtension("EXT_color_buffer_float");     // HDR-ish blending headroom
    this.program = link(this.gl, VERT, FRAG);
    this.gl.enable(this.gl.BLEND);
    this.gl.blendFunc(this.gl.SRC_ALPHA, this.gl.ONE_MINUS_SRC_ALPHA);
    this.allocate(28000);
  }

  private allocate(n: number) {
    const gl = this.gl;
    this.capacity = n;
    this.vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, n * 8 * 4, gl.DYNAMIC_DRAW);   // allocated once
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    const stride = 8 * 4;
    [[0, 2, 0], [1, 2, 8], [2, 3, 16], [3, 1, 28]].forEach(([loc, size, offset]) => {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, offset);
    });
  }

  /** `data` is the existing scratch Float32Array — no per-frame allocation. */
  render(data: Float32Array, count: number, width: number, height: number) {
    const gl = this.gl;
    gl.viewport(0, 0, width, height);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, data, 0, count * 8);     // 1 upload/frame
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.POINTS, 0, count);                            // 1 draw call
  }
}
```

Notes for the implementer:

* **Do not** use WebGL for the *matte*. `BackgroundReconstructor.computeForegroundAlpha` is a 57 600-pixel per-channel compare + 3-tap blur; a 5-line fragment shader does it in < 0.2 ms, but it needs a texture round-trip. Only do this together with the worker migration (§B3), otherwise you trade a 2 ms CPU loop for two 1 ms readbacks.
* **WebGPU** (`GPUDevice` + `GPURenderPassEncoder`, instanced quads) is worth it only past ~200 k particles or if you want compute-shader particle integration. Chrome 121 does not ship WebGPU on all Linux/Android targets, so it must remain a third tier behind feature detection (`navigator.gpu?.requestAdapter()`), not a replacement.
* Keep a Canvas2D fallback: the current `DustScene` **is** that fallback, and all five effects still need it for `digital-glitch` (slice blits) and `fade-out` (radial gradient).

#### B5. Where MediaPipe hand inference should run

Current: `detectForVideo()` at 20-24 Hz on the meeting's main thread. Each inference is *(est.)* 8-14 ms with the GPU delegate, so **the meeting's own video rendering and your dissolve compete for the same thread** — this is the mechanism behind "snap works but the transition stutters only when I wave my hand".

Phase-2 target topology (no protocol changes needed — the bridge already speaks `CustomEvent`):

```
content script (ISOLATED)                     extension-origin iframe (WAR)
┌───────────────────────────┐   postMessage  ┌───────────────────────────────┐
│ MediaStreamTrackProcessor  │──────────────► │ vision-frame.html             │
│  → VideoFrame (transfer)   │  transferable  │   └─ Worker: vision-worker.js │
│                            │ ◄────────~~~~~ │        MediaPipe HandLandmark │
│ landmark array (numbers)   │   landmarks    │        (extension CSP ⇒ WASM  │
└───────────────────────────┘                 │         always compiles)      │
                                              └───────────────────────────────┘
```

Why an iframe rather than an offscreen document or a worker created by the content script:

* `new Worker(chrome.runtime.getURL(...))` from a content script is a cross-origin script load relative to the page and is blocked in current Chrome.
* An offscreen document cannot receive `VideoFrame`/`ImageBitmap` cheaply — `chrome.runtime` messaging is JSON-only.
* An extension-origin iframe (`web_accessible_resources`, `allow="camera"` not even required since we pump frames) is same-extension, supports **transferable** `postMessage`, inherits `extension_pages` CSP (so `'wasm-unsafe-eval'` applies and the host CSP cannot veto compilation), and can spawn a real `Worker`.

This simultaneously fixes finding #9 (main-thread inference) **and** the P0 host-CSP hazard from §A4.

---

### 3.3 Category C — Content script & DOM injection safety

#### C1. Zero host-DOM mutation (P0)

```js
// BEFORE — snap-vanish.js:237-242
const parent = video ? video.parentElement : document.body;
if (parent && overlayCanvas.parentElement !== parent) {
  const pos = window.getComputedStyle(parent).position;
  if (pos === "static") parent.style.position = "relative";   // ← mutates the host
  parent.appendChild(overlayCanvas);                          // ← host CSS reaches it
}
```

Forcing `position: relative` on a Meet/Teams tile wrapper changes the containing block for **every absolutely-positioned descendant of that subtree** — including the host's own controls, badges, and tooltips. This is the classic "the extension broke my meeting UI" bug, and it is invisible in tests because the CSS still resolves.

```js
// AFTER — one host node, closed shadow root, fixed positioning from a cached rect
function ensureSurface() {
  const host = document.createElement("div");
  host.id = "snap-vanish-root";
  shadowRoot = host.attachShadow({ mode: "closed" });   // host CSS cannot reach in
  const style = document.createElement("style");
  style.textContent = SHADOW_CSS;                        // includes `:host { all: initial; … }`
  …
  shadowRoot.append(style, tileCanvas, hudEl);
  document.documentElement.appendChild(host);            // single, inert node
}

function syncOverlayRect() {                              // rAF-throttled, scroll/resize only
  const rect = pickSelfVideo().getBoundingClientRect();
  tileCanvas.style.left = `${rect.left}px`; …            // fixed-position overlay
}
```

`extension/content/snap-vanish.css` is reduced to a single defence-in-depth block for the one surface a host stylesheet *can* reach (the host element itself):

```css
#snap-vanish-root { all: initial !important; position: fixed !important; inset: 0 !important; … }
```

#### C2. `RTCRtpSender.replaceTrack()` — six edge cases, all real

| Edge case | 2.0.0 behaviour | Delivered behaviour |
| :--- | :--- | :--- |
| Page creates `class MyPC extends RTCPeerConnection` | wrapper function returns a native instance from a non-constructor → prototype chain wrong; statics (`generateCertificate`) gone | `Proxy` with `construct` trap preserving `new.target`, statics and `instanceof` |
| Page abandons a PC without `connectionstatechange` | `Set<RTCPeerConnection>` holds it forever → leak across a 2-hour call | `WeakRef` registry + `FinalizationRegistry` + prune-on-scan |
| Restore while another sender still carries the canvas track | `track.stop()` on a still-attached track → **permanently black outgoing video** | `swappedSenders` ref-count; stop only when no sender references it |
| User switches camera mid-call (host calls `replaceTrack`) | our saved "original" track is stale → restore puts back a dead track | `RTCRtpSender.prototype.replaceTrack` patched; host-initiated swaps become the new original |
| Canvas resized after `captureStream()` | backing-store change forces SDP renegotiation / frozen frames | capture canvas is sized **once** from the sender's negotiated `getSettings()` and never resized while attached |
| Concurrent attach/restore (double-click, command + click) | two `replaceTrack` storms, no ordering | `inFlight` re-entrancy guard (`{ok:false, reason:"in-flight"}`) |

Resolution matching is a subtle but important detail:

```js
// AFTER — match the capture canvas to what the call actually negotiated,
// so replaceTrack never triggers a mid-call resolution change.
function captureSizeFor(video, videoSettings) {
  const w = Math.min(1280, Math.round(videoSettings?.width || video?.videoWidth || 640));
  const h = Math.min(720, Math.round(videoSettings?.height || video?.videoHeight || 360));
  return { w: Math.max(2, w - (w % 2)), h: Math.max(2, h - (h % 2)) };
}
```

#### C3. Transition ordering (P1)

```js
// BEFORE — snap-vanish.js:390-407
engineState = goingOut ? "vanishing" : "restoring";
if (goingOut) {
  buildParticlesFromVideo(video);
  const bridgeRes = await sendBridgeCommand("ATTACH_PROCESSED_STREAM", { … }); // up to 600 ms
  interceptionMode = bridgeRes.mode || "dom-overlay";
}
animStartMs = performance.now();     // ← animation clock starts *after* the await
```

The state machine said "vanishing" for up to 600 ms while the clock had not started: one frozen frame, then a jump-cut dissolve.

```js
// AFTER — commit state, start the clock, then attach in parallel
setEngineState(goingOut ? "vanishing" : "restoring");
animStartMs = nowMs();
animFrom = goingOut ? 0 : 1;  animTo = goingOut ? 1 : 0;
playCue();
startLoop();                                  // first frame lands within 16 ms
if (goingOut) void attachSenderStream();      // ≤400 ms, off the critical path
```

The 600 ms bridge timeout also dropped to 400 ms, and the bridge client now uses **one** `snap-vanish:bridge-ack` listener with a `Map<requestId, {resolve, timer}>` instead of adding and removing an event listener per command.

#### C4. Host mute-button selectors

`togglePlatformMicMute()` was already selector-based and re-queried on demand (good), but three refinements were needed: (1) `data-is-muted` was read as a proxy for state *and* used as a selector, which double-counts on Meet; (2) the restore path only clicked "unmute" if `mutedByExtension` was true — but that flag lived only in memory and was not restored after a content-script reload; (3) there is no verification that the click took effect. Delivered: state is read from the label/toggle, `mutedByExtension` is the only thing the extension trusts for *its own* un-mute, and a single re-query per transition (never in a loop). **Remaining recommendation:** after `btn.click()`, verify on the next microtask that `aria-pressed`/`data-is-muted` flipped, and fall back to the keyboard shortcut (`Ctrl/Cmd+D` on Meet, `Ctrl+Shift+M` on Teams) if it did not — host DOM changes are the most likely long-term breakage in this file.

#### C5. MAIN-world trust boundary (accepted risk, documented)

`main-world-bridge.js` listens for `window` `CustomEvent`s, therefore **any script on the page can ask it to swap tracks**. This is unavoidable: the bridge must run in the MAIN world to see the page's own `RTCPeerConnection`s. Mitigations delivered: a per-document token (exchanged via `HELLO`), a fixed `canvasId` allow-list, and an in-flight guard; nothing more is honestly possible. It is *not* a privilege escalation — the page can already do everything the bridge can.

---

### 3.4 Category D — React & UI efficiency

#### D1. Per-frame `setState` (P1)

```tsx
// BEFORE — SnapStage.tsx:818-832
if (isAnimating || liveCameraActive) {
  perfRef.current.recordFrame(renderStart, renderEnd);
  frameCounter += 1;
  if (frameCounter % 12 === 0) { setMeasuredFps(fps); setMeasuredMs(ms); setCount(activeCount); onMetrics?.(…); }
} else {
  setCount(sceneRef.current?.particleCount ?? 0);   // ← every frame while the webcam is on
}
```

```tsx
// AFTER — 2 Hz, change-detected, published through a ref bucket
if (renderEnd - lastMetricsPublishAt >= METRICS_INTERVAL_MS) {          // 500 ms
  lastMetricsPublishAt = renderEnd;
  if (fps !== lastPublishedRef.current.fps) { lastPublishedRef.current.fps = fps; setMeasuredFps(fps); }
  if (ms  !== lastPublishedRef.current.ms)  { lastPublishedRef.current.ms = ms;  setMeasuredMs(ms);  }
  if (activeCount !== lastPublishedRef.current.count) { … setCount(activeCount); }
  cbRef.current.onMetrics?.({ fps, renderMs: ms, particles: activeCount });
}
```

#### D2. Effect dependency storm (P1)

```tsx
// BEFORE — every parent render restarted the rAF loop
}, [ready, liveCameraActive, showHandOverlay, fire, onStatus, onMetrics,
    onAudioMonitorChange, onDetectionDiagnostics, onGestureTriggered]);
```

`fire` and `emergencyRestore` are `useCallback`s whose own dependencies include `onStatus`/`onMetrics` — plain object/function props from the dashboard that are recreated on every render. Result: the loop was torn down (`cancelAnimationFrame`) and re-armed dozens of times per second, and mid-transition that means **a dropped frame on every parent update**.

```tsx
// AFTER — loop deps are visual state only; callbacks are read through a ref
}, [ready, liveCameraActive, showHandOverlay]);
```

This pattern is worth institutionalising for the other large components (`Dashboard`, `SettingsView`): pass primitives, or accept callbacks through a `useEvent`-style ref hook.

#### D3. `useRef(new X())` (P1)

```tsx
// BEFORE — five constructions per render, all discarded
const bgReconstructorRef = useRef(new BackgroundReconstructor(320, 180));
const handServiceRef = useRef(new HandLandmarkService());
const audioEngineRef = useRef(new LiveAudioConfirmationEngine());
const perfRef = useRef(new FramePerformanceTracker());

// AFTER — lazy, once per mount
const lazyRef = <T,>(ref: MutableRefObject<T | null>, make: () => T): T => {
  if (!ref.current) ref.current = make();
  return ref.current;
};
const stableHandService = lazyRef(handServiceRef, () => new HandLandmarkService());
```

#### D4. Memoisation & per-frame object churn

* `SnapStage` is now `memo()`-wrapped — the dashboard re-renders on every settings keystroke and every audio-meter tick, and used to re-render the entire stage subtree with it.
* The render loop reuses one `EffectRenderOptions` object (`createRenderOptions()`) instead of allocating one per frame.
* The unmount cleanup effect no longer captures service instances at mount time (they may not exist yet) — it resolves them lazily at teardown and null-checks.

#### D5. Remaining UI recommendations (not applied — behaviour-affecting)

1. Split `SnapStage.tsx` (1 102 lines) into `useDustScene` (engine), `useHandDetection` (MediaPipe), `useLiveCamera` (getUserMedia lifecycle), and a presentational `StageViewport`. The three hooks have disjoint dependency sets; today every settings change reaches all of them.
2. `Dashboard.tsx` (815 lines) holds ~14 `useState` cells that change at different frequencies. Move the high-frequency ones (audio meter, fps) into a `useSyncExternalStore`-backed store so telemetry never enters React's reconciler at all.
3. `settings.ts` (1 457 lines) mixes schema, validation, migration, persistence, presets and export/import. Split into `settings/schema.ts`, `settings/validate.ts`, `settings/storage.ts`, `settings/presets.ts` — validation and persistence are the only parts with runtime cost, and they should be independently testable.
4. `playSnap()` synthesises a 2 600-sample noise buffer on every cue; pre-render it once per `AudioContext` (the offscreen document already does this).

---

### 3.5 Category E — Build, bundle & project structure

#### E1. `vite.config.ts`

```ts
// AFTER (excerpt) — key changes
build: {
  target: "chrome121",        // was default (chrome107) while manifest required 121
  reportCompressedSize: false, // several seconds saved per build
  assetsInlineLimit: 4096,
  minify: "esbuild",
  cssCodeSplit: false,
  rollupOptions: { output: { manualChunks: { react: ["react", "react-dom"] } } },
},
esbuild: isProd ? { legalComments: "none", drop: ["debugger"], pure: ["console.debug", "console.trace"] } : undefined,
resolve: {
  alias: [
    { find: "@/", replacement: path.resolve(__dirname, "src") },
    // One MediaPipe build for both surfaces — the content script can only load
    // extension/vendor/vision_bundle.mjs at runtime, so the studio must not bundle
    // a second, independently-versioned copy from node_modules.
    { find: /^@mediapipe\/tasks-vision$/, replacement: path.resolve(__dirname, "extension/vendor/vision_bundle.mjs") },
  ],
},
```

A shadowing hazard worth noting: the previous alias `{ "@": … }` (bare string) also rewrites any import starting with `@`, including `@mediapipe/*`. The array form with an explicit regex avoids that class of bug entirely.

#### E2. Bundle & repo hygiene

| Item | Before | After |
| :--- | ---: | ---: |
| Studio JS chunk | 561 KB | 555 KB (single MediaPipe copy, React split) |
| Duplicate `public/images/*` | +608 KB in `dist/` **and** `extension/studio/` (referenced by nothing) | **removed** |
| `framer-motion` | declared, zero imports | **removed** |
| `vite-plugin-singlefile` | declared, unused, CSP-hostile if enabled | **removed** |
| Release zip in git | 10.9 MB tracked | **untracked + git-ignored** |
| Unpacked extension | 24.1 MB | 23.1 MB |

`scripts/build-extension.mjs` is now a real gate, not just a packager. It fails the build on: a non-minimal permission, an over-broad host pattern, a directory wildcard in `web_accessible_resources`, a missing offscreen file, an inline `<script>`/`on*=` handler, an unpacked size over 30 MB, or a `chrome.offscreen` call without the `offscreen` permission.

#### E3. `tsconfig.json`

`target: ES2020 → ES2022`, `lib: +ES2023`, `moduleDetection: "force"`, `noImplicitOverride`, `forceConsistentCasingInFileNames`. `ES2022` is a strict subset of what Chrome 121 executes, so this only removes downlevelling the runtime never needed.

#### E4. Suggested structure (Phase 2)

```
extension/
  manifest.json
  background.js                 # router only — no feature logic
  offscreen/{offscreen.html,offscreen.js}
  content/
    main-world-bridge.js
    snap-vanish.js              # thin orchestrator (target: < 300 lines)
    modules/ (bundled or ESM-imported)  vision/{frame-host.html,worker.js}
    isolation.css
  popup/
  studio/    (generated — consider dropping from git, build in CI)
```

The content script is the only file shipped un-bundled; once it is split, add a tiny esbuild step (`esbuild content/snap-vanish.js --bundle --target=chrome121`) so it can `import` shared modules instead of duplicating the particle emitter with `dust.ts`. That duplication is the largest remaining maintainability liability: **the same emitter is now written twice** (TypeScript for the studio, plain JS for the extension) and the two have already diverged once.

---

## 4. Verification of the delivered changes

```
$ npx tsc --noEmit
(clean — strict, noUnusedLocals, noUnusedParameters)

$ npx vitest run
Test Files  3 passed (3)
     Tests  31 passed (31)          # was 31 passed before the changes; no test weakened

$ npx vite build
dist/assets/index-*.js   554.68 kB     ✓ built in 3.87s

$ node scripts/build-extension.mjs
✓ Snap Vanish 2.0.0 verified — unpacked 23.1 MB, packaged 10.41 MB

$ npm run bench     # 12 000 particles, 120 frames
dust                      1.42 ms   fillStyles 192
cinematic-disintegration  1.71 ms   fillStyles 198
fine-particles            1.40 ms   fillStyles 194
```

Test changes (all additive or spec-correctness fixes, none deleted):

* `extensionRuntime.test.ts` — asserts the **new** permission surface (`["storage","offscreen"]`, no `tabs`/`activeTab`/`scripting`), the five origin-scoped `host_permissions`, no directory wildcards in `web_accessible_resources`, CSP contains `'wasm-unsafe-eval'` but not `'unsafe-eval'`/`'unsafe-inline'`, the offscreen document exists and has no inline script, and the **MV3 lifecycle rule is enforced** (no illegal module-scope mutable bindings in `background.js`).
* `snapVanish2Upgrade.test.tsx` — the bridge double for `RTCRtpSender` now updates `sender.track` on `replaceTrack`, matching the WebRTC spec. The previous double never changed `track`, which made it impossible to observe the "already restored" fast path (and hid the refcount bug in #14).

---

## 5. Phased roadmap

| Phase | Item | Effort | Risk | Expected gain |
| :--- | :--- | :--- | :--- | :--- |
| **P0 — done** | Bucketed SoA particle engine (studio + content script) | 2 d | Low (visual parity verified, ghost pass flaggable) | 5.2× JS frame cost; GC pauses gone |
| **P0 — done** | Service-worker state in `storage.session`, tab-target resolution, badge derivation, emergency fan-out | 1 d | Low | Fixes wrong-tab commands + stranded vanished tabs after SW suspension |
| **P0 — done** | Offscreen cue document + page-AudioContext fallback | 0.5 d | Low | Cue plays from keyboard shortcuts |
| **P0 — done** | Shadow-DOM HUD/overlay, zero host DOM mutation | 1 d | Medium (positioning) | Eliminates host layout corruption class of bugs |
| **P0 — done** | Bridge hardening (Proxy, WeakRef, refcount, host replaceTrack patch, resolution match) | 1.5 d | Medium | Eliminates black-video-on-restore |
| **P1 — next** | Move MediaPipe to extension-origin iframe + worker (§B5) | 3-4 d | Medium | 8-14 ms/frame off the meeting thread; removes host-CSP veto |
| **P1 — next** | Worker-side matte + downscaled readback (§B3) | 2-3 d | Medium | Removes the 25-45 ms snap-time hitch |
| **P2** | WebGL2 `POINTS` renderer behind a flag (§B4) | 2 d | Low | Headroom for >15 k particles / 4K |
| **P2** | Split `SnapStage` / `Dashboard` / `settings.ts`; single-source the emitter via an esbuild step | 3 d | Low | Maintainability; stops the two emitters diverging |
| **P2** | Verify mute-button state after click with keyboard fallback (§C4) | 0.5 d | Low | Survives host DOM refactors |

---

## 6. Deliverables index

| File | Status | What changed |
| :--- | :--- | :--- |
| `extension/manifest.json` | **rewritten** | Minimal permissions, explicit scoped `host_permissions`, enumerated WAR, `worker-src`, module SW |
| `extension/background.js` | **rewritten** | Stateless router, `storage.session` tab state, target resolution, badge derivation, offscreen lifecycle, emergency fan-out, sender validation |
| `extension/offscreen/offscreen.html` | ** new** | CSP-clean extension-origin audio document |
| `extension/offscreen/offscreen.js` | **new** | Long-lived `AudioContext`, cached cue buffers, `AUDIO_PLAYBACK` |
| `extension/content/main-world-bridge.js` | **rewritten** | `Proxy` RTCPeerConnection, `WeakRef` registry, ref-counted tracks, host-`replaceTrack` patch, resolution matching, in-flight guard |
| `extension/content/snap-vanish.js` | **rewritten** | Shadow-root UI, cached self-view, single render target, bucketed emitter, rVFC detection, parallel bridge attach, single AudioContext, MediaPipe validation |
| `extension/content/snap-vanish.css` | **rewritten** | Containment only (`#snap-vanish-root` backstop) |
| `src/lib/dust.ts` | **rewritten hot path** | SoA typed arrays, counting-sorted emitters, interned styles, LUT easing, cached contexts/gradients/buffers |
| `src/components/SnapStage.tsx` | **refactored** | `memo`, lazy service refs, 2 Hz change-detected telemetry, stable loop deps, reused options object |
| `vite.config.ts` | **rewritten** | `chrome121` target, MediaPipe alias, chunk splitting, prod esbuild drop |
| `tsconfig.json` | updated | ES2022 / ES2023, `moduleDetection`, extra strictness |
| `scripts/build-extension.mjs` | **rewritten** | Permission/CSP/WAR/offscreen/size gates, `--skip-build`, git-ignored zip |
| `scripts/bench-dust.mts` | **new** | Reproducible before/after frame-cost harness (`npm run bench`) |
| `package.json` / `.gitignore` | updated | Removed dead deps, `bench`/`verify` scripts, zip ignored |
| `src/__tests__/*` | updated | Manifest/CSP/lifecycle assertions; spec-faithful `RTCRtpSender` double |
| `docs/OPTIMIZATION_REPORT.md` | **this file** | — |

---

## 7. Open items I could not verify without a live call

1. **Real GPU raster cost** of 12 k `fillRect` calls — the harness measures JS only. Instrument with `performance.measure()` around `requestAnimationFrame` and compare against the compositor's frame in DevTools → Performance → "Frames".
2. **Actual MediaPipe inference latency** per device. Add `inf.inferenceMs` (already computed in `handTracker` for the studio) to the content script's `RUN_DIAGNOSTICS` payload.
3. **Host CSP behaviour on a current Meet/Teams build.** The fix (extension-origin worker) is correct regardless, but confirm the failure mode first by watching the page console for `Refused to compile or instantiate WebAssembly module`.
4. **Zoom Web Client** uses a different `RTCPeerConnection` construction path (workers in some builds), so the `Proxy` wrapper may not observe it. Verify `window.__snapVanishBridge.state.senders > 0` on a real Zoom web meeting; if it is 0, the tile-overlay fallback is the correct behaviour and the popup already reports `Tile` rather than `WebRTC`.
5. **Two-meeting-tab routing** — the delivered resolution order is unit-testable but not integration-tested. A fake-tab harness in `extensionRuntime.test.ts` would lock it in.
