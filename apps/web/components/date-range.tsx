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
function rangeLabel(r: DateRange): string {
  if (r.from === r.to) return fmtDay(r.from);
  return `${fmtDay(r.from)} – ${fmtDay(r.to)}`;
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
  const ref = useRef<HTMLDivElement>(null);

  // Reset the working selection + view whenever we (re)open or the value changes.
  useEffect(() => {
    if (open) {
      setSel({ start: value.from, end: value.to });
      const p = parse(value.to);
      setView({ y: p.y, m: p.m });
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

  const lo = sel.start;
  const hi = sel.end ?? sel.start;

  const renderMonth = (y: number, m: number): React.ReactNode => {
    const cells: React.ReactNode[] = [];
    const lead = firstWeekday(y, m);
    for (let i = 0; i < lead; i++) cells.push(<span key={`x${i}`} className={styles.empty} />);
    for (let d = 1; d <= daysIn(y, m); d++) {
      const s = ymd(y, m, d);
      const disabled = s > max;
      const inRange = s >= lo && s <= hi;
      const isStart = s === sel.start;
      const isEnd = s === (sel.end ?? sel.start);
      cells.push(
        <button
          key={s}
          type="button"
          disabled={disabled}
          className={`${styles.day} ${inRange ? styles.inRange : ''} ${isStart || isEnd ? styles.endpoint : ''}`}
          onClick={() => clickDay(s)}
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
        <div className={styles.weekdays}>
          {WEEKDAYS.map((w, i) => (
            <span key={i}>{w}</span>
          ))}
        </div>
        <div className={styles.grid}>{cells}</div>
      </div>
    );
  };

  const left = shiftMonth(view.y, view.m, -1);

  return (
    <div className={styles.wrap} ref={ref}>
      <button type="button" className={styles.trigger} onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className={styles.calIcon} aria-hidden>
          ▦
        </span>
        {rangeLabel(value)}
        <span className={styles.chevron} aria-hidden>
          ▾
        </span>
      </button>

      {open && (
        <div className={styles.panel} role="dialog" aria-label="Choose a date range">
          <div className={styles.presets}>
            {presets.map((p) => {
              const active = value.from === p.range.from && value.to === p.range.to;
              return (
                <button key={p.label} type="button" className={`${styles.preset} ${active ? styles.presetActive : ''}`} onClick={() => apply(p.range)}>
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
              <span className={styles.selLabel}>{sel.end ? rangeLabel({ from: sel.start, to: sel.end }) : `${fmtDay(sel.start)} → pick end`}</span>
              <button type="button" className={styles.nav} onClick={() => setView((v) => shiftMonth(v.y, v.m, 1))} aria-label="Next month">
                ›
              </button>
            </div>
            <div className={styles.months}>
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
