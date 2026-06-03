'use client';

import { useEffect, useId, useRef, useState } from 'react';
import cal from './date-range.module.css';
import s from './date-time.module.css';

/**
 * A single date + time picker (replaces the clunky native <input type="datetime-local">). The calendar
 * matches the KNN DateRangePicker; time is a simple HH:mm field. Keyboard-accessible (roving tabindex).
 *
 * `value`/`onChange` use a LOCAL wall-clock string "YYYY-MM-DDTHH:mm" (same shape datetime-local emits),
 * so the caller's existing local→UTC conversion on submit (`new Date(value).toISOString()`) is unchanged.
 * `min` (optional, same format) blocks earlier dates/times — used to keep End ≥ Start.
 */
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function parseD(str: string): { y: number; m: number; d: number } {
  const [y, m, d] = str.split('-').map(Number);
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
function addDays(str: string, delta: number): string {
  const { y, m, d } = parseD(str);
  const t = new Date(Date.UTC(y, m, d + delta));
  return ymd(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate());
}
function todayYmd(): string {
  const n = new Date();
  return ymd(n.getFullYear(), n.getMonth(), n.getDate());
}
/** "YYYY-MM-DDTHH:mm" → { date, time } (date '' when unset). */
function split(value: string): { date: string; time: string } {
  if (!value) return { date: '', time: '' };
  const [date = '', time = ''] = value.split('T');
  return { date, time: time.slice(0, 5) };
}
function fmtTrigger(value: string): string {
  const { date, time } = split(value);
  if (!date) return '';
  const { y, m, d } = parseD(date);
  return `${MONTHS[m]?.slice(0, 3) ?? '?'} ${d}, ${y}${time ? ` · ${time}` : ''}`;
}
function fullDayLabel(str: string): string {
  const { y, m, d } = parseD(str);
  const wd = WEEKDAY_NAMES[new Date(Date.UTC(y, m, d)).getUTCDay()];
  return `${wd}, ${d} ${MONTHS[m]} ${y}`;
}

export function DateTimePicker({
  value,
  onChange,
  min,
  ariaLabel,
  placeholder = 'Pick a date & time',
}: {
  value: string;
  onChange: (v: string) => void;
  /** Earliest allowed value (local "YYYY-MM-DDTHH:mm"); earlier days are disabled. */
  min?: string;
  ariaLabel?: string;
  placeholder?: string;
}): React.ReactNode {
  const [open, setOpen] = useState(false);
  const [sel, setSel] = useState<{ date: string; time: string }>(() => split(value));
  const [view, setView] = useState<{ y: number; m: number }>(() => {
    const d = split(value).date || todayYmd();
    const p = parseD(d);
    return { y: p.y, m: p.m };
  });
  const [focusDay, setFocusDay] = useState<string>(() => split(value).date || todayYmd());
  const ref = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const pendingFocus = useRef(false);
  const timeId = useId();

  const minDate = min ? split(min).date : '';
  const minTime = min ? split(min).time : '';

  // (Re)seed the working state whenever we open or the value changes.
  useEffect(() => {
    if (!open) return;
    const cur = split(value);
    const start = cur.date || todayYmd();
    setSel({ date: cur.date, time: cur.time || '12:00' });
    setFocusDay(start);
    const p = parseD(start);
    setView({ y: p.y, m: p.m });
    pendingFocus.current = true;
  }, [open, value]);

  // Close on outside-click / Escape.
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

  // Move focus into the grid when opened.
  useEffect(() => {
    if (!open || !pendingFocus.current) return;
    pendingFocus.current = false;
    gridRef.current?.querySelector<HTMLButtonElement>(`button[data-day="${focusDay}"]`)?.focus();
  }, [open, focusDay]);

  const disabledDay = (day: string): boolean => Boolean(minDate) && day < minDate;

  const pickDay = (day: string): void => {
    if (disabledDay(day)) return;
    setSel((prev) => ({ date: day, time: prev.time || '12:00' }));
  };

  const moveFocus = (next: string): void => {
    setFocusDay(next);
    const np = parseD(next);
    const visible = np.y === view.y && np.m === view.m;
    if (!visible) setView({ y: np.y, m: np.m });
    requestAnimationFrame(() => ref.current?.querySelector<HTMLButtonElement>(`button[data-day="${next}"]`)?.focus());
  };

  const onGridKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    let next: string | null = null;
    switch (e.key) {
      case 'ArrowLeft': next = addDays(focusDay, -1); break;
      case 'ArrowRight': next = addDays(focusDay, 1); break;
      case 'ArrowUp': next = addDays(focusDay, -7); break;
      case 'ArrowDown': next = addDays(focusDay, 7); break;
      case 'Home': { const p = parseD(focusDay); next = ymd(p.y, p.m, 1); break; }
      case 'End': { const p = parseD(focusDay); next = ymd(p.y, p.m, daysIn(p.y, p.m)); break; }
      case 'PageUp': { const p = parseD(focusDay); const sm = shiftMonth(p.y, p.m, -1); next = ymd(sm.y, sm.m, Math.min(p.d, daysIn(sm.y, sm.m))); break; }
      case 'PageDown': { const p = parseD(focusDay); const sm = shiftMonth(p.y, p.m, 1); next = ymd(sm.y, sm.m, Math.min(p.d, daysIn(sm.y, sm.m))); break; }
      case 'Enter':
      case ' ':
        e.preventDefault();
        pickDay(focusDay);
        return;
      default:
        return;
    }
    if (next) {
      e.preventDefault();
      if (minDate && next < minDate) next = minDate;
      moveFocus(next);
    }
  };

  const apply = (): void => {
    if (!sel.date) return;
    onChange(`${sel.date}T${sel.time || '12:00'}`);
    setOpen(false);
  };
  const clear = (): void => {
    onChange('');
    setOpen(false);
  };

  const renderMonth = (): React.ReactNode => {
    const { y, m } = view;
    const cells: React.ReactNode[] = [];
    const lead = firstWeekday(y, m);
    for (let i = 0; i < lead; i++) cells.push(<span key={`x${i}`} className={cal.empty} aria-hidden />);
    for (let d = 1; d <= daysIn(y, m); d++) {
      const day = ymd(y, m, d);
      const isSel = day === sel.date;
      const disabled = disabledDay(day);
      cells.push(
        <button
          key={day}
          type="button"
          data-day={day}
          disabled={disabled}
          tabIndex={day === focusDay ? 0 : -1}
          aria-label={fullDayLabel(day)}
          aria-pressed={isSel}
          className={`${cal.day} ${isSel ? cal.endpoint : ''}`}
          onClick={() => pickDay(day)}
          onFocus={() => setFocusDay(day)}
        >
          {d}
        </button>,
      );
    }
    return (
      <div className={cal.grid} role="grid" aria-label={`${MONTHS[m]} ${y}`} ref={gridRef} onKeyDown={onGridKeyDown}>
        {cells}
      </div>
    );
  };

  const sameDayAsMin = Boolean(minDate) && sel.date === minDate;

  return (
    <div className={s.wrap} ref={ref}>
      <button
        type="button"
        className={s.trigger}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={ariaLabel ?? (value ? `Date & time: ${fmtTrigger(value)}` : placeholder)}
      >
        <span className={s.left}>
          <span className={s.calIcon} aria-hidden>▦</span>
          {value ? <span className={s.value}>{fmtTrigger(value)}</span> : <span className={s.placeholder}>{placeholder}</span>}
        </span>
        {value && (
          <span
            role="button"
            tabIndex={0}
            className={s.clearX}
            aria-label="Clear date & time"
            onClick={(e) => { e.stopPropagation(); clear(); }}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); clear(); } }}
          >
            ×
          </span>
        )}
      </button>

      {open && (
        <div className={s.panel} role="dialog" aria-label="Choose a date and time" aria-modal="false">
          <div className={cal.calendar}>
            <div className={cal.calHead}>
              <button type="button" className={cal.nav} onClick={() => setView((v) => shiftMonth(v.y, v.m, -1))} aria-label="Previous month">‹</button>
              <span className={cal.monthName}>{MONTHS[view.m]} {view.y}</span>
              <button type="button" className={cal.nav} onClick={() => setView((v) => shiftMonth(v.y, v.m, 1))} aria-label="Next month">›</button>
            </div>
            <div className={cal.weekdays} aria-hidden>
              {WEEKDAYS.map((w, i) => (<span key={i}>{w}</span>))}
            </div>
            {renderMonth()}

            <div className={s.timeRow}>
              <label className={s.timeLabel} htmlFor={timeId}>Time</label>
              <input
                id={timeId}
                type="time"
                className={s.timeInput}
                value={sel.time}
                min={sameDayAsMin ? minTime : undefined}
                onChange={(e) => setSel((prev) => ({ ...prev, time: e.target.value }))}
              />
            </div>
            <p className={s.hint}>Your local timezone.</p>

            <div className={cal.footer}>
              <button type="button" className={cal.cancel} onClick={clear}>Clear</button>
              <button type="button" className={cal.apply} onClick={apply} disabled={!sel.date}>Apply</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
