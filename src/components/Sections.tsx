import { ShieldCheck, Sparkles, Terminal } from "lucide-react";
import { SnapMark } from "./SnapMark";
import { Badge, Card } from "./ui/DesignSystem";
import { PLATFORM_COMPATIBILITY_MATRIX } from "../features/camera/backgroundReconstructor";

export function ArchitectureAndInstallSection({
  onOpenOnboarding,
}: {
  onOpenOnboarding: () => void;
}) {
  return (
    <section
      id="install"
      className="border-t border-white/[0.07] bg-[#0b0d12] py-14"
    >
      <div className="mx-auto max-w-[1280px] space-y-10 px-4 sm:px-6 lg:px-8">
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          <Card padding="lg" className="space-y-3">
            <div className="inline-flex h-9 w-9 items-center justify-center rounded-xl bg-[#e0532c]/15 text-[#ff9d80]">
              <Sparkles className="h-4 w-4" />
            </div>
            <h3 className="text-[16px] font-semibold text-white">
              Local 21-Point Hand AI + Acoustic Gate
            </h3>
            <p className="text-[13px] leading-relaxed text-[#8b92a5]">
              MediaPipe HandLandmarker runs via bundled WebAssembly inside
              Chrome&apos;s isolated extension world, paired with a 1.8–4.2 kHz
              acoustic transient detector so hand gestures while speaking never
              false-fire.
            </p>
          </Card>

          <Card padding="lg" className="space-y-3">
            <div className="inline-flex h-9 w-9 items-center justify-center rounded-xl bg-emerald-500/15 text-emerald-300">
              <ShieldCheck className="h-4 w-4" />
            </div>
            <h3 className="text-[16px] font-semibold text-white">
              Auditable Zero-Egress Privacy
            </h3>
            <p className="text-[13px] leading-relaxed text-[#8b92a5]">
              Zero camera frames and zero microphone audio buffers are ever
              stored or uploaded. Extension settings use{" "}
              <code className="font-mono text-white">chrome.storage.sync</code>{" "}
              while optional event metadata stays strictly in{" "}
              <code className="font-mono text-white">chrome.storage.local</code>.
            </p>
          </Card>

          <Card padding="lg" className="space-y-3">
            <div className="inline-flex h-9 w-9 items-center justify-center rounded-xl bg-amber-500/15 text-amber-300">
              <Terminal className="h-4 w-4" />
            </div>
            <h3 className="text-[16px] font-semibold text-white">
              Windows &amp; macOS Chrome Unpacked Install
            </h3>
            <ol className="list-inside list-decimal space-y-1 text-[12.5px] text-[#9ca3b8]">
              <li>
                Open{" "}
                <code className="font-mono text-white">chrome://extensions</code>{" "}
                and enable <strong>Developer mode</strong>.
              </li>
              <li>
                Click <strong>Load unpacked</strong> and select the{" "}
                <code className="font-mono text-[#ff9d80]">extension/</code>{" "}
                folder (or unzipped release).
              </li>
              <li>
                Join Google Meet or Microsoft Teams and snap — or press{" "}
                <code className="font-mono text-white">Alt+Shift+D</code>.
              </li>
            </ol>
          </Card>
        </div>

        <Card padding="lg">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="rail text-[#ff9d80]">
                VIDEO CONFERENCING COMPATIBILITY MATRIX
              </div>
              <h3 className="mt-1 text-[17px] font-semibold text-white">
                Transparent WebRTC Stream vs. Local Tile Support
              </h3>
            </div>
            <button
              type="button"
              onClick={onOpenOnboarding}
              className="rounded-xl border border-white/10 bg-[#1a1d26] px-3.5 py-2 text-[12.5px] font-medium text-[#e4e6ee] hover:border-white/25"
            >
              Open 8-Step Setup Wizard
            </button>
          </div>
          <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-3">
            {PLATFORM_COMPATIBILITY_MATRIX.map((p) => (
              <div
                key={p.id}
                className="rounded-xl border border-white/[0.07] bg-[#161922] p-4"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[14px] font-semibold text-white">
                    {p.name}
                  </span>
                  <Badge
                    tone={
                      p.classification === "Partially implemented"
                        ? "emerald"
                        : "amber"
                    }
                  >
                    {p.classification}
                  </Badge>
                </div>
                <p className="mt-2 text-[12px] leading-relaxed text-[#8b92a5]">
                  {p.outgoingStreamMethod}
                </p>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </section>
  );
}

export function Footer() {
  return (
    <footer className="border-t border-white/[0.07] bg-[#08090c] py-8 text-[12.5px] text-[#6c7284]">
      <div className="mx-auto flex max-w-[1280px] flex-wrap items-center justify-between gap-4 px-4 sm:px-6 lg:px-8">
        <div className="flex items-center gap-2.5 text-[#c9cdd8]">
          <SnapMark size={18} />
          <span className="font-semibold">Snap Vanish 2.0</span>
          <span className="font-mono text-[11px] text-[#6c7284]">
            · Manifest V3 Local Disintegration Engine
          </span>
        </div>
        <div className="font-mono text-[11px]">
          100% Local Processing · Zero Video/Audio Recording · Emergency Restore{" "}
          <span className="text-[#c9cdd8]">Alt+Shift+R</span>
        </div>
      </div>
    </footer>
  );
}
