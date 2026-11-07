# Architecture and trust boundaries

## Surfaces

- `src/` is the React Studio and options UI; `extension/studio/` is its generated build. A standalone Studio preview cannot by itself change a meeting's outgoing video.
- `extension/content/main-world-bridge.js` is injected at `document_start`. It observes camera acquisition and WebRTC senders in the page's MAIN world. Attach/restore operations are serialized and attempt rollback on partial failure.
- `extension/content/snap-vanish.js` is injected into the ISOLATED world at `document_idle`. It selects a verified camera preview, manages the HUD, detects gestures, captures reviewed plates, renders the outgoing or local-only canvas, and reports status/errors.
- `extension/background.js` validates and routes messages, serializes canonical preference patches, targets meeting tabs, maintains best-effort session state, and creates the offscreen document.
- `extension/offscreen/` plays local cues and hosts per-tab inference when host CSP prevents in-page WebAssembly. `extension/popup/` displays observed state and sends explicit commands.

## Camera path and limitations

The bridge observes camera tracks created through `getUserMedia` and known clones. The content script requires a preview that the bridge can associate with that camera. Only a sender still associated with the verified source is eligible for replacement by the primed, correctly sized canvas track. Screen shares, remote video, unknown sources and senders whose state cannot be observed are not intentionally replaced.

If no eligible sender is available but a usable preview exists, an overlay may cover the local self-view; it is **not** outgoing video. A hidden, transformed, or otherwise unobservable preview, a wrapped sender, a track created before injection, a site-specific media pipeline, or a failed transaction can prevent both modes. A restore can fail if the original track ended or `replaceTrack` is rejected. Status reports failures rather than assuming recovery; the user's meeting controls remain authoritative.

The MAIN-world bridge and its DOM-event messages share the meeting page's environment. Their token and events coordinate requests; they are **not an authentication boundary** against a malicious or compromised page. Do not treat page-world observations as proof against the page itself.

## Detection, audio and lifecycle

The meeting and Studio each use bundled MediaPipe hand landmarks, but their gesture algorithms are separate. Studio uses a multi-phase kinematic detector; the in-call path uses a simpler recent-distance threshold. Some settings, such as Studio smoothing, camera device selection, and Studio background method, do not control the in-call pipeline. Confirmed in-call gestures honor toggle, vanish-only, restore-only, and mute-only mappings. Mute-only never intentionally unmutes.

Smart mode normally requires both a visual candidate and an acoustic onset. If audio confirmation is required but unavailable, detection remains inactive rather than becoming gesture-only. Gesture mode and Manual mode do not open the detector microphone; audio alone never triggers a vanish. The in-call audio monitor requests the browser's default input separately from the meeting; Studio may select a device. Pending microphone/camera/model initialization is generation-guarded so a late result is stopped or closed after cancellation.

MediaPipe's loader normally injects a classic script. Both Studio and the meeting script import the bundled WASM factory and use an empty loader path to avoid that injection. This does **not** override a host CSP that disallows WASM compilation. When direct in-page initialization fails, the content script asks the worker for an extension-origin offscreen model:

1. The worker accepts model requests only from a supported top-level meeting tab and keys models by sender tab, not a caller-provided tab ID.
2. At most one request is in flight per content script; frames are JPEGs with a longest edge of at most 256 pixels, sent at no more than eight requests per second. The offscreen document decodes a Blob, runs the model locally, returns landmarks, and discards the frame.
3. Up to four per-tab fallback models can exist. They are closed on detection pause/disable, navigation, tab removal, teardown, or inference failure. Initialization/inference failures are surfaced and retried with bounded backoff.

The fallback copies transient frames through extension messaging and memory; it does not save or upload them. Its lower frame rate and compression can affect accuracy. Synthetic restrictive-CSP Chromium testing demonstrates the path, not compatibility with every browser or meeting policy.

## Background frames and rendering

In-call capture is explicit: after a five-second countdown a frame is held for review in the tab. Only user approval makes it eligible for use; the extension cannot detect whether it is empty. A source identity/dimensions check is repeated before reuse. Clear, disable, detected source change, or teardown discards it. With no approved matching plate the renderer uses a neutral solid color, not a blurred live person. An approved plate can be transmitted by the meeting as part of outgoing video.

Studio has its own capture, temporal background estimate and optional segmentation; these are separate from the in-call plate. The two renderers do not promise visual parity. Render failures and missing preview geometry are exposed to the popup/HUD; a successful local render is not proof of what another participant received.

## Storage and routing

`chrome.storage.sync` contains canonical `snap_vanish_settings_v2` preferences. Legacy flat settings are migrated when no canonical document exists. Worker-side validation, a serialized write queue and batching reduce lost concurrent updates; popup and Studio surface save errors. Chrome Sync may copy preferences to the user's other signed-in browsers.

`chrome.storage.local` / web local storage hold optional presets, diagnostics and metadata, while `chrome.storage.session` holds best-effort tab routing state. The worker re-queries tabs and does not treat a stale cache as proof that a meeting is reachable. A normal command targets the active supported tab or the only supported tab, and refuses ambiguous choices; Emergency Restore requests all supported tabs. The legacy `autoStartOnCall` and `strictLocalOnly` fields are persisted but not enforced; in particular, `strictLocalOnly` does not prevent configured services or Chrome Sync from communicating.

## Permissions and network boundary

The manifest grants `storage` and `offscreen`, plus listed meeting hosts. Zoom host permissions and web-accessible-resource matches are origin-wide even though content-script injection is restricted to `/wc/*`. The extension-page CSP permits bundled WASM but not inline script. Camera/audio monitoring happens in memory, while the meeting provider continues to transmit the meeting's own video/audio. Optional cloud/billing code can contact configured endpoints in self-configured builds; see the README for details.
