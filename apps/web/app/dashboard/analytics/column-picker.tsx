'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { COLUMNS, COLUMN_PRESETS, type ColKey, GROUPS, type GroupKey, type NetworkTag, relabel } from './columns';
import styles from '../analytics.module.css';

/**
 * "Columns" menu: one-click presets (Essentials / Funnel / Facebook / All) plus a checkbox per
 * metric, grouped like the table header. Closes on outside click and Escape; focus returns to the
 * trigger. The page persists the choice per browser.
 */
export function ColumnPicker({ value, onChange, tag = 'FB' }: { value: ColKey[]; onChange: (cols: ColKey[]) => void; /** Which ad network(s) the rows in view come from: the network-sourced columns are named after it. */ tag?: NetworkTag }) {
  const [open, setOpen] = useState(false);
  // Open toward the side with room: the trigger can sit at either end of a wrapping toolbar.
  const [alignRight, setAlignRight] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const selected = new Set(value);
  // Preserve the order boxes were ticked in: append on check, drop in place on uncheck.
  const toggle = (k: ColKey): void => {
    onChange(selected.has(k) ? value.filter((c) => c !== k) : [...value, k]);
  };
  const activePreset = COLUMN_PRESETS.find((p) => p.columns.length === value.length && p.columns.every((c) => selected.has(c)));
  const groups = (Object.keys(GROUPS) as GroupKey[]).map((g) => ({ g, cols: COLUMNS.filter((c) => c.group === g) })).filter((x) => x.cols.length);

  return (
    <div className={styles.pickerRoot} ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className={styles.toolBtn}
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => {
          const r = triggerRef.current?.getBoundingClientRect();
          if (r) setAlignRight(r.left + Math.min(560, window.innerWidth - 32) > window.innerWidth - 16);
          setOpen((o) => !o);
        }}
      >
        Columns
        <span className={styles.toolBtnMeta}>{activePreset ? relabel(activePreset.label, tag) : `${value.length} shown`}</span>
      </button>
      {open && (
        <div id={panelId} className={`${styles.pickerPanel} ${alignRight ? styles.pickerPanelRight : ''}`} role="dialog" aria-label="Choose columns">
          <div className={styles.pickerPresets} role="group" aria-label="Presets">
            {COLUMN_PRESETS.map((p) => (
              <button
                key={p.id}
                type="button"
                className={`${styles.pickerPreset} ${activePreset?.id === p.id ? styles.pickerPresetActive : ''}`}
                aria-pressed={activePreset?.id === p.id}
                onClick={() => onChange(p.columns)}
              >
                {relabel(p.label, tag)}
              </button>
            ))}
          </div>
          <div className={styles.pickerGroups}>
            {groups.map(({ g, cols }) => (
              <fieldset key={g} className={styles.pickerGroup}>
                <legend className={styles.pickerLegend}>{relabel(GROUPS[g].label, tag) || 'Controls'}</legend>
                {cols.map((c) => (
                  <label key={c.key} className={styles.pickerItem}>
                    <input type="checkbox" checked={selected.has(c.key)} onChange={() => toggle(c.key)} />
                    <span>{relabel(c.label, tag)}</span>
                  </label>
                ))}
              </fieldset>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
