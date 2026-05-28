'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import styles from './search-select.module.css';

export interface SearchOption {
  value: string;
  label: string;
  sublabel?: string;
}

/** A searchable single-select (combobox) — for long lists (ad accounts, pages, …). */
export function SearchSelect({
  value,
  onChange,
  options,
  placeholder = 'Select…',
  disabled = false,
  emptyText = 'No matches.',
}: {
  value: string;
  onChange: (value: string) => void;
  options: SearchOption[];
  placeholder?: string;
  disabled?: boolean;
  emptyText?: string;
}): React.ReactNode {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const ref = useRef<HTMLDivElement>(null);

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

  useEffect(() => {
    if (open) setQ('');
  }, [open]);

  const selected = options.find((o) => o.value === value) ?? null;
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return options;
    return options.filter((o) => `${o.label} ${o.sublabel ?? ''}`.toLowerCase().includes(needle));
  }, [q, options]);

  return (
    <div className={styles.wrap} ref={ref}>
      <button
        type="button"
        className={styles.trigger}
        disabled={disabled}
        aria-expanded={open}
        onClick={() => !disabled && setOpen((o) => !o)}
      >
        <span className={selected ? styles.value : styles.placeholder}>{selected ? selected.label : placeholder}</span>
        <span className={styles.chevron} aria-hidden>
          ▾
        </span>
      </button>

      {open && !disabled && (
        <div className={styles.panel} role="listbox">
          <input
            className={styles.search}
            autoFocus
            placeholder="Type to search…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <div className={styles.list}>
            {filtered.length === 0 ? (
              <div className={styles.empty}>{options.length === 0 ? emptyText : 'No matches.'}</div>
            ) : (
              filtered.map((o) => (
                <button
                  key={o.value}
                  type="button"
                  role="option"
                  aria-selected={o.value === value}
                  className={`${styles.item} ${o.value === value ? styles.itemActive : ''}`}
                  onClick={() => {
                    onChange(o.value);
                    setOpen(false);
                  }}
                >
                  <span className={styles.itemLabel}>{o.label}</span>
                  {o.sublabel && <span className={styles.itemSub}>{o.sublabel}</span>}
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
