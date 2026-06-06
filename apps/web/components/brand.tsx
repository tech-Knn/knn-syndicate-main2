import type { CSSProperties } from 'react';

/**
 * KNN Syndicate brand mark — a hub node wired to its nearest neighbors.
 *
 * It's a literal play on the name: "KNN" (k-nearest-neighbors) and the buyer
 * "Syndicate" both resolve to the same picture — a central node connected to the
 * ones closest to it. The tile gradient is theme-aware (indigo → violet) because
 * the stops read CSS custom properties, so the mark shifts with light/dark.
 *
 * Shapes are sized to stay legible from a 16px favicon up to a hero logo.
 */
export function BrandMark({
  size = 32,
  className,
  style,
  title = 'KNN Syndicate',
}: {
  size?: number;
  className?: string;
  style?: CSSProperties;
  title?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      className={className}
      style={style}
      role="img"
      aria-label={title}
    >
      <defs>
        <linearGradient id="knnBrandGrad" x1="2" y1="2" x2="30" y2="30" gradientUnits="userSpaceOnUse">
          <stop offset="0" style={{ stopColor: 'var(--rust)' }} />
          <stop offset="1" style={{ stopColor: 'var(--gold)' }} />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="9" fill="url(#knnBrandGrad)" />
      {/* edges: hub → each nearest neighbor */}
      <g stroke="#fff" strokeOpacity="0.6" strokeWidth="2" strokeLinecap="round">
        <line x1="16" y1="16.5" x2="16" y2="6.8" />
        <line x1="16" y1="16.5" x2="7.4" y2="22.6" />
        <line x1="16" y1="16.5" x2="24.6" y2="22.6" />
      </g>
      {/* nodes: 3 neighbors + the hub (drawn last, on top) */}
      <g fill="#fff">
        <circle cx="16" cy="6.8" r="2.7" />
        <circle cx="7.4" cy="22.6" r="2.7" />
        <circle cx="24.6" cy="22.6" r="2.7" />
        <circle cx="16" cy="16.5" r="4" />
      </g>
    </svg>
  );
}
