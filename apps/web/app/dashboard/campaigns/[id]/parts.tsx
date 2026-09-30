'use client';

import Link from 'next/link';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { IconCheck, IconCopy, IconImage, IconMore } from '@/components/icons';
import { uploads } from '@/lib/api';
import { Spinner } from '@/components/ui';
import styles from './campaign.module.css';
import type { StatusMeta, Tone } from './status';

export const toneClass = (t: Tone): string => styles[`tone-${t}`] ?? '';

export function StatusPill({ meta }: { meta: StatusMeta }) {
  return (
    <span className={`${styles.pill} ${toneClass(meta.tone)} ${meta.live ? styles.pillLive : ''}`}>
      <span className={styles.pillDot} aria-hidden />
      {meta.label}
    </span>
  );
}

export function Chip({ icon, children, mono, title }: { icon?: ReactNode; children: ReactNode; mono?: boolean; title?: string }) {
  return (
    <span className={`${styles.chip} ${mono ? styles.chipMono : ''}`} title={title}>
      {icon}
      {children}
    </span>
  );
}

/** Copy to the clipboard, with a check mark for a moment. Falls back to selecting nothing quietly if the browser refuses. */
export function CopyButton({ value, label }: { value: string; label: string }) {
  const [done, setDone] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(value);
      setDone(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setDone(false), 1600);
    } catch {
      /* clipboard blocked: nothing useful to do */
    }
  }, [value]);
  return (
    <button type="button" className={styles.copyBtn} data-done={done} onClick={() => void copy()} aria-label={done ? `${label} copied` : `Copy ${label}`} title={done ? 'Copied' : `Copy ${label}`}>
      {done ? <IconCheck size={15} /> : <IconCopy size={15} />}
    </button>
  );
}

export function CopyField({ value, label }: { value: string; label: string }) {
  return (
    <div className={styles.copyField}>
      <span className={styles.copyText} title={value}>
        {value}
      </span>
      <CopyButton value={value} label={label} />
    </div>
  );
}

/* ------------------------------------------------------------------ Menu */

export interface MenuEntry {
  key: string;
  label: string;
  icon?: ReactNode;
  onSelect?: () => void;
  href?: string;
  external?: boolean;
  disabled?: boolean;
  separatorBefore?: boolean;
}

/** A small "more actions" popover: closes on outside click, Escape and selection; arrow keys move between items. */
export function Menu({ entries, label = 'More actions' }: { entries: MenuEntry[]; label?: string }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
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

  const move = (dir: 1 | -1): void => {
    const items = Array.from(wrap.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? []);
    if (!items.length) return;
    const at = items.indexOf(document.activeElement as HTMLElement);
    items[(at + dir + items.length) % items.length]?.focus();
  };

  return (
    <div className={styles.menuWrap} ref={wrap}>
      <button
        type="button"
        className={styles.menuBtn}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        title={label}
        onClick={() => setOpen((o) => !o)}
      >
        <IconMore size={18} />
      </button>
      {open && (
        <div
          className={styles.menu}
          role="menu"
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              move(1);
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              move(-1);
            }
          }}
        >
          {entries.map((m) => (
            <div key={m.key}>
              {m.separatorBefore && <div className={styles.menuSep} role="separator" />}
              {m.href ? (
                <Link
                  href={m.href}
                  className={styles.menuItem}
                  role="menuitem"
                  {...(m.external ? { target: '_blank', rel: 'noreferrer' } : {})}
                  onClick={() => setOpen(false)}
                >
                  {m.icon}
                  {m.label}
                </Link>
              ) : (
                <button
                  type="button"
                  className={styles.menuItem}
                  role="menuitem"
                  disabled={m.disabled}
                  onClick={() => {
                    setOpen(false);
                    m.onSelect?.();
                  }}
                >
                  {m.icon}
                  {m.label}
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ Tabs */

export interface TabDef<T extends string> {
  id: T;
  label: string;
  count?: number;
}

export function Tabs<T extends string>({ tabs, value, onChange, idPrefix, trailing }: { tabs: TabDef<T>[]; value: T; onChange: (t: T) => void; idPrefix: string; trailing?: ReactNode }) {
  const onKeyDown = (e: React.KeyboardEvent): void => {
    const idx = tabs.findIndex((t) => t.id === value);
    let next = -1;
    if (e.key === 'ArrowRight') next = (idx + 1) % tabs.length;
    else if (e.key === 'ArrowLeft') next = (idx - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = tabs.length - 1;
    if (next < 0) return;
    e.preventDefault();
    const t = tabs[next];
    if (t) {
      onChange(t.id);
      document.getElementById(`${idPrefix}-tab-${t.id}`)?.focus();
    }
  };
  return (
    <div className={styles.tabsBar} role="tablist" aria-label="Campaign sections" onKeyDown={onKeyDown}>
      {tabs.map((t) => (
        <button
          key={t.id}
          id={`${idPrefix}-tab-${t.id}`}
          type="button"
          role="tab"
          className={styles.tab}
          aria-selected={t.id === value}
          aria-controls={`${idPrefix}-panel-${t.id}`}
          tabIndex={t.id === value ? 0 : -1}
          onClick={() => onChange(t.id)}
        >
          {t.label}
          {t.count != null && <span className={styles.tabCount}>{t.count}</span>}
        </button>
      ))}
      {trailing && <div className={styles.tabsTrail}>{trailing}</div>}
    </div>
  );
}

/* --------------------------------------------------------------- Creative */

const blobCache = new Map<string, Promise<string | null>>();

function creativeUrl(uploadId: string): Promise<string | null> {
  let p = blobCache.get(uploadId);
  if (!p) {
    p = uploads
      .image(uploadId)
      .then((b) => URL.createObjectURL(b))
      .catch(() => null);
    blobCache.set(uploadId, p);
  }
  return p;
}

/** An ad's creative image, fetched with the session (it is private) and cached for the page's life. A video or a
 *  file that is gone shows a neutral placeholder instead of a broken image. */
export function Creative({ uploadId, kind, alt }: { uploadId: string | null; kind: 'IMAGE' | 'VIDEO'; alt: string }) {
  const [src, setSrc] = useState<string | null | undefined>(uploadId && kind === 'IMAGE' ? undefined : null);
  useEffect(() => {
    let alive = true;
    if (!uploadId || kind !== 'IMAGE') {
      setSrc(null);
      return;
    }
    setSrc(undefined);
    void creativeUrl(uploadId).then((u) => alive && setSrc(u));
    return () => {
      alive = false;
    };
  }, [uploadId, kind]);

  if (src) {
    return <img src={src} alt={alt} loading="lazy" />;
  }
  return (
    <div className={styles.adMediaEmpty}>
      {src === undefined ? <Spinner /> : <IconImage size={26} />}
      <span>{src === undefined ? 'Loading creative' : kind === 'VIDEO' ? 'Video creative' : 'No preview'}</span>
    </div>
  );
}
