# Testing and verification

## Automated checks

Use a Node version supported by the installed dependencies (Node 22.22.3 was used here). From the repository root:

```bash
npm ci
npm run typecheck
npm test                  # unit/DOM tests; no generated zip required
npm run build:extension   # builds Studio and the ignored zip
npm run test:package      # validates CRCs and compares every file to extension/
npm run verify            # typecheck, build, package check, then all tests
```

Packaging and package verification currently use the `zip` and `unzip` CLIs. `npm test` does not require either an existing archive or a prior build. The generated Studio assets in `extension/studio/` are tracked; rebuild them after Studio changes.

Tests include:

- `manifestValidation.test.ts`, `extensionRuntime.test.ts`: MV3 resource scope, manifest/build checks and content-script boot.
- `cameraBridge.test.ts`, `cleanPlate.test.ts`: camera provenance, transactional attach/rollback/restore, reviewed plate lifecycle, renderer size and priming.
- `audioSafety.test.ts`, `detectionModes.test.ts`, `handTrackerLifecycle.test.ts`, `offscreenInference.test.ts`, `studioLifecycle.test.tsx`: fail-closed audio policy, mute ownership and gesture mappings, async model/camera cleanup and offscreen inference boundaries.
- `workerSettings.test.ts`, `settingsPersistence.test.ts`, `workerRouting.test.ts`, `popupStatus.test.ts`: settings migration/serialization, tab selection, error reporting and UI status.
- `snapVanish*.test.*`: Studio components, detector math, media utilities, accessibility-oriented DOM checks, and bundled-model checksum.
- `packageArtifact.test.ts`: requesting package verification without a package is reported as an error. `test:package` separately checks a real archive.

The test output is the source of truth for the current count and result. Unit tests use mocks and jsdom; they do not prove hardware behavior, meeting integration, gesture accuracy, or complete accessibility.

## Optional real-browser synthetic smoke

Build the extension and provide a local Chromium/Chrome executable that supports MV3 extensions in headless mode. This optional test requires Node 22+ and OpenSSL:

```bash
npm run build:extension
CHROME_BIN=/path/to/chromium npm run test:browser
```

The script creates a temporary browser profile and short-lived self-signed certificate, maps a synthetic `meet.google.com` fixture to loopback, and uses a fake camera and synthetic screen-share track. It exercises actual MediaPipe inference under a synthetic restrictive `script-src 'none'` CSP, offscreen model cleanup, outgoing and overlay pixels, restoration, and screen-share isolation. It discards the temporary profile. The fixture uses `--ignore-certificate-errors`; never use it with a real account or a regular profile. Browser flags and host mapping are not a substitute for OS-level network isolation.

`SNAP_TEST_NO_SANDBOX=1` explicitly disables the Chromium sandbox and is intended **only** for an isolated disposable container that otherwise cannot launch Chromium. Do not use it with untrusted sites or a normal profile. A synthetic Chromium 150 run passed; that does not establish support for Chrome 121, any particular meeting CSP, physical devices, or actual snap accuracy.

## Manual meeting validation checklist

Perform these only in a low-risk test call with informed participants, no sensitive room content, and a second participant/device able to verify the outgoing view. Do not assume a local preview represents what others see.

1. Record Chrome version, OS, meeting site/client, extension version, and whether the tab was refreshed after installation. Confirm a live camera and usable self-preview.
2. In Manual mode, trigger vanish. Check the popup's outgoing/local-only/error status and ask the second participant what they see. If the popup says local-only, the participant should not see that overlay.
3. Start a screen share and repeat. Confirm screen share and remote video remain unchanged. Restore and verify the original camera. Test camera switching and a disconnected/ended original track; record any explicit failure instead of assuming recovery.
4. Test mic controls in muted, unmuted, unknown/localized and ambiguous-control states. Returning or Emergency Restore must not unmute. Verify mute-only gestures do not unmute an already muted microphone.
5. Test Smart with permission denied/disabled and verify it remains inactive when confirmation is required. Test Gesture and Manual modes separately; audio alone should not trigger. Measure real snap recall, false triggers and latency across lighting, distance and noise rather than inferring accuracy from model readiness.
6. Request an in-call plate, step out of frame, review it, approve or cancel it, and inspect the participant view. Verify clear/disable/reload and camera changes discard or invalidate it. Capture only imagery you are comfortable showing.
7. Repeat relevant scenarios on current Meet, Teams Web and Zoom Web, and on Chrome 121 if that minimum version is a release requirement. If testing OBS Virtual Camera, validate its complete setup and output independently; no guaranteed fallback is claimed here.

A failed or unavailable restore should be handled using the meeting's camera controls or by leaving/rejoining. Check the microphone separately.
