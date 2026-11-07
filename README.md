# Snap Vanish

Snap Vanish is a Chrome Manifest V3 extension and local Effect Studio. It attempts to replace a meeting's outgoing camera with a particle effect when a gesture is detected or a manual control is used.

**Do not assume the effect is private or visible to other participants.** Your meeting service still sends video and audio. The popup reports whether the extension changed an outgoing camera sender or only showed a local tile overlay. Check with another participant before relying on it, and use the meeting's own controls if recovery fails.

## What is implemented

- Local MediaPipe hand-landmark inference, with Smart, Gesture, and Manual detection modes. Smart mode requires visual and acoustic confirmation by default; if required audio is denied, disabled, or unavailable, detection stays inactive. Gesture mode uses no microphone; Manual uses no automatic detection. Sound alone cannot trigger a vanish. Smart's audio requirement can also be explicitly turned off.
- A meeting-page bridge that attempts `RTCRtpSender.replaceTrack()` only for a verified camera source with a matching self-preview. Unknown sources and screen shares are left untouched. If a usable self-preview is available but no safe sender is found, a **local-only** overlay may be shown instead.
- An in-call, explicitly requested background plate: a five-second countdown followed by preview and approval. If no plate is approved, the in-call effect uses a solid backdrop. The extension cannot determine whether a captured frame is empty.
- A separate Studio preview, calibration, presets, and settings. Studio's background reconstruction, kinematic detector and some controls differ from the simpler in-call implementation; they are not proof of the meeting output.
- Emergency Restore requests camera recovery but can fail if the original track ended or the site rejects replacement. It never automatically unmutes the meeting microphone.

The extension is injected on Meet, Teams Web, and Zoom Web Client URLs listed in `extension/manifest.json`. **No authenticated Meet, Teams, or Zoom call, physical camera/microphone, or OBS Virtual Camera workflow has been verified in this environment.** Site implementations, permissions, previews, and browser versions can affect the result. See [feature status](docs/FEATURE_STATUS.md) and [testing](docs/TESTING.md).

## Install and try it

1. Run `npm ci` and `npm run build:extension`; the generated `snap-vanish-chrome-extension.zip` is ignored by Git. Alternatively, extract a package built from a trusted source.
2. Open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select the `extension/` folder (or the extracted package folder).
3. Refresh an already-open meeting tab so the bridge can observe camera creation. Open the popup and focus the intended meeting tab if several are open.
4. Test a manual vanish in a low-risk call. Check the popup: **Effect sent** means a verified outgoing sender was changed; **Local tile only** means other participants do not see that overlay. Confirm with another participant.
5. To recover, use **Emergency Restore** or `Alt+Shift+R`. If it reports failure, use the meeting's camera controls or rejoin. Check the microphone separately; return/restore does not unmute it.

### In-call background capture

With a verified live camera preview and the meeting tab focused, choose **Capture plate** in the popup or meeting HUD. Step out of frame during the five-second countdown; other participants may see you leave. Review the captured image in the HUD and explicitly choose **Use this plate** only if it is suitable. It may then appear in outgoing meeting video. Clear it from the popup or HUD; disable, tab teardown, or a detected camera-source change also discards it. The separate Studio plate does not set the in-call plate.

### Shortcuts

| Action | Default |
| --- | --- |
| Enable / pause extension | `Alt+Shift+S` |
| Vanish / return | `Alt+Shift+D` |
| Request microphone toggle | `Alt+Shift+M` |
| Emergency camera restore | `Alt+Shift+R` |

Chrome may reject a conflicting shortcut. The popup shows assigned bindings and links to `chrome://extensions/shortcuts`. Normal commands target the active meeting or the only supported meeting tab; if multiple tabs are ambiguous, focus the intended tab. Emergency Restore attempts every supported meeting tab and reports incomplete attempts. Mic actions require a recognizable, unambiguous meeting control; otherwise the state is unknown and no click is attempted.

## Privacy and data handling

- **Meeting transmission:** the meeting provider continues transmitting camera video and microphone audio according to its own controls. An approved background plate and processed frames can be part of outgoing video.
- **Local inference:** bundled models run in the content-script context where possible. If the host page blocks WebAssembly, automatic detection sends transient JPEG frames through extension messaging to an extension-origin offscreen document for local inference. The longest edge is at most 256 pixels, with at most eight requests per second and four fallback models. Frames are processed in memory and not saved or uploaded by the extension. Compression and lower sampling rates can miss quick gestures.
- **Audio:** when required in Smart mode, the extension separately requests a microphone stream and analyzes it locally. It does not record or upload that monitor stream. The in-call monitor requests the browser's default microphone; Studio's device selector controls the Studio monitor. The monitor is stopped on pause, mode change, or teardown.
- **Storage:** in-call plates stay in tab memory; preferences use `chrome.storage.sync` and may sync to other browsers signed into the same Chrome profile. Optional activity/diagnostic metadata and presets use local storage. No camera frames are placed in extension storage by these flows.
- **Optional services:** models and fonts are bundled/local at runtime. Optional Supabase/billing integrations are enabled only by corresponding `VITE_...` build-time configuration; a self-configured build may contact those services. The legacy `strictLocalOnly` preference is not enforced and cannot block cloud services or Chrome Sync. Dependency installation and `prepare:assets` can use the network. These statements do not describe network traffic from Chrome or the meeting provider.

| Permission | Purpose and scope |
| --- | --- |
| `storage` | Preferences, optional local metadata, and per-tab session routing. |
| `offscreen` | Local cue playback and Blob decoding for the CSP inference fallback. |
| Host permissions | Declared Meet, Teams, and Zoom origins. Chrome ignores host-permission paths, so Zoom permission covers the matching origin. |
| Content scripts | Meet/Teams and Zoom Web Client `/wc/*` paths, as specified in the manifest. |
| Web-accessible resources | Enumerated model/WASM/vendor assets on the declared origins. Chrome requires origin-wide `/*` resource matches. |
| `'wasm-unsafe-eval'` | Permits bundled WASM in extension pages; it does not override meeting-page CSP. |

## Development and verification

The dependency versions currently require **Node 22.22.2+ on the 22.x line** (or a compatible newer Node line); Node 22.22.3 was used for verification. Chrome 121 is the manifest minimum, but that exact version has not been tested here. Packaging currently requires the `zip` and `unzip` CLIs; the optional browser smoke also requires OpenSSL and Node 22+.

```bash
npm ci
npm run dev               # local Studio development server
npm run typecheck
npm test                  # no prebuilt archive required
npm run bench             # JS-only canvas-stub micro-benchmark, not a real call
npm run build:extension   # builds Studio, validates manifest and creates zip
npm run test:package      # checks archive CRCs and contents against extension/
npm run verify            # typecheck, build, package check and tests

# Optional synthetic browser test using a locally installed Chromium/Chrome
CHROME_BIN=/path/to/chromium npm run test:browser
```

`prepare:assets` can provision missing model assets and verifies checksums. `extension/studio/` contains the tracked generated Studio build; rebuild it when changing Studio source. The Studio can also be run as a standalone web app, but it cannot control a meeting without the extension. The development server binds all interfaces and allows the Arena preview domain, localhost, and IP hosts; it has no authentication and should not be exposed to untrusted networks.

The browser smoke uses a temporary profile, fake camera and microphone, synthetic HTTPS page and restrictive CSP. It checks local inference and hidden-tab cleanup, reviewed-plate flow, output pixels, camera restore, and screen-share isolation; it is **not** a real meeting or gesture-accuracy test. See [testing](docs/TESTING.md) for prerequisites, the sandbox caveat and a manual validation checklist.

## Limitations and troubleshooting

- Hidden/transformed self-previews, unknown camera provenance, sender wrappers, tracks created before injection, and non-WebRTC pipelines can prevent replacement. Local overlay itself also requires a usable preview.
- OBS Virtual Camera is a possible separate workflow, not a guaranteed or tested fallback. Verify it independently.
- Studio background estimation and segmentation cannot reveal genuinely occluded room details; an in-call plate is manually reviewed, not automatically proven empty.
- The legacy auto-arm-on-joining preference is not implemented; use the master switch and detection mode. The similarly stored strict-local-only preference does not block network services.
- If the model or microphone is unavailable, inspect the popup status and use Manual mode. Automatic detection is not guaranteed to recognize every snap or reject every false trigger.
- If a shortcut is unassigned, rebind it in Chrome. If no meeting is reachable or several are open, focus the intended tab and reopen the popup.
- Performance depends on hardware, resolution and the meeting. No fixed frame rate or resource usage is guaranteed.

## Repository map

- `extension/content/`: meeting bridge, renderer, detector, HUD, and reviewed plate capture.
- `extension/background.js`, `extension/offscreen/`, `extension/popup/`: routing/settings, local media processing, and toolbar UI.
- `src/`: Studio, settings, calibration, and shared utilities; `extension/studio/` is its generated build.
- `scripts/`: asset preparation, extension packaging, package verification, and optional browser smoke.
- `docs/ARCHITECTURE.md`, `docs/FEATURE_STATUS.md`, `docs/TESTING.md`: current design, evidence, and validation guidance. Older audit reports are historical snapshots, not current guarantees.
