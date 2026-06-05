import type { SVGProps } from 'react';

/**
 * Inline SVG icon set (Feather/Lucide-style: 24px grid, currentColor stroke, round caps). Kept
 * dependency-free + tree-shakeable. Use `size` to scale; color follows `currentColor`.
 */
type IconProps = { size?: number } & Omit<SVGProps<SVGSVGElement>, 'width' | 'height'>;

function Svg({ size = 20, children, ...rest }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      {...rest}
    >
      {children}
    </svg>
  );
}

export const IconOverview = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="3" width="7" height="9" rx="1.5" />
    <rect x="14" y="3" width="7" height="5" rx="1.5" />
    <rect x="14" y="12" width="7" height="9" rx="1.5" />
    <rect x="3" y="16" width="7" height="5" rx="1.5" />
  </Svg>
);

export const IconAnalytics = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 3v18h18" />
    <rect x="7" y="12" width="3" height="5" rx="1" />
    <rect x="12.5" y="8" width="3" height="9" rx="1" />
    <rect x="18" y="5" width="3" height="12" rx="1" />
  </Svg>
);

export const IconCampaigns = (p: IconProps) => (
  <Svg {...p}>
    <path d="m3 11 15-5v12L3 13v-2z" />
    <path d="M11.5 16.5a3 3 0 0 1-5.8-1.1" />
    <path d="M18 6v12" />
    <path d="M21 8v8" />
  </Svg>
);

export const IconApprovals = (p: IconProps) => (
  <Svg {...p}>
    <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
    <path d="m9 11 3 3L22 4" />
  </Svg>
);

export const IconPlatform = (p: IconProps) => (
  <Svg {...p}>
    <line x1="21" x2="14" y1="6" y2="6" />
    <line x1="10" x2="3" y1="6" y2="6" />
    <line x1="21" x2="12" y1="12" y2="12" />
    <line x1="8" x2="3" y1="12" y2="12" />
    <line x1="21" x2="16" y1="18" y2="18" />
    <line x1="12" x2="3" y1="18" y2="18" />
    <circle cx="12" cy="6" r="2" />
    <circle cx="10" cy="12" r="2" />
    <circle cx="14" cy="18" r="2" />
  </Svg>
);

export const IconFacebook = (p: IconProps) => (
  <Svg {...p}>
    <path d="M18 2h-3a5 5 0 0 0-5 5v3H7v4h3v8h4v-8h3l1-4h-4V7a1 1 0 0 1 1-1h3z" />
  </Svg>
);

export const IconTeam = (p: IconProps) => (
  <Svg {...p}>
    <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
    <circle cx="9" cy="7" r="4" />
    <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
    <path d="M16 3.13a4 4 0 0 1 0 7.75" />
  </Svg>
);

export const IconSignOut = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
    <polyline points="16 17 21 12 16 7" />
    <line x1="21" x2="9" y1="12" y2="12" />
  </Svg>
);

export const IconSearch = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="11" cy="11" r="7.5" />
    <line x1="21" x2="16.8" y1="21" y2="16.8" />
  </Svg>
);

export const IconMenu = (p: IconProps) => (
  <Svg {...p}>
    <line x1="4" x2="20" y1="6" y2="6" />
    <line x1="4" x2="20" y1="12" y2="12" />
    <line x1="4" x2="20" y1="18" y2="18" />
  </Svg>
);

export const IconClose = (p: IconProps) => (
  <Svg {...p}>
    <line x1="18" x2="6" y1="6" y2="18" />
    <line x1="6" x2="18" y1="6" y2="18" />
  </Svg>
);

export const IconChevron = (p: IconProps) => (
  <Svg {...p}>
    <polyline points="9 18 15 12 9 6" />
  </Svg>
);
