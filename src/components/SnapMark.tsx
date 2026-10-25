/**
 * Snap Vanish mark — two fingertips converging into a burst of dissolving dust.
 * Single colour, no gradients: it holds up filled in a toolbar at 16px.
 */
export default function SnapMark({
  className = "",
  title = "Snap Vanish",
}: {
  className?: string;
  title?: string;
}) {
  return (
    <svg
      viewBox="0 0 48 48"
      className={className}
      role="img"
      aria-label={title}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      {/* the pinch: two strokes converging */}
      <path
        d="M4.5 9.5 C 12 12.2, 18.6 16.4, 22.8 21.4"
        stroke="currentColor"
        strokeWidth="5"
        strokeLinecap="round"
      />
      <path
        d="M4.5 38.5 C 12 35.8, 18.6 31.6, 22.8 26.6"
        stroke="currentColor"
        strokeWidth="5"
        strokeLinecap="round"
      />
      {/* the burst, dust cooling as it travels */}
      <circle cx="25.6" cy="18.2" r="3.1" fill="currentColor" />
      <circle cx="31.4" cy="13.4" r="2.5" fill="currentColor" />
      <circle cx="37.2" cy="9.6" r="1.9" fill="currentColor" />
      <circle cx="41.6" cy="6.8" r="1.2" fill="currentColor" />
      <circle cx="30.2" cy="24.4" r="2.2" fill="currentColor" />
      <circle cx="36.4" cy="24.2" r="1.6" fill="currentColor" />
      <circle cx="41.4" cy="23.4" r="1" fill="currentColor" />
    </svg>
  );
}
