import { motion } from "framer-motion";
import type { ReactNode } from "react";
import SnapMark from "./SnapMark";
import dustSrc from "../assets/dust-macro.jpg";
import personSrc from "../assets/feed-person.jpg";

/* ------------------------------------------------------------------ shell */

export function Reveal({
  children,
  delay = 0,
  className = "",
}: {
  children: ReactNode;
  delay?: number;
  className?: string;
}) {
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y: 18 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-80px" }}
      transition={{ duration: 0.42, delay, ease: [0.22, 0.9, 0.28, 1] }}
    >
      {children}
    </motion.div>
  );
}

export function Rail({ children }: { children: ReactNode }) {
  return <div className="rail space-y-1.5 text-ink-soft">{children}</div>;
}

export function CropCorners() {
  return (
    <span aria-hidden className="pointer-events-none absolute inset-0">
      <span className="absolute -left-[7px] -top-[7px] h-3.5 w-3.5 border-l border-t border-rule" />
      <span className="absolute -right-[7px] -top-[7px] h-3.5 w-3.5 border-r border-t border-rule" />
      <span className="absolute -bottom-[7px] -left-[7px] h-3.5 w-3.5 border-b border-l border-rule" />
      <span className="absolute -bottom-[7px] -right-[7px] h-3.5 w-3.5 border-b border-r border-rule" />
    </span>
  );
}

/* ----------------------------------------------------------------- header */

export function Header({
  onOpenOnboarding,
}: {
  onOpenOnboarding?: () => void;
} = {}) {
  const nav = [
    ["Demo", "#demo"],
    ["Studio & Dashboard", "#dashboard"],
    ["Pipeline", "#pipeline"],
    ["Popup", "#popup"],
    ["Install", "#install"],
  ];
  return (
    <header className="sticky top-0 z-40 border-b border-rule bg-paper/92 backdrop-blur-[6px]">
      <div className="mx-auto flex max-w-[1280px] items-center gap-6 px-6 py-3 md:px-10">
        <a href="#top" className="flex items-center gap-2.5">
          <SnapMark className="h-[22px] w-[22px] text-ember" />
          <span className="font-display text-[21px] leading-none tracking-[-0.01em]">
            Snap&nbsp;Vanish
          </span>
          <span className="rail hidden border border-rule px-2 py-[3px] text-ink-soft sm:block">
            v2.0.0
          </span>
        </a>
        <nav className="ml-auto hidden items-center gap-7 md:flex">
          {nav.map(([label, href]) => (
            <a
              key={href}
              href={href}
              className="label text-ink-soft transition-colors hover:text-ember"
            >
              {label}
            </a>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-2.5 md:ml-0">
          {onOpenOnboarding && (
            <button
              type="button"
              onClick={onOpenOnboarding}
              className="border border-rule bg-paper-2 px-3.5 py-2.5 font-mono text-[10.5px] uppercase tracking-[0.14em] text-ink transition-colors hover:border-ember hover:text-ember"
            >
              Setup Wizard
            </button>
          )}
          <a
            href="#install"
            className="bg-ink px-5 py-2.5 font-mono text-[11px] uppercase tracking-[0.16em] text-paper transition-colors hover:bg-ember"
          >
            Add to Chrome
          </a>
        </div>
      </div>
    </header>
  );
}

/* ------------------------------------------------------------------- hero */

export function Hero() {
  return (
    <section id="top" className="relative border-b border-rule">
      <div className="mx-auto grid max-w-[1280px] grid-cols-1 gap-x-10 px-6 pb-16 pt-14 md:grid-cols-[180px_1fr] md:px-10 md:pb-24 md:pt-20">
        <Rail>
          <div className="text-ember">SHOT 01</div>
          <div>TALENT DISINTEGRATION</div>
          <div>22 000 PARTICLES</div>
          <div className="tnum">TC 00:00:02:14</div>
          <div className="mt-6 h-px w-10 bg-rule" />
          <div className="leading-[1.9]">
            CHROME MV3
            <br />
            MEET · TEAMS · ZOOM
            <br />
            WASM · WEBGPU
          </div>
        </Rail>

        <div>
          <h1 className="font-display text-[clamp(3.15rem,10.6vw,9.25rem)] leading-[0.86] tracking-[-0.022em]">
            Snap your
            <br />
            fingers.
            <br />
            <span className="italic text-ember">Leave</span> the meeting.
          </h1>

          <div className="mt-10 grid grid-cols-1 gap-x-12 gap-y-8 lg:grid-cols-[1.15fr_0.85fr]">
            <p className="max-w-[52ch] text-[17px] leading-[1.62] text-ink-2">
              Snap Vanish is a Chrome extension for Google Meet, Microsoft Teams and Zoom on the
              web. One snap on camera and you crumble to dust and blow out of frame — the room
              behind you is filled in with a real plate, your mic drops, and everyone else is
              looking at an empty chair. Snap again and the same dust flies back and reassembles
              you.
            </p>
            <div className="space-y-7">
              <figure>
                <div className="relative">
                <CropCorners />
                <div className="tipped overflow-hidden bg-frame">
                  <img
                    src={personSrc}
                    alt="A webcam frame: a person seated at a desk in a warmly lit home study, moments before the snap."
                    className="block aspect-[4/5] w-full object-cover object-[50%_26%]"
                    onError={(e) => {
                      (e.currentTarget as HTMLImageElement).style.opacity = "0";
                    }}
                  />
                </div>
                </div>
                <figcaption className="rail mt-3.5 text-ink-soft">
                  FIG. 01 — FRAME 001 · TALENT IN CHAIR ·{" "}
                  <span className="text-ember">MIC LIVE</span>
                </figcaption>
              </figure>

              <dl className="grid grid-cols-1 gap-3 border-t border-rule pt-5">
                {[
                  ["Trigger", "Hand-tracked snap, mic-confirmed"],
                  ["Background", "AI matte + propagated plate"],
                  ["Privacy", "Local only — 0 bytes egress"],
                ].map(([k, v]) => (
                  <div key={k} className="flex flex-col gap-0.5">
                    <dt className="rail text-ink-soft">{k}</dt>
                    <dd className="text-[14px] leading-[1.45] text-ink">{v}</dd>
                  </div>
                ))}
              </dl>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ---------------------------------------------------------------- pipeline */

const PIPELINE: { n: string; title: string; sub: string; body: string }[] = [
  {
    n: "01",
    title: "Hand landmark",
    sub: "MediaPipe Hands · 21 points · 30 fps · WASM",
    body:
      "The model runs inside the tab and looks for exactly one signature: the distance between landmark 4 (thumb tip) and landmark 12 (middle tip) collapsing from over 45 mm to under 12 mm inside 120 ms, while landmark 8 (index) and 20 (pinky) stay extended and spread. Wrist angular velocity must stay under 2.2 rad/s, so a wave is not a snap, and a hand whose bounding box shifts more than 40% mid-gesture is discarded — that is reaching for your mug, not a trigger.",
  },
  {
    n: "02",
    title: "Sound as confirmation, never as trigger",
    sub: "AnalyserNode · band-pass 2.5–5.5 kHz · ±220 ms window",
    body:
      "The mic only votes. A transient shorter than 90 ms with an RMS jump of at least 12 dB must land within 220 ms of a visual candidate. Keyboard clacks are longer than 40 ms and hold a spectral centroid below 1.8 kHz, so they are rejected outright. Without a hand candidate nothing happens — a dog barking through your speakers cannot vanish you.",
  },
  {
    n: "03",
    title: "Matte",
    sub: "Selfie segmentation · 25 fps · temporal blend 0.85",
    body:
      "A per-pixel alpha is predicted every frame, blended with the previous matte so the edges do not crawl, then run through a 3×3 median to kill the shimmer that normally gives segmentation away around hair and chair backs. The matte is feathered 6 px so the dissolve has something soft to eat into.",
  },
  {
    n: "04",
    title: "The empty plate",
    sub: "Propagated background · inpainted holes · grain-matched",
    body:
      "The room behind you is reconstructed from the frames before you moved into it, propagated forward with the camera's own motion and filled where the matte never opened up. Exposure, highlight rolloff and sensor grain are matched to the live feed, so the plate reads as the same camera rather than a pasted backdrop — no blurry silhouette, no ghost of a chair.",
  },
  {
    n: "05",
    title: "Dust",
    sub: "22 000 particles · curl noise · analytic motion",
    body:
      "Particles are sampled from your own pixels and advected through a curl-noise wind field driven by the direction you chose. Each one ignites ember-orange in its first 260 ms and cools to ash as it leaves the frame. Motion is evaluated analytically rather than stepped, which is why the exact same particles can run backwards and reassemble you to the pixel.",
  },
];

export function Pipeline() {
  return (
    <section id="pipeline" className="border-b border-rule">
      <div className="mx-auto grid max-w-[1280px] grid-cols-1 gap-x-10 px-6 py-16 md:grid-cols-[180px_1fr] md:px-10 md:py-24">
        <Rail>
          <div className="text-ember">PIPELINE</div>
          <div>FIVE STAGES</div>
          <div className="tnum">41 MS / FRAME</div>
          <div className="mt-6 h-px w-10 bg-rule" />
          <div className="leading-[1.9]">
            NO SERVER
            <br />
            NO UPLOAD
            <br />
            NO TELEMETRY
          </div>
        </Rail>

        <div>
          <h2 className="max-w-[16ch] font-display text-[clamp(2.4rem,5.6vw,4.6rem)] leading-[0.94] tracking-[-0.02em]">
            What has to be true before you are allowed to disappear.
          </h2>
          <p className="mt-6 max-w-[58ch] text-[16px] leading-[1.62] text-ink-2">
            A snap is a rare, specific thing. The whole pipeline is built to be certain about it,
            because the alternative is vanishing in the middle of your own stand-up.
          </p>

          <div className="mt-12 border-t border-rule">
            {PIPELINE.map((row, i) => (
              <Reveal key={row.n} delay={i * 0.05}>
                <div className="grid grid-cols-1 gap-x-8 gap-y-3 border-b border-rule py-8 md:grid-cols-[92px_1fr]">
                  <div className="font-display text-[44px] leading-[0.8] text-ember">
                    {row.n}
                  </div>
                  <div>
                    <h3 className="text-[21px] font-semibold leading-[1.2] tracking-[-0.012em]">
                      {row.title}
                    </h3>
                    <div className="rail mt-2 text-ink-soft">{row.sub}</div>
                    <p className="mt-4 max-w-[70ch] text-[15px] leading-[1.68] text-ink-2">
                      {row.body}
                    </p>
                  </div>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

/* ---------------------------------------------------------------- privacy */

export function PrivacyBand() {
  return (
    <section className="relative overflow-hidden bg-frame">
      <img
        src={dustSrc}
        alt=""
        aria-hidden
        className="absolute inset-0 h-full w-full object-cover opacity-70"
        onError={(e) => {
          (e.currentTarget as HTMLImageElement).style.display = "none";
        }}
      />
      <div
        aria-hidden
        className="absolute inset-0"
        style={{
          background:
            "linear-gradient(100deg, #0d0c0a 0%, rgba(13,12,10,0.92) 38%, rgba(13,12,10,0.55) 72%, rgba(13,12,10,0.8) 100%)",
        }}
      />
      <div className="relative mx-auto grid max-w-[1280px] grid-cols-1 gap-x-10 px-6 py-20 md:grid-cols-[180px_1fr] md:px-10 md:py-28">
        <Rail>
          <div className="text-[#F0623A]">PRIVACY</div>
          <div className="text-paper/55">SIGNAL PATH</div>
          <div className="mt-6 h-px w-10 bg-white/20" />
        </Rail>
        <div>
          <h2 className="max-w-[18ch] font-display text-[clamp(2.6rem,7vw,5.75rem)] leading-[0.92] tracking-[-0.022em] text-paper">
            0 bytes leave your machine.
          </h2>
          <p className="mt-7 max-w-[56ch] text-[16.5px] leading-[1.66] text-paper/72">
            The webcam stream never leaves the tab. Segmentation, the background plate, the dust
            and the shortcut handling all run locally; the only thing that reaches the call is the
            finished frame, handed back through the same peer connection it came from. There is no
            account, no upload endpoint and no analytics in the bundle.
          </p>

          <div className="mt-12 overflow-x-auto">
            <svg
              viewBox="0 0 1080 190"
              className="h-auto w-full min-w-[720px]"
              role="img"
              aria-label="Signal path: webcam to capture to matte and plate to replaceTrack to peer connection to the other participants, with no path to the internet."
            >
              <defs>
                <marker id="ar" markerWidth="9" markerHeight="9" refX="7" refY="4.5" orient="auto">
                  <path d="M0 0 L9 4.5 L0 9 z" fill="#F0623A" />
                </marker>
              </defs>
              {[
                ["WEBCAM", 0],
                ["CAPTURE", 220],
                ["MATTE + PLATE", 440],
                ["replaceTrack()", 660],
                ["PEER CONNECTION", 860],
              ].map(([label, x]) => (
                <g key={label as string} transform={`translate(${x},58)`}>
                  <rect
                    width={label === "PEER CONNECTION" ? 200 : 180}
                    height="66"
                    fill="none"
                    stroke="#F2EDE3"
                    strokeOpacity="0.36"
                  />
                  <text
                    x={label === "PEER CONNECTION" ? 100 : 90}
                    y="39"
                    textAnchor="middle"
                    fill="#F2EDE3"
                    style={{
                      font: "500 11px var(--font-mono)",
                      letterSpacing: "0.16em",
                    }}
                  >
                    {label}
                  </text>
                </g>
              ))}
              {[185, 405, 625, 835].map((x) => (
                <line
                  key={x}
                  x1={x}
                  y1="91"
                  x2={x + 30}
                  y2="91"
                  stroke="#F0623A"
                  strokeWidth="2"
                  markerEnd="url(#ar)"
                />
              ))}
              <line x1="530" y1="124" x2="530" y2="166" stroke="#F2EDE3" strokeOpacity="0.22" />
              <text
                x="530"
                y="184"
                textAnchor="middle"
                fill="#F2EDE3"
                fillOpacity="0.42"
                style={{ font: "500 10.5px var(--font-mono)", letterSpacing: "0.18em" }}
              >
                NO NETWORK PATH — 0 B
              </text>
              <line
                x1="470"
                y1="166"
                x2="590"
                y2="166"
                stroke="#F0623A"
                strokeOpacity="0.7"
                strokeWidth="1.5"
              />
            </svg>
          </div>

          <div className="mt-10 flex flex-wrap gap-x-8 gap-y-3">
            {[
              "Runs offline after install",
              "No remote code (MV3 CSP)",
              "Open source, build it yourself",
              "Uninstall removes everything",
            ].map((t) => (
              <span key={t} className="rail flex items-center gap-2 text-paper/60">
                <span className="h-[5px] w-[5px] bg-[#F0623A]" />
                {t}
              </span>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

/* ---------------------------------------------------------------- install */

const FILES = [
  ["manifest.json", "1.4 KB", "MV3 · permissions: activeTab, storage (least-privilege)"],
  ["background.js", "3.6 KB", "Service worker — validated message routing & shortcut dispatch"],
  ["content/snap-vanish.js", "15.2 KB", "State machine, detector, matte, multi-effect canvas overlay"],
  ["content/snap-vanish.css", "1.6 KB", "On-call frame overlay + emergency restore HUD"],
  ["popup/popup.html", "4.0 KB", "360px dark-mode popup interface"],
  ["popup/popup.css", "5.1 KB", "Premium dark theme styles with violet & ember accents"],
  ["popup/popup.js", "4.7 KB", "Settings persistence, meeting modes, chrome.storage.sync"],
];

const SHORTCUTS = [
  ["Alt + Shift + S", "Toggle the snap — works with the popup closed"],
  ["Alt + Shift + D", "Vanish immediately, bypassing detection"],
  ["Alt + Shift + M", "Mute or unmute without vanishing"],
  ["Alt + Shift + R", "Reset the frame back to the live feed"],
];

export function Install() {
  return (
    <section id="install" className="border-b border-rule">
      <div className="mx-auto grid max-w-[1280px] grid-cols-1 gap-x-10 px-6 py-16 md:grid-cols-[180px_1fr] md:px-10 md:py-24">
        <Rail>
          <div className="text-ember">INSTALL</div>
          <div>UNPACKED · 8 FILES</div>
          <div className="tnum">≈ 7.6 MB</div>
          <div className="mt-6 h-px w-10 bg-rule" />
          <div className="leading-[1.9]">
            CHROME 121+
            <br />
            EDGE · ARC · BRAVE
          </div>
        </Rail>

        <div>
          <h2 className="max-w-[17ch] font-display text-[clamp(2.4rem,5.6vw,4.4rem)] leading-[0.94] tracking-[-0.02em]">
            Four minutes, no build step, no account.
          </h2>

          <ol className="mt-10 grid grid-cols-1 gap-x-10 gap-y-8 sm:grid-cols-2">
            {[
              ["Unzip", "Download snap-vanish-1.4.0.zip and unpack it anywhere you like."],
              [
                "Load it",
                "Open chrome://extensions, turn on Developer mode, then Load unpacked and pick the folder.",
              ],
              [
                "Grant the camera",
                "Open Meet, Teams or Zoom. Snap Vanish asks once for camera and microphone access on that tab.",
              ],
              [
                "Snap",
                "Raise your hand, snap your fingers. Allow about 200 ms for the matte before the dust starts.",
              ],
            ].map(([title, body], i) => (
              <Reveal key={title} delay={i * 0.06}>
                <li className="relative border-t border-rule pt-5">
                  <CropCorners />
                  <div className="rail text-ember">STEP {String(i + 1).padStart(2, "0")}</div>
                  <h3 className="mt-2 text-[19px] font-semibold tracking-[-0.012em]">{title}</h3>
                  <p className="mt-2.5 max-w-[42ch] text-[14.5px] leading-[1.62] text-ink-2">
                    {body}
                  </p>
                </li>
              </Reveal>
            ))}
          </ol>

          <div className="mt-16 grid grid-cols-1 gap-x-12 gap-y-12 lg:grid-cols-2">
            <div>
              <h3 className="label text-ink-soft">What is in the folder</h3>
              <div className="mt-4 border-t border-rule">
                {FILES.map(([name, size, note]) => (
                  <div
                    key={name}
                    className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-b border-rule py-2.5"
                  >
                    <span className="font-mono text-[12.5px] text-ink">{name}</span>
                    <span className="tnum rail ml-auto text-ink-soft">{size}</span>
                    <span className="w-full text-[12px] leading-[1.5] text-ink-soft">{note}</span>
                  </div>
                ))}
              </div>
            </div>

            <div>
              <h3 className="label text-ink-soft">Keyboard backup</h3>
              <div className="mt-4 border-t border-rule">
                {SHORTCUTS.map(([key, what]) => (
                  <div
                    key={key}
                    className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-b border-rule py-3"
                  >
                    <kbd className="border border-rule bg-paper-2 px-2.5 py-1.5 font-mono text-[11px] tracking-[0.06em] text-ink">
                      {key}
                    </kbd>
                    <span className="flex-1 text-[13px] leading-[1.5] text-ink-2">{what}</span>
                  </div>
                ))}
              </div>
              <p className="mt-4 max-w-[46ch] text-[12.5px] leading-[1.6] text-ink-soft">
                Shortcuts can be remapped at chrome://extensions/shortcuts. If your laptop has no
                physical mic access on the tab, the backup keys are the only trigger — they are
                deliberately bound away from the letter keys people type on.
              </p>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ----------------------------------------------------------------- footer */

export function Footer() {
  return (
    <footer className="bg-paper">
      <div className="mx-auto grid max-w-[1280px] grid-cols-1 gap-x-10 gap-y-8 px-6 py-14 md:grid-cols-[180px_1fr] md:px-10">
        <div className="flex items-start gap-3">
          <SnapMark className="h-8 w-8 text-ember" />
          <div>
            <div className="font-display text-[24px] leading-none">Snap Vanish</div>
            <div className="rail mt-1.5 text-ink-soft">v1.4.0 · BUILD 2417</div>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-x-10 gap-y-8 sm:grid-cols-3">
          <div>
            <div className="rail text-ink-soft">WORKS ON</div>
            <p className="mt-3 text-[13.5px] leading-[1.7] text-ink-2">
              Google Meet
              <br />
              Microsoft Teams (web)
              <br />
              Zoom (web client)
              <br />
              Any WebRTC call in Chrome
            </p>
          </div>
          <div>
            <div className="rail text-ink-soft">REQUIREMENTS</div>
            <p className="mt-3 text-[13.5px] leading-[1.7] text-ink-2">
              Chrome 121 or later
              <br />
              Webcam + microphone
              <br />
              WebGL2 (WebGPU optional)
              <br />
              ~180 MB free memory
            </p>
          </div>
          <div>
            <div className="rail text-ink-soft">FINE PRINT</div>
            <p className="mt-3 text-[13.5px] leading-[1.7] text-ink-2">
              Fan-made. Not affiliated with, endorsed by or connected to Marvel, Disney or
              Avengers: Endgame. Please vanish responsibly — and only in meetings where an empty
              chair will be funny.
            </p>
          </div>
        </div>
      </div>
      <div className="border-t border-rule">
        <div className="mx-auto flex max-w-[1280px] flex-wrap items-center gap-x-6 gap-y-2 px-6 py-5 md:px-10">
          <span className="rail text-ink-soft">© 2026 SNAP VANISH</span>
          <span className="rail text-ink-soft">LOCAL PROCESSING · 0 B EGRESS</span>
          <a href="#top" className="rail ml-auto text-ember hover:underline">
            BACK TO TOP ↑
          </a>
        </div>
      </div>
    </footer>
  );
}
