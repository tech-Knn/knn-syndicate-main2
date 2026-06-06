'use client';

import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import styles from './tooltip.module.css';

type Coords = { top: number; left: number; below: boolean };

/**
 * Portal-positioned tooltip. Unlike a pure-CSS bubble it renders into <body>, so it
 * never gets clipped by an ancestor's `overflow` (e.g. a scrolling table). Shows on
 * hover and keyboard focus; flips below the trigger when there's no room above; clamps
 * horizontally to the viewport. The fade is gated by the global reduced-motion reset.
 */
export function Tooltip({
  content,
  children,
  srLabel,
  maxWidth = 280,
  className,
}: {
  content: ReactNode;
  children: ReactNode;
  /** Accessible name for the trigger (defaults to the content when it's a string). */
  srLabel?: string;
  maxWidth?: number;
  className?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const [coords, setCoords] = useState<Coords | null>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  const open = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const below = r.top < 96;
    const cx = r.left + r.width / 2;
    const half = maxWidth / 2;
    const left = Math.min(Math.max(cx, half + 8), window.innerWidth - half - 8);
    setCoords({ top: below ? r.bottom + 8 : r.top - 8, left, below });
  }, [maxWidth]);

  const close = useCallback(() => setCoords(null), []);

  // Dismiss on scroll/resize so a stuck bubble never floats over the wrong spot.
  useEffect(() => {
    if (!coords) return;
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [coords, close]);

  const accessibleName = srLabel ?? (typeof content === 'string' ? content : 'More information');

  return (
    <span
      ref={ref}
      className={`${styles.trigger} ${className ?? ''}`}
      tabIndex={0}
      aria-label={accessibleName}
      onMouseEnter={open}
      onMouseLeave={close}
      onFocus={open}
      onBlur={close}
    >
      {children}
      {mounted &&
        coords &&
        createPortal(
          <span
            role="tooltip"
            className={`${styles.bubble} ${coords.below ? styles.below : styles.above}`}
            style={{ top: coords.top, left: coords.left, maxWidth }}
          >
            {content}
          </span>,
          document.body,
        )}
    </span>
  );
}
