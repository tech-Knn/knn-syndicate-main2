'use client';

import { type ComponentType, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { IconSearch } from './icons';
import styles from './command-palette.module.css';

export interface Command {
  id: string;
  label: string;
  /** Small right-aligned context, e.g. a section name. */
  hint?: string;
  /** Extra search terms (not shown). */
  keywords?: string;
  href?: string;
  action?: () => void;
  Icon?: ComponentType<{ size?: number }>;
}

/**
 * ⌘K / Ctrl-K command palette — jump to any page or run an action. Controlled by the parent
 * (open + onClose) so the topbar search button and the global shortcut can both drive it. Pure
 * navigation/actions over data the app already has — no new data flow.
 */
export function CommandPalette({
  open,
  onClose,
  commands,
}: {
  open: boolean;
  onClose: () => void;
  commands: Command[];
}) {
  const router = useRouter();
  const [q, setQ] = useState('');
  const [idx, setIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return commands;
    return commands.filter((c) => `${c.label} ${c.hint ?? ''} ${c.keywords ?? ''}`.toLowerCase().includes(s));
  }, [q, commands]);

  // Reset + focus on open.
  useEffect(() => {
    if (!open) return;
    setQ('');
    setIdx(0);
    const t = setTimeout(() => inputRef.current?.focus(), 10);
    return () => clearTimeout(t);
  }, [open]);

  useEffect(() => setIdx(0), [q]);

  // Keep the active item in view.
  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.children[idx] as HTMLElement | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  }, [idx, open]);

  if (!open) return null;

  const run = (c: Command | undefined) => {
    if (!c) return;
    onClose();
    if (c.href) router.push(c.href);
    else c.action?.();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setIdx((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      run(filtered[idx]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <div className={styles.overlay} role="dialog" aria-modal="true" aria-label="Command menu" onClick={onClose}>
      <div className={styles.palette} onClick={(e) => e.stopPropagation()}>
        <div className={styles.searchRow}>
          <span className={styles.searchIcon} aria-hidden>
            <IconSearch size={18} />
          </span>
          <input
            ref={inputRef}
            className={styles.input}
            placeholder="Search pages and actions…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKeyDown}
            aria-label="Search pages and actions"
            autoComplete="off"
            spellCheck={false}
          />
          <kbd className={styles.kbd}>Esc</kbd>
        </div>
        <ul ref={listRef} className={styles.list}>
          {filtered.length === 0 ? (
            <li className={styles.empty}>No matches for “{q}”</li>
          ) : (
            filtered.map((c, i) => (
              <li key={c.id}>
                <button
                  type="button"
                  className={`${styles.item} ${i === idx ? styles.itemActive : ''}`}
                  onMouseMove={() => setIdx(i)}
                  onClick={() => run(c)}
                >
                  {c.Icon ? (
                    <span className={styles.itemIcon} aria-hidden>
                      <c.Icon size={16} />
                    </span>
                  ) : (
                    <span className={styles.itemIcon} aria-hidden />
                  )}
                  <span className={styles.itemLabel}>{c.label}</span>
                  {c.hint && <span className={styles.itemHint}>{c.hint}</span>}
                </button>
              </li>
            ))
          )}
        </ul>
      </div>
    </div>
  );
}
