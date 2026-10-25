import { useCallback, useEffect, useRef, useState } from "react";
import { DustScene, playSnap, type Direction, type EffectType } from "../lib/dust";
import { FramePerformanceTracker } from "../lib/diagnostics";
import roomSrc from "../assets/room-empty.jpg";
import personSrc from "../assets/feed-person.jpg";

export type SnapStatus = "idle" | "vanishing" | "gone" | "returning";

type Props = {
  enabled: boolean;
  duration: number;
  direction: Direction;
  sensitivity: number;
  snapSignal: number;
  emergencySignal?: number;
  sound: boolean;
  effect?: EffectType;
  speed?: number;
  particleSize?: number;
  density?: number;
  colorAccent?: string;
  intensity?: number;
  lowPowerMode?: boolean;
  onStatus: (s: SnapStatus) => void;
  onEmergencyRestore?: () => void;
  onMetrics?: (metrics: {
    fps: number | null;
    renderMs: number | null;
    particles: number;
  }) => void;
};

const STATUS_COPY: Record<SnapStatus, { label: string; tone: string }> = {
  idle: { label: "LIVE · TALENT PRESENT · MIC LIVE", tone: "text-emerald-400" },
  vanishing: {
    label: "VANISHING · DISINTEGRATING · MIC MUTED",
    tone: "text-[#F0623A]",
  },
  gone: { label: "VANISHED · FRAME EMPTY · MIC MUTED", tone: "text-violet-300" },
  returning: {
    label: "RESTORING · RECONSTRUCTING · MIC OPENING",
    tone: "text-[#F0623A]",
  },
};

const EFFECT_LABELS: Record<EffectType, string> = {
  dust: "CURL-NOISE DUST",
  "pixel-dissolve": "PIXEL DISSOLVE",
  "digital-glitch": "DIGITAL GLITCH",
  "fade-out": "STUDIO FADE-OUT",
  "light-burst": "SOLAR LIGHT-BURST",
};

export default function SnapStage({
  enabled,
  duration,
  direction,
  sensitivity,
  snapSignal,
  emergencySignal = 0,
  sound,
  effect = "dust",
  speed = 1.0,
  particleSize = 1.0,
  density = 80,
  colorAccent = "#d2451e",
  intensity = 85,
  lowPowerMode = false,
  onStatus,
  onEmergencyRestore,
  onMetrics,
}: Props) {
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const tcRef = useRef<HTMLSpanElement>(null);
  const sceneRef = useRef<DustScene | null>(null);
  const perfRef = useRef(new FramePerformanceTracker());
  const phaseRef = useRef<{ p: SnapStatus; t0: number; from: number; to: number }>({
    p: "idle",
    t0: 0,
    from: 0,
    to: 0,
  });
  const settingsRef = useRef({
    duration,
    direction,
    effect,
    speed,
    particleSize,
    density,
    colorAccent,
    intensity,
    lowPowerMode,
  });
  const soundRef = useRef(sound);
  const audioRef = useRef<AudioContext | null>(null);
  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState<SnapStatus>("idle");
  const [count, setCount] = useState(0);
  const [measuredFps, setMeasuredFps] = useState<number | null>(null);
  const [measuredMs, setMeasuredMs] = useState<number | null>(null);

  settingsRef.current = {
    duration,
    direction,
    effect,
    speed,
    particleSize,
    density,
    colorAccent,
    intensity,
    lowPowerMode,
  };
  soundRef.current = sound;

  useEffect(() => {
    let cancelled = false;
    const scene = new DustScene();
    sceneRef.current = scene;

    const load = (src: string) =>
      new Promise<HTMLImageElement | null>((resolve) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => resolve(null);
        img.src = src;
      });

    Promise.all([load(roomSrc), load(personSrc)]).then(([room, person]) => {
      if (cancelled) return;
      scene.build(room, person);
      setCount(scene.particleCount);
      setReady(true);
    });

    return () => {
      cancelled = true;
    };
  }, []);

  // Main render loop with real frame latency measurement
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let raf = 0;
    let t = 0;
    let frameCounter = 0;
    const start = performance.now();

    const loop = () => {
      raf = requestAnimationFrame(loop);
      const renderStart = performance.now();
      const ph = phaseRef.current;
      const cfg = settingsRef.current;
      const effectiveDur =
        Math.max(0.35, cfg.duration / Math.max(0.5, cfg.speed)) * 1000;

      if (ph.p === "vanishing" || ph.p === "returning") {
        const k = Math.min(1, (renderStart - ph.t0) / effectiveDur);
        t = ph.from + (ph.to - ph.from) * k;
        if (k >= 1) {
          const next: SnapStatus = ph.p === "vanishing" ? "gone" : "idle";
          phaseRef.current = { p: next, t0: renderStart, from: ph.to, to: ph.to };
          setStatus(next);
          onStatus(next);
        }
      } else {
        t = phaseRef.current.to;
      }

      sceneRef.current?.render(ctx, t, cfg.direction, cfg.duration, {
        effect: cfg.effect,
        speed: cfg.speed,
        particleSize: cfg.particleSize,
        density: cfg.density,
        colorAccent: cfg.colorAccent,
        intensity: cfg.intensity,
        lowPowerMode: cfg.lowPowerMode,
      });

      const renderEnd = performance.now();
      perfRef.current.recordFrame(renderStart, renderEnd);
      frameCounter += 1;

      if (frameCounter % 15 === 0) {
        const fps = perfRef.current.getMeasuredFps();
        const ms = perfRef.current.getMeasuredRenderMs();
        const activeCount = sceneRef.current?.particleCount ?? 0;
        setMeasuredFps(fps);
        setMeasuredMs(ms);
        setCount(activeCount);
        onMetrics?.({ fps, renderMs: ms, particles: activeCount });
      }

      if (tcRef.current) {
        const el = (renderEnd - start) / 1000;
        const mm = String(Math.floor(el / 60)).padStart(2, "0");
        const ss = String(Math.floor(el % 60)).padStart(2, "0");
        const ff = String(Math.floor((el % 1) * 25)).padStart(2, "0");
        tcRef.current.textContent = `00:${mm}:${ss}:${ff}`;
      }
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [ready, onStatus, onMetrics]);

  // Cleanup AudioContext on unmount
  useEffect(() => {
    return () => {
      if (audioRef.current && audioRef.current.state !== "closed") {
        void audioRef.current.close().catch(() => {});
      }
    };
  }, []);

  const playClickSound = useCallback(() => {
    if (!soundRef.current) return;
    try {
      if (!audioRef.current) {
        const AC =
          window.AudioContext ||
          (window as unknown as { webkitAudioContext: typeof AudioContext })
            .webkitAudioContext;
        audioRef.current = new AC();
      }
      if (audioRef.current.state === "suspended") {
        void audioRef.current.resume();
      }
      playSnap(audioRef.current);
    } catch {
      /* audio is optional confirmation feedback */
    }
  }, []);

  const fire = useCallback(() => {
    const ph = phaseRef.current;
    if (!enabledRef.current) return;
    if (ph.p === "vanishing" || ph.p === "returning") return;
    const next: SnapStatus = ph.p === "gone" ? "returning" : "vanishing";
    phaseRef.current = {
      p: next,
      t0: performance.now(),
      from: next === "vanishing" ? 0 : 1,
      to: next === "vanishing" ? 1 : 0,
    };
    setStatus(next);
    onStatus(next);
    playClickSound();
  }, [onStatus, playClickSound]);

  const emergencyRestore = useCallback(() => {
    phaseRef.current = { p: "idle", t0: 0, from: 0, to: 0 };
    setStatus("idle");
    onStatus("idle");
    onEmergencyRestore?.();
  }, [onStatus, onEmergencyRestore]);

  // Keyboard shortcuts: Alt+Shift+S (toggle), Alt+Shift+D (vanish now), Alt+Shift+R (emergency restore)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || !e.shiftKey) return;
      if (e.code === "KeyS") {
        e.preventDefault();
        fire();
      } else if (e.code === "KeyD") {
        e.preventDefault();
        if (enabledRef.current && phaseRef.current.p === "idle") {
          fire();
        }
      } else if (e.code === "KeyR") {
        e.preventDefault();
        emergencyRestore();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fire, emergencyRestore]);

  useEffect(() => {
    if (snapSignal > 0) fire();
  }, [snapSignal, fire]);

  useEffect(() => {
    if (emergencySignal > 0) emergencyRestore();
  }, [emergencySignal, emergencyRestore]);

  const statusCopy = STATUS_COPY[status];

  return (
    <div>
      {/* the frame: pasted photographic print */}
      <div className="relative bg-frame tipped">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/10 px-4 py-2.5">
          <div className="flex items-center gap-3">
            <span
              className="flex h-2 w-2 rounded-full"
              style={{
                backgroundColor: colorAccent,
                boxShadow: `0 0 10px ${colorAccent}`,
              }}
            />
            <span className="rail text-paper/65">
              CAM 01 · 1280×720 · {EFFECT_LABELS[effect]}
            </span>
            {lowPowerMode && (
              <span className="rail rounded bg-emerald-500/20 px-2 py-0.5 text-emerald-300">
                LOW-POWER
              </span>
            )}
          </div>
          <div className="flex items-center gap-4">
            <span className="rail tnum text-paper/55">
              {measuredFps !== null ? `${measuredFps} FPS` : "MEASURING…"} ·{" "}
              {measuredMs !== null ? `${measuredMs} MS` : "—"}
            </span>
            <span ref={tcRef} className="rail tnum text-paper/55">
              00:00:00:00
            </span>
          </div>
        </div>

        <div className="relative">
          <canvas
            ref={canvasRef}
            width={1280}
            height={720}
            className="block w-full"
            style={{ aspectRatio: "16 / 9" }}
            aria-label={`Live camera preview showing the ${EFFECT_LABELS[effect]} effect`}
          />

          {!ready && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-frame">
              <div className="h-[2px] w-40 overflow-hidden bg-white/15">
                <div className="h-full w-1/3 animate-pulse bg-[#F0623A]" />
              </div>
              <span className="rail text-paper/50">CALIBRATING MATTE…</span>
            </div>
          )}

          {/* corner crop marks */}
          <div className="pointer-events-none absolute inset-0">
            {[
              "left-3 top-3 border-l border-t",
              "right-3 top-3 border-r border-t",
              "left-3 bottom-3 border-l border-b",
              "right-3 bottom-3 border-r border-b",
            ].map((c) => (
              <span key={c} className={`absolute h-5 w-5 border-white/25 ${c}`} />
            ))}
          </div>

          {/* live readout */}
          <div className="pointer-events-none absolute bottom-4 left-4 flex items-center gap-2.5">
            <span
              className={`rail bg-black/65 px-2.5 py-1.5 backdrop-blur-sm ${statusCopy.tone}`}
            >
              {statusCopy.label}
            </span>
          </div>
          <div className="pointer-events-none absolute right-4 top-4 text-right">
            <div className="rail text-[#F0623A]">LOCAL PREVIEW · 0 B EGRESS</div>
            <div className="rail tnum text-paper/55">
              {count ? count.toLocaleString() : "0"} ACTIVE ELEMENTS
            </div>
          </div>
        </div>

        {/* transport */}
        <div className="flex flex-wrap items-center gap-3 border-t border-white/10 px-4 py-3.5">
          <button
            type="button"
            onClick={fire}
            disabled={!enabled || status === "vanishing" || status === "returning"}
            className={`px-6 py-3 font-mono text-[11px] font-semibold uppercase tracking-[0.18em] transition-colors ${
              enabled && status !== "vanishing" && status !== "returning"
                ? "bg-[#F0623A] text-[#1a0d07] hover:bg-[#ff7a4d]"
                : "cursor-not-allowed bg-white/10 text-paper/40"
            }`}
          >
            {!enabled
              ? "Extension is off"
              : status === "gone"
                ? "Snap to return"
                : status === "idle"
                  ? "Snap now"
                  : "Transitioning…"}
          </button>
          <button
            type="button"
            onClick={emergencyRestore}
            className="border border-red-400/35 bg-red-500/15 px-4 py-3 font-mono text-[11px] uppercase tracking-[0.16em] text-red-200 transition-colors hover:border-red-400/60 hover:bg-red-500/25"
            title="Unconditionally restores the live camera feed and unmutes audio (Alt+Shift+R)"
          >
            Emergency Restore
          </button>
          <div className="ml-auto flex items-center gap-2">
            <span className="rail text-paper/40">SHORTCUTS</span>
            <kbd className="rail border border-white/20 bg-white/5 px-2.5 py-1.5 text-paper/80">
              ALT + SHIFT + S / R
            </kbd>
          </div>
        </div>
      </div>

      {/* controls, set on the paper below the print */}
      <div className="mt-7 grid grid-cols-1 gap-x-10 gap-y-6 sm:grid-cols-2">
        <Control
          name="Effect duration & speed"
          value={`${duration.toFixed(1)} s · ${speed.toFixed(1)}×`}
          hint="Controls how long disintegration and reassembly take. Adjust duration, speed, particle density, and effect type in the Popup or Custom Effect Studio."
        >
          <div className="h-[3px] w-full bg-rule">
            <div
              className="h-full bg-ember"
              style={{ width: `${((duration - 0.5) / 3.5) * 100}%` }}
            />
          </div>
        </Control>
        <Control
          name="Trigger sensitivity"
          value={`${sensitivity} / 100`}
          hint="Snap detection threshold — higher is stricter, so waving, typing and reaching for a mug stop counting as snaps."
        >
          <div className="h-[3px] w-full bg-rule">
            <div className="h-full bg-ember" style={{ width: `${sensitivity}%` }} />
          </div>
        </Control>
      </div>
    </div>
  );
}

function Control({
  name,
  value,
  hint,
  children,
}: {
  name: string;
  value: string;
  hint: string;
  children?: React.ReactNode;
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <span className="label text-ink">{name}</span>
        <span className="tnum font-mono text-[13px] text-ember">{value}</span>
      </div>
      <div className="mt-2">{children}</div>
      <p className="mt-2 max-w-[38ch] text-[12.5px] leading-[1.6] text-ink-soft">
        {hint}
      </p>
    </div>
  );
}
