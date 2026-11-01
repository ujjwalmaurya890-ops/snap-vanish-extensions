import type { ButtonHTMLAttributes, ReactNode, SelectHTMLAttributes } from "react";
import { cn } from "../../utils/cn";

export type BadgeTone = "ember" | "emerald" | "amber" | "danger" | "neutral";

const BADGE_TONES: Record<BadgeTone, string> = {
  ember: "border-[#e0532c]/40 bg-[#e0532c]/15 text-[#ff9d80]",
  emerald: "border-emerald-500/35 bg-emerald-500/15 text-emerald-300",
  amber: "border-amber-500/35 bg-amber-500/15 text-amber-300",
  danger: "border-red-500/40 bg-red-500/15 text-red-300",
  neutral: "border-white/10 bg-white/[0.04] text-[#a1a6b5]",
};

export function Badge({
  children,
  tone = "neutral",
  className,
}: {
  children: ReactNode;
  tone?: BadgeTone;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 font-mono text-[10.5px] font-medium uppercase tracking-[0.08em]",
        BADGE_TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

export function StatusDot({
  tone = "emerald",
  pulse = false,
}: {
  tone?: "emerald" | "ember" | "amber" | "danger" | "muted";
  pulse?: boolean;
}) {
  const colorMap = {
    emerald: "bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.65)]",
    ember: "bg-[#f0623a] shadow-[0_0_8px_rgba(240,98,58,0.65)]",
    amber: "bg-amber-400 shadow-[0_0_8px_rgba(251,191,36,0.65)]",
    danger: "bg-red-400 shadow-[0_0_8px_rgba(248,113,113,0.65)]",
    muted: "bg-zinc-500",
  };
  return (
    <span
      className={cn(
        "inline-block h-2 w-2 shrink-0 rounded-full",
        colorMap[tone],
        pulse && "animate-pulse",
      )}
    />
  );
}

export function Card({
  children,
  className,
  padding = "md",
}: {
  children: ReactNode;
  className?: string;
  padding?: "none" | "sm" | "md" | "lg";
}) {
  const padMap = {
    none: "",
    sm: "p-4",
    md: "p-5",
    lg: "p-6 md:p-7",
  };
  return (
    <div
      className={cn(
        "rounded-2xl border border-white/[0.08] bg-[#14161c]/95 shadow-[0_18px_40px_-24px_rgba(0,0,0,0.8)]",
        padMap[padding],
        className,
      )}
    >
      {children}
    </div>
  );
}

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

const BTN_VARIANTS: Record<ButtonVariant, string> = {
  primary:
    "bg-gradient-to-b from-[#f0623a] to-[#d2451e] text-white shadow-[0_6px_20px_-6px_rgba(224,83,44,0.55)] hover:from-[#ff744d] hover:to-[#e0532c] border border-[#ff8a65]/25",
  secondary:
    "bg-[#1e2028] text-[#f4f4f6] border border-white/[0.1] hover:border-white/[0.22] hover:bg-[#252833]",
  ghost:
    "bg-transparent text-[#a1a6b5] border border-transparent hover:bg-white/[0.05] hover:text-white",
  danger:
    "bg-red-500/15 text-red-200 border border-red-500/35 hover:bg-red-500/25 hover:border-red-400/55",
};

const BTN_SIZES: Record<ButtonSize, string> = {
  sm: "px-3 py-1.5 text-[12px] rounded-lg gap-1.5",
  md: "px-4 py-2.5 text-[13px] rounded-xl gap-2",
  lg: "px-5 py-3 text-[14px] rounded-xl gap-2.5",
};

export function Button({
  variant = "secondary",
  size = "md",
  className,
  children,
  type = "button",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
}) {
  return (
    <button
      type={type}
      className={cn(
        "inline-flex items-center justify-center font-medium transition-all duration-150 disabled:cursor-not-allowed disabled:opacity-45",
        BTN_VARIANTS[variant],
        BTN_SIZES[size],
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

export function Switch({
  checked,
  onChange,
  label,
  description,
  disabled = false,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  description?: string;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <div className="text-[13px] font-medium text-[#f4f4f6]">{label}</div>
        {description && (
          <p className="mt-0.5 text-[12px] leading-relaxed text-[#6c7284]">
            {description}
          </p>
        )}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(
          "relative mt-0.5 h-6 w-11 shrink-0 rounded-full border transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-45",
          checked
            ? "border-[#f0623a]/50 bg-[#e0532c]"
            : "border-white/10 bg-[#252833]",
        )}
      >
        <span
          className={cn(
            "absolute top-[2px] h-[18px] w-[18px] rounded-full bg-white shadow transition-transform duration-150",
            checked ? "translate-x-[21px]" : "translate-x-[2px]",
          )}
        />
      </button>
    </div>
  );
}

export function RangeControl({
  label,
  displayValue,
  value,
  min,
  max,
  step = 1,
  hint,
  disabled = false,
  onChange,
}: {
  label: string;
  displayValue: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  hint?: string;
  disabled?: boolean;
  onChange: (next: number) => void;
}) {
  return (
    <div className={cn("space-y-1.5", disabled && "opacity-45")}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[12.5px] font-medium text-[#c9cdd8]">
          {label}
        </span>
        <span className="font-mono text-[12px] font-semibold tabular-nums text-[#ff9d80]">
          {displayValue}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        aria-label={label}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      {hint && (
        <p className="text-[11px] leading-snug text-[#6c7284]">{hint}</p>
      )}
    </div>
  );
}

export function SelectField({
  label,
  hint,
  className,
  children,
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement> & {
  label: string;
  hint?: string;
}) {
  return (
    <div className="space-y-1.5">
      <label className="block text-[12.5px] font-medium text-[#c9cdd8]">
        {label}
      </label>
      <select
        className={cn(
          "w-full rounded-xl border border-white/[0.1] bg-[#1b1d25] px-3 py-2 text-[13px] text-[#f4f4f6] transition-colors focus:border-[#f0623a] disabled:opacity-45",
          className,
        )}
        {...rest}
      >
        {children}
      </select>
      {hint && <p className="text-[11px] text-[#6c7284]">{hint}</p>}
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex items-center rounded-md border border-white/12 bg-[#1e2028] px-2 py-0.5 font-mono text-[11px] font-medium text-[#e4e6ee] shadow-inner">
      {children}
    </kbd>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-white/10 bg-[#0e1015] px-6 py-10 text-center">
      <div className="text-[14px] font-medium text-[#e4e6ee]">{title}</div>
      <p className="mt-1 max-w-[44ch] text-[12.5px] text-[#6c7284]">
        {description}
      </p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
