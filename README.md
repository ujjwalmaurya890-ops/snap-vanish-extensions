# Snap Vanish v2.0.0 — Chrome Extension & Companion SaaS Studio

Snap Vanish is a Manifest V3 Chrome Extension and companion React + TypeScript web studio that lets you exit and re-enter your camera frame with reversible visual effects (**Dust Particles**, **Pixel Dissolve**, **Digital Glitch**, **Studio Fade-Out**, and **Solar Light-Burst**), Smart Meeting Modes, Gesture Calibration, Local Usage Analytics, Diagnostics, and an unconditional Emergency Restore guarantee.

---

## 1. Requirements

- **Node.js:** `v20+` (verified on `v22.22.3`)
- **npm:** `v10+` (verified on `10.9.8`)
- **Browser (for extension loading):** Google Chrome `121+` (or Chromium-based browsers supporting Manifest V3)

---

## 2. Installation

Clone the repository and install dependencies:

```bash
npm install
```

---

## 3. Development, Testing & Build Commands

All scripts are defined in `package.json`:

```bash
# Start the local Vite development server for the Companion Web Studio & Dashboard
npm run dev

# Run TypeScript strict type-checking
npm run typecheck

# Run the Vitest automated unit & integration test suite
npm test

# Build the production Web Studio & Dashboard bundle into dist/
npm run build

# Preview the production build locally
npm run preview
```

---

## 4. How to Load the Extension Unpacked in Chrome

The unpacked Chrome Manifest V3 extension resides directly in the `extension/` folder:

1. Open Google Chrome and navigate to `chrome://extensions`.
2. Enable **Developer mode** using the toggle in the top-right corner.
3. Click **Load unpacked**.
4. Select the `/extension` directory inside this repository (`snap-vanish-extensions/extension`).
5. Pin **Snap Vanish** from the Chrome Extensions toolbar menu.
6. Optional: Visit `chrome://extensions/shortcuts` to inspect or customize the 4 keyboard shortcuts:
   - `Alt + Shift + S`: Toggle Vanish / Restore
   - `Alt + Shift + D`: Vanish immediately (bypassing gesture detection)
   - `Alt + Shift + M`: Mute / Unmute microphone without vanishing
   - `Alt + Shift + R`: Emergency Restore to live camera feed

---

## 5. Configuration Steps (Optional Cloud Sync & Billing)

Snap Vanish works **100% locally and offline by default**. No account, API key, or external backend is required for core vanish/restore actions, visual effects, custom presets, gesture calibration, or local analytics.

To enable optional Supabase Cloud Preset Sync or server-verified billing in your own deployment:

1. Copy `.env.example` to `.env`:
   ```bash
   cp .env.example .env
   ```
2. Populate the variables in `.env`:
   - `VITE_SUPABASE_URL`: Your HTTPS Supabase project URL.
   - `VITE_SUPABASE_ANON_KEY`: Your Supabase anonymous public key (with Row-Level Security enabled on user preset tables; **never** place a service-role secret in `.env` or browser code).
   - `VITE_BILLING_CHECKOUT_URL`: Server-side checkout session endpoint.
   - `VITE_BILLING_PORTAL_URL`: Server-side customer billing portal endpoint.

When these environment variables are unset, the Dashboard's **Account, Cloud & Plans** tab honestly reports their status as `BLOCKED` rather than simulating fake authentication or billing.

---

## 6. Permissions Explanation

`extension/manifest.json` requests only minimal, least-privilege permissions:

| Permission | Why It Is Required |
| :--- | :--- |
| `activeTab` | Allows the service worker (`background.js`) and popup (`popup.js`) to send Vanish, Restore, and Settings messages to the currently active call tab. |
| `storage` | Persists user effect settings, presets, and sensitivity calibration in `chrome.storage.sync` across browser restarts and service-worker sleep cycles. |
| `host_permissions` (`meet.google.com`, `teams.microsoft.com`, `*.zoom.us`) | Injects `content/snap-vanish.js` and `content/snap-vanish.css` into supported web conferencing tabs to render the effect canvas overlay and status HUD. |

*Note: The unused `"offscreen"` permission present in the v1.4.0 baseline has been removed in v2.0.0.*

---

## 7. Known Limitations

1. **WebRTC Track Replacement vs. DOM Overlay (`interceptionMode`)**:
   - Content scripts run in Chrome's `ISOLATED` execution world by default. Unless a page exposes its `RTCPeerConnection` senders or a `MAIN`-world media wrapper is injected prior to call initialization, the content script operates in `dom-overlay` mode (rendering the disintegration canvas over the meeting tab's `<video>` element and toggling the meeting's mute control) and explicitly reports `interceptionMode: "dom-overlay"` rather than falsely claiming outgoing WebRTC `replaceTrack()` replacement.
2. **Hand Landmark WASM Binary Not Bundled**:
   - The baseline repository referenced a non-existent `models/hands.task` file and threw an uncaught error in `estimateHands()`. In v2.0.0, `estimateHands()` safely returns `null` unless a landmark estimator is provided on `window.__snapVanishHandEstimator`, while manual popup controls, keyboard shortcuts (`Alt+Shift+S` / `Alt+Shift+D` / `Alt+Shift+R`), and the Gesture Studio calibration harness work reliably out of the box.
3. **Cloud Sync & Billing Unconfigured by Default**:
   - Without external Supabase and payment provider credentials in `.env`, cloud preset synchronization and Pro checkout remain marked `BLOCKED`.

---

## 8. Troubleshooting

- **"No active call tab" warning in Popup:**
  - Make sure your active browser tab is `https://meet.google.com/*`, `https://teams.microsoft.com/*`, or `https://*.zoom.us/*`. If you installed or reloaded the extension while a call tab was already open, refresh that call tab once so `content/snap-vanish.js` attaches.
- **Effect triggered accidentally or stuck mid-transition:**
  - Press `Alt + Shift + R` or click **Emergency Restore** in the popup, on-call HUD, or Web Dashboard to unconditionally cancel active animations, remove overlays, unmute audio, and return to `LIVE`.
- **High CPU/GPU usage on older laptops:**
  - Select the **Low-Power** Smart Meeting Mode (or enable the **Low-Power optimization** checkbox in the popup/studio), which caps particle density at 35% and disables secondary motion-smear draw passes.
