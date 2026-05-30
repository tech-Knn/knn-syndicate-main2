'use client';

import { useEffect, useRef, useState } from 'react';
import { addBusinessDays, currentBusinessDay } from '@knn/shared';
import styles from './date-range.module.css';

export interface DateRange {
  from: string; // YYYY-MM-DD (business day, IST)
  to: string;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function parse(s: string): { y: number; m: number; d: number } {
  const [y, m, d] = s.split('-').map(Number);
  return { y: y ?? 1970, m: (m ?? 1) - 1, d: d ?? 1 };
}
function ymd(y: number, m: number, d: number): string {
  return `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
function daysIn(y: number, m: number): number {
  return new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
}
function firstWeekday(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 1)).getUTCDay();
}
function shiftMonth(y: number, m: number, delta: number): { y: number; m: number } {
  const t = new Date(Date.UTC(y, m + delta, 1));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() };
}
function fmtDay(s: string): string {
  const { y, m, d } = parse(s);
  return `${MONTHS[m]?.slice(0, 3)} ${d}, ${y}`;
}
function fullDayLabel(s: string): string {
  const { y, m, d } = parse(s);
  const wd = WEEKDAY_NAMES[new Date(Date.UTC(y, m, d)).getUTCDay()];
  return `${wd}, ${d} ${MONTHS[m]} ${y}`;
}
function rangeLabel(r: DateRange): string {
  if (r.from === r.to) return fmtDay(r.from);
  return `${fmtDay(r.from)} – ${fmtDay(r.to)}`;
}
/** Add/subtract whole calendar days from a YYYY-MM-DD string. */
function addDays(s: string, delta: number): string {
  const { y, m, d } = parse(s);
  const t = new Date(Date.UTC(y, m, d + delta));
  return ymd(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate());
}

/** A KNN-themed date-range picker: quick presets + a dual-month calendar. */
export function DateRangePicker({
  value,
  onChange,
  max = currentBusinessDay(),
}: {
  value: DateRange;
  onChange: (r: DateRange) => void;
  max?: string;
}): React.ReactNode {
  const [open, setOpen] = useState(false);
  const [sel, setSel] = useState<{ start: string; end: string | null }>({ start: value.from, end: value.to });
  const [view, setView] = useState<{ y: number; m: number }>(() => {
    const p = parse(value.to);
    return { y: p.y, m: p.m };
  }); // the RIGHT-hand month
  // The day that currently holds tabindex=0 within the grid (roving tabindex).
  const [focusDay, setFocusDay] = useState<string>(value.to);
  const ref = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const pendingFocus = useRef(false);

  // Reset the working selection + view whenever we (re)open or the value changes.
  useEffect(() => {
    if (open) {
      setSel({ start: value.from, end: value.to });
      setFocusDay(value.to);
      const p = parse(value.to);
      setView({ y: p.y, m: p.m });
      pendingFocus.current = true;
    }
  }, [open, value.from, value.to]);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Move focus into the calendar grid when it opens.
  useEffect(() => {
    if (!open || !pendingFocus.current) return;
    pendingFocus.current = false;
    const el = gridRef.current?.querySelector<HTMLButtonElement>(`button[data-day="${focusDay}"]`);
    el?.focus();
  }, [open, focusDay]);

  const today = currentBusinessDay();
  const tp = parse(today);
  const lastMonth = shiftMonth(tp.y, tp.m, -1);
  const presets: { label: string; range: DateRange }[] = [
    { label: 'Today', range: { from: today, to: today } },
    { label: 'Last 7 days', range: { from: addBusinessDays(today, -6), to: today } },
    { label: 'Last 30 days', range: { from: addBusinessDays(today, -29), to: today } },
    { label: 'Last 90 days', range: { from: addBusinessDays(today, -89), to: today } },
    { label: 'This month', range: { from: ymd(tp.y, tp.m, 1), to: today } },
    { label: 'Last month', range: { from: ymd(lastMonth.y, lastMonth.m, 1), to: ymd(lastMonth.y, lastMonth.m, daysIn(lastMonth.y, lastMonth.m)) } },
  ];

  const apply = (r: DateRange): void => {
    onChange(r);
    setOpen(false);
  };

  const clickDay = (s: string): void => {
    if (s > max) return;
    setSel((prev) => {
      if (prev.end !== null || s < prev.start) return { start: s, end: null };
      return { start: prev.start, end: s };
    });
  };

  // Roving-tabindex keyboard navigation across the (two-month) grid.
  const moveFocus = (next: string): void => {
    setFocusDay(next);
    const np = parse(next);
    // Keep the focused day visible: it lives in either the left (view-1) or right (view) month.
    const isVisible = (np.y === view.y && np.m === view.m) || ((): boolean => {
      const l = shiftMonth(view.y, view.m, -1);
      return np.y === l.y && np.m === l.m;
    })();
    if (!isVisible) {
      // Show the focused day in the RIGHT-hand month.
      setView({ y: np.y, m: np.m });
    }
    // Focus the corresponding button after the DOM updates.
    requestAnimationFrame(() => {
      const el = ref.current?.querySelector<HTMLButtonElement>(`button[data-day="${next}"]`);
      el?.focus();
    });
  };

  const onGridKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    let next: string | null = null;
    switch (e.key) {
      case 'ArrowLeft':
        next = addDays(focusDay, -1);
        break;
      case 'ArrowRight':
        next = addDays(focusDay, 1);
        break;
      case 'ArrowUp':
        next = addDays(focusDay, -7);
        break;
      case 'ArrowDown':
        next = addDays(focusDay, 7);
        break;
      case 'Home': {
        const p = parse(focusDay);
        next = ymd(p.y, p.m, 1);
        break;
      }
      case 'End': {
        const p = parse(focusDay);
        next = ymd(p.y, p.m, daysIn(p.y, p.m));
        break;
      }
      case 'PageUp': {
        const p = parse(focusDay);
        const sm = shiftMonth(p.y, p.m, -1);
        next = ymd(sm.y, sm.m, Math.min(p.d, daysIn(sm.y, sm.m)));
        break;
      }
      case 'PageDown': {
        const p = parse(focusDay);
        const sm = shiftMonth(p.y, p.m, 1);
        next = ymd(sm.y, sm.m, Math.min(p.d, daysIn(sm.y, sm.m)));
        break;
      }
      case 'Enter':
      case ' ':
        e.preventDefault();
        clickDay(focusDay);
        return;
      case 'Escape':
        e.preventDefault();
        setOpen(false);
        return;
      default:
        return;
    }
    if (next) {
      e.preventDefault();
      if (next > max) next = max;
      moveFocus(next);
    }
  };

  const lo = sel.start;
  const hi = sel.end ?? sel.start;

  const renderMonth = (y: number, m: number): React.ReactNode => {
    const cells: React.ReactNode[] = [];
    const lead = firstWeekday(y, m);
    for (let i = 0; i < lead; i++) cells.push(<span key={`x${i}`} className={styles.empty} aria-hidden />);
    for (let d = 1; d <= daysIn(y, m); d++) {
      const s = ymd(y, m, d);
      const disabled = s > max;
      const inRange = s >= lo && s <= hi;
      const isStart = s === sel.start;
      const isEnd = s === (sel.end ?? sel.start);
      const isEndpoint = isStart || isEnd;
      cells.push(
        <button
          key={s}
          type="button"
          data-day={s}
          disabled={disabled}
          tabIndex={s === focusDay ? 0 : -1}
          aria-label={fullDayLabel(s)}
          aria-pressed={isEndpoint}
          aria-selected={isEndpoint}
          className={`${styles.day} ${inRange ? styles.inRange : ''} ${isEndpoint ? styles.endpoint : ''}`}
          onClick={() => clickDay(s)}
          onFocus={() => setFocusDay(s)}
        >
          {d}
        </button>,
      );
    }
    return (
      <div className={styles.month}>
        <div className={styles.monthName}>
          {MONTHS[m]} {y}
        </div>
        <div className={styles.weekdays} aria-hidden>
          {WEEKDAYS.map((w, i) => (
            <span key={i}>{w}</span>
          ))}
        </div>
        <div className={styles.grid} role="grid" aria-label={`${MONTHS[m]} ${y}`}>
          {cells}
        </div>
      </div>
    );
  };

  const left = shiftMonth(view.y, view.m, -1);

  return (
    <div className={styles.wrap} ref={ref}>
      <button
        type="button"
        className={styles.trigger}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Date range: ${rangeLabel(value)}`}
      >
        <span className={styles.calIcon} aria-hidden>
          ▦
        </span>
        {rangeLabel(value)}
        <span className={styles.chevron} aria-hidden>
          ▾
        </span>
      </button>

      {open && (
        <div className={styles.panel} role="dialog" aria-label="Choose a date range" aria-modal="false">
          <div className={styles.presets}>
            {presets.map((p) => {
              const active = value.from === p.range.from && value.to === p.range.to;
              return (
                <button
                  key={p.label}
                  type="button"
                  className={`${styles.preset} ${active ? styles.presetActive : ''}`}
                  aria-pressed={active}
                  onClick={() => apply(p.range)}
                >
                  {p.label}
                </button>
              );
            })}
          </div>

          <div className={styles.calendar}>
            <div className={styles.calHead}>
              <button type="button" className={styles.nav} onClick={() => setView((v) => shiftMonth(v.y, v.m, -1))} aria-label="Previous month">
                ‹
              </button>
              <span className={styles.selLabel} role="status" aria-live="polite">
                {sel.end ? rangeLabel({ from: sel.start, to: sel.end }) : `${fmtDay(sel.start)} → pick end`}
              </span>
              <button type="button" className={styles.nav} onClick={() => setView((v) => shiftMonth(v.y, v.m, 1))} aria-label="Next month">
                ›
              </button>
            </div>
            <div className={styles.months} ref={gridRef} onKeyDown={onGridKeyDown}>
              {renderMonth(left.y, left.m)}
              {renderMonth(view.y, view.m)}
            </div>
            <div className={styles.footer}>
              <button type="button" className={styles.cancel} onClick={() => setOpen(false)}>
                Cancel
              </button>
              <button type="button" className={styles.apply} onClick={() => apply({ from: sel.start, to: sel.end ?? sel.start })}>
                Apply
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
