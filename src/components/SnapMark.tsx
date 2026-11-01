type MarkProps = {
  size?: number;
  className?: string;
};

/**
 * Geometric warm-ember disintegration mark: solid left hemisphere
 * dispersing into ember dust fragments to the right.
 */
export function SnapMark({ size = 24, className = "" }: MarkProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 28 28"
      fill="none"
      aria-hidden="true"
      className={className}
    >
      <defs>
        <linearGradient id="sv-ember-grad" x1="0" y1="0" x2="28" y2="28" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#ff8a65" />
          <stop offset="55%" stopColor="#f0623a" />
          <stop offset="100%" stopColor="#b83714" />
        </linearGradient>
      </defs>
      {/* Solid intact hemisphere */}
      <path
        d="M14 3.5 A 10.5 10.5 0 0 0 14 24.5 L 14 3.5 Z"
        fill="url(#sv-ember-grad)"
      />
      {/* Dispersing fragments */}
      <polygon points="15.2,5.2 18.2,4.4 17.4,7.4 15.0,7.0" fill="#ff8a65" />
      <rect x="15.4" y="9.5" width="3.0" height="3.0" rx="0.6" fill="#f0623a" />
      <polygon points="15.2,14.8 18.6,15.4 17.5,18.2 15.0,17.4" fill="#f0623a" />
      <rect x="15.2" y="20.0" width="2.6" height="2.6" rx="0.5" fill="#d2451e" />

      <rect x="20.2" y="7.2" width="2.2" height="2.2" rx="0.5" fill="#ff9d80" opacity="0.88" />
      <circle cx="21.6" cy="13.4" r="1.3" fill="#f0623a" opacity="0.82" />
      <rect x="19.8" y="17.8" width="2.0" height="2.0" rx="0.5" fill="#e0532c" opacity="0.76" />

      <circle cx="25.0" cy="9.8" r="0.95" fill="#ff9d80" opacity="0.62" />
      <circle cx="25.6" cy="15.6" r="0.85" fill="#f0623a" opacity="0.52" />
      <circle cx="24.2" cy="20.2" r="0.8" fill="#e0532c" opacity="0.42" />
    </svg>
  );
}
