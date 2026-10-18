/** The Split Dome mark: the Capitol dome cut down the middle, blue and red, on one shared base. Colors follow the theme. */
export default function Logo({ size = 56, title }: { size?: number; title?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" role={title ? "img" : undefined} aria-label={title} aria-hidden={title ? undefined : true} className="logo">
      <rect x="31" y="4" width="2" height="8" fill="currentColor" />
      <circle cx="32" cy="4" r="2.2" fill="currentColor" />
      <path d="M32 12c-11 0-19 9-19 22h19Z" fill="var(--dem)" />
      <path d="M32 12c11 0 19 9 19 22H32Z" fill="var(--rep)" />
      <rect x="10" y="34" width="44" height="3.5" fill="currentColor" />
      <g fill="currentColor">
        <rect x="13" y="40" width="3.5" height="13" />
        <rect x="21.5" y="40" width="3.5" height="13" />
        <rect x="30.25" y="40" width="3.5" height="13" />
        <rect x="39" y="40" width="3.5" height="13" />
        <rect x="47.5" y="40" width="3.5" height="13" />
      </g>
      <rect x="6" y="54" width="52" height="4" fill="currentColor" />
    </svg>
  );
}
