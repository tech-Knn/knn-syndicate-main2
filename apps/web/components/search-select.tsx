'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';
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
  const [activeIndex, setActiveIndex] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const baseId = useId().replace(/:/g, '');
  const listId = `${baseId}-listbox`;
  const optionId = (i: number): string => `${baseId}-opt-${i}`;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('mousedown', onDown);
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

  // On open and on every filter change, point the active option at the currently-selected
  // value (or the first row). This keeps activeIndex in bounds as the list grows/shrinks.
  useEffect(() => {
    if (!open) return;
    const selIdx = filtered.findIndex((o) => o.value === value);
    setActiveIndex(selIdx >= 0 ? selIdx : 0);
  }, [open, filtered, value]);

  // Scroll the active option into view as it moves.
  useEffect(() => {
    if (!open || filtered.length === 0) return;
    const el = listRef.current?.querySelector(`#${optionId(activeIndex)}`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, open, filtered.length]);

  const choose = (opt: SearchOption | undefined): void => {
    if (!opt) return;
    onChange(opt.value);
    setOpen(false);
  };

  const onSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        if (filtered.length > 0) setActiveIndex((i) => Math.min(i + 1, filtered.length - 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        if (filtered.length > 0) setActiveIndex((i) => Math.max(i - 1, 0));
        break;
      case 'Home':
        e.preventDefault();
        if (filtered.length > 0) setActiveIndex(0);
        break;
      case 'End':
        e.preventDefault();
        if (filtered.length > 0) setActiveIndex(filtered.length - 1);
        break;
      case 'Enter':
        e.preventDefault();
        choose(filtered[activeIndex]);
        break;
      case 'Escape':
        e.preventDefault();
        setOpen(false);
        break;
      default:
        break;
    }
  };

  const activeId = open && filtered.length > 0 ? optionId(activeIndex) : undefined;

  return (
    <div className={styles.wrap} ref={ref}>
      <button
        type="button"
        className={styles.trigger}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => !disabled && setOpen((o) => !o)}
      >
        <span className={selected ? styles.value : styles.placeholder}>{selected ? selected.label : placeholder}</span>
        <span className={styles.chevron} aria-hidden>
          ▾
        </span>
      </button>

      {open && !disabled && (
        <div className={styles.panel}>
          <input
            className={styles.search}
            autoFocus
            type="text"
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={open}
            aria-controls={listId}
            aria-activedescendant={activeId}
            aria-label="Search options"
            placeholder="Type to search…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onSearchKeyDown}
          />
          <div className={styles.list} ref={listRef} role="listbox" id={listId}>
            {filtered.length === 0 ? (
              <div className={styles.empty}>{options.length === 0 ? emptyText : 'No matches.'}</div>
            ) : (
              filtered.map((o, i) => (
                <div
                  key={o.value}
                  id={optionId(i)}
                  role="option"
                  aria-selected={o.value === value}
                  className={`${styles.item} ${o.value === value ? styles.itemActive : ''} ${i === activeIndex ? styles.itemFocus : ''}`}
                  onClick={() => choose(o)}
                  onMouseEnter={() => setActiveIndex(i)}
                >
                  <span className={styles.itemLabel}>{o.label}</span>
                  {o.sublabel && <span className={styles.itemSub}>{o.sublabel}</span>}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
