'use client';

import { type MouseEvent, useId, useRef, useState } from 'react';
import { type DailyPoint, formatUsd } from '@knn/shared';
import styles from './charts.module.css';

// Brand palette (mirrors globals.css tokens; SVG presentation attrs don't resolve var()).
const REVENUE = '#c89b3c'; // gold
const SPEND = '#d9512c'; // rust
const GRID = 'rgba(255,255,255,0.06)';

const W = 1000;

/** Build an SVG path: a line ("L") and the matching closed area ("A") down to the baseline. */
function paths(values: number[], max: number, h: number, padTop: number, padBottom: number) {
  const n = values.length;
  const innerH = h - padTop - padBottom;
  const x = (i: number): number => (n <= 1 ? W / 2 : (i / (n - 1)) * W);
  const y = (v: number): number => padTop + (1 - (max > 0 ? v / max : 0)) * innerH;
  const pts = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`);
  const line = pts.length ? `M${pts.join(' L')}` : '';
  const area = pts.length
    ? `M${x(0).toFixed(1)},${(h - padBottom).toFixed(1)} L${pts.join(' L')} L${x(n - 1).toFixed(1)},${(h - padBottom).toFixed(1)} Z`
    : '';
  return { line, area, x, y };
}

/** Revenue-vs-spend area chart with a hover guide + floating tooltip. */
export function RevenueChart({ series, height = 260 }: { series: DailyPoint[]; height?: number }) {
  const gid = useId().replace(/:/g, '');
  const wrapRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);

  const padTop = 14;
  const padBottom = 26;
  const max = Math.max(1, ...series.map((p) => Math.max(p.revenueUsd, p.spendUsd)));
  const rev = paths(series.map((p) => p.revenueUsd), max, height, padTop, padBottom);
  const spend = paths(series.map((p) => p.spendUsd), max, height, padTop, padBottom);
  const n = series.length;

  const onMove = (e: MouseEvent<HTMLDivElement>): void => {
    const el = wrapRef.current;
    if (!el || n === 0) return;
    const rect = el.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    setHover(Math.round(ratio * (n - 1)));
  };

  const hp = hover != null ? series[hover] : null;
  const hx = hover != null ? (n <= 1 ? 50 : (hover / (n - 1)) * 100) : 0;

  return (
    <div
      className={styles.chartWrap}
      ref={wrapRef}
      onMouseMove={onMove}
      onMouseLeave={() => setHover(null)}
      style={{ aspectRatio: `${W} / ${height}` }}
    >
      <svg viewBox={`0 0 ${W} ${height}`} preserveAspectRatio="none" className={styles.svg} aria-hidden>
        <defs>
          <linearGradient id={`rev-${gid}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={REVENUE} stopOpacity="0.32" />
            <stop offset="100%" stopColor={REVENUE} stopOpacity="0" />
          </linearGradient>
          <linearGradient id={`spend-${gid}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={SPEND} stopOpacity="0.22" />
            <stop offset="100%" stopColor={SPEND} stopOpacity="0" />
          </linearGradient>
        </defs>
        {/* gridlines */}
        {[0.25, 0.5, 0.75].map((g) => (
          <line key={g} x1="0" x2={W} y1={padTop + g * (height - padTop - padBottom)} y2={padTop + g * (height - padTop - padBottom)} stroke={GRID} strokeWidth="1" />
        ))}
        <path d={spend.area} fill={`url(#spend-${gid})`} />
        <path d={rev.area} fill={`url(#rev-${gid})`} />
        <path d={spend.line} fill="none" stroke={SPEND} strokeWidth="2" vectorEffect="non-scaling-stroke" />
        <path d={rev.line} fill="none" stroke={REVENUE} strokeWidth="2.25" vectorEffect="non-scaling-stroke" />
        {hover != null && hp && (
          <g>
            <line x1={rev.x(hover)} x2={rev.x(hover)} y1={padTop} y2={height - padBottom} stroke="rgba(255,255,255,0.18)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
            <circle cx={rev.x(hover)} cy={rev.y(hp.revenueUsd)} r="3.5" fill={REVENUE} />
            <circle cx={spend.x(hover)} cy={spend.y(hp.spendUsd)} r="3.5" fill={SPEND} />
          </g>
        )}
      </svg>

      {hover != null && hp && (
        <div
          className={styles.tip}
          style={{ left: `${hx}%`, transform: `translateX(${hx > 70 ? '-100%' : hx < 30 ? '0' : '-50%'})` }}
        >
          <div className={styles.tipDay}>{hp.day}</div>
          <div className={styles.tipRow}>
            <span className={styles.dotRev} /> Revenue <strong>{formatUsd(hp.revenueUsd)}</strong>
          </div>
          <div className={styles.tipRow}>
            <span className={styles.dotSpend} /> Spend <strong>{formatUsd(hp.spendUsd)}</strong>
          </div>
          <div className={styles.tipRow}>
            Profit <strong className={hp.profitUsd >= 0 ? styles.pos : styles.neg}>{formatUsd(hp.profitUsd)}</strong>
          </div>
        </div>
      )}
    </div>
  );
}

/** Tiny inline sparkline for KPI tiles. */
export function Sparkline({ values, tone = 'gold', height = 34 }: { values: number[]; tone?: 'gold' | 'rust' | 'green'; height?: number }) {
  const color = tone === 'rust' ? SPEND : tone === 'green' ? '#3fb27f' : REVENUE;
  const max = Math.max(1, ...values);
  const w = 120;
  const n = values.length;
  if (n === 0) return <svg viewBox={`0 0 ${w} ${height}`} className={styles.spark} aria-hidden />;
  const x = (i: number): number => (n <= 1 ? w / 2 : (i / (n - 1)) * w);
  const y = (v: number): number => 3 + (1 - v / max) * (height - 6);
  const line = `M${values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' L')}`;
  return (
    <svg viewBox={`0 0 ${w} ${height}`} preserveAspectRatio="none" className={styles.spark} aria-hidden>
      <path d={line} fill="none" stroke={color} strokeWidth="2" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
