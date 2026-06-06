'use client';

import { type CSSProperties, type MouseEvent, useId, useRef, useState } from 'react';
import { type DailyPoint, formatUsd } from '@knn/shared';
import styles from './charts.module.css';

/*
 * Paint is theme-aware: SVG presentation ATTRIBUTES can't resolve var(), but the CSS `stroke` /
 * `fill` / `stop-color` PROPERTIES (set via the `style` prop) can — so colours follow the token
 * layer in both light + dark. Revenue is the hero (brand indigo, filled area); spend is the
 * neutral dashed comparison line (also colour-blind-safe via the solid/dashed distinction).
 */
const REVENUE = 'var(--rust)'; // brand accent (indigo)
const SPEND = 'var(--muted-2)'; // neutral comparison
const stroke = (color: string, width: number, dash?: string): CSSProperties => ({
  stroke: color,
  strokeWidth: width,
  fill: 'none',
  ...(dash ? { strokeDasharray: dash } : {}),
});

const W = 1000;
const PAD_LEFT = 52; // reserve room for Y-axis $ labels

/** Build an SVG path: a line ("L") and the matching closed area ("A") down to the baseline. */
function paths(values: number[], max: number, h: number, padTop: number, padBottom: number) {
  const n = values.length;
  const innerH = h - padTop - padBottom;
  const innerW = W - PAD_LEFT;
  const x = (i: number): number => PAD_LEFT + (n <= 1 ? innerW / 2 : (i / (n - 1)) * innerW);
  const y = (v: number): number => padTop + (1 - (max > 0 ? v / max : 0)) * innerH;
  const pts = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`);
  const line = pts.length ? `M${pts.join(' L')}` : '';
  const area = pts.length
    ? `M${x(0).toFixed(1)},${(h - padBottom).toFixed(1)} L${pts.join(' L')} L${x(n - 1).toFixed(1)},${(h - padBottom).toFixed(1)} Z`
    : '';
  return { line, area, x, y };
}

/** Compact USD for axis ticks: $1.2k / $340 / $0. */
function tickUsd(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1000) return `$${(n / 1000).toFixed(abs >= 10000 ? 0 : 1)}k`;
  return `$${Math.round(n)}`;
}

/** Revenue-vs-spend area chart with a hover guide + floating tooltip. */
export function RevenueChart({ series, height = 260 }: { series: DailyPoint[]; height?: number }) {
  const gid = useId().replace(/:/g, '');
  const wrapRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);

  const padTop = 14;
  const padBottom = 26;
  const n = series.length;

  if (n === 0) {
    return (
      <div className={styles.empty} role="img" aria-label="No revenue in this range yet.">
        <span className={styles.emptyIcon} aria-hidden>
          ◔
        </span>
        <span className={styles.emptyTitle}>No data in this range</span>
        <span className={styles.emptyHint}>Revenue and spend will appear here once campaigns run.</span>
      </div>
    );
  }

  const max = Math.max(1, ...series.map((p) => Math.max(p.revenueUsd, p.spendUsd)));
  const rev = paths(series.map((p) => p.revenueUsd), max, height, padTop, padBottom);
  const spend = paths(series.map((p) => p.spendUsd), max, height, padTop, padBottom);
  const innerH = height - padTop - padBottom;

  // Y-axis ticks: baseline (0), quarters, top (max).
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((g) => ({
    g,
    value: max * (1 - g),
    y: padTop + g * innerH,
  }));

  // X-axis labels: first / middle / last day (avoids overlap on long ranges).
  const xLabelIdx = n === 1 ? [0] : [0, Math.floor((n - 1) / 2), n - 1];
  const lastIdx = n - 1;

  // Accessible summary of the revenue series for the chart's aria-label.
  const revVals = series.map((p) => p.revenueUsd);
  const minRev = Math.min(...revVals);
  const maxRev = Math.max(...revVals);
  const latest = series[lastIdx]!;
  const ariaLabel =
    `Revenue vs. spend over ${n} day${n === 1 ? '' : 's'}, ${series[0]!.day} to ${latest.day}. ` +
    `Revenue ranges from ${formatUsd(minRev)} to ${formatUsd(maxRev)}; ` +
    `latest day ${latest.day}: revenue ${formatUsd(latest.revenueUsd)}, spend ${formatUsd(latest.spendUsd)}, profit ${formatUsd(latest.profitUsd)}.`;

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
      role="img"
      aria-label={ariaLabel}
    >
      <svg viewBox={`0 0 ${W} ${height}`} preserveAspectRatio="none" className={styles.svg} aria-hidden>
        <defs>
          <linearGradient id={`rev-${gid}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" style={{ stopColor: REVENUE, stopOpacity: 0.2 }} />
            <stop offset="100%" style={{ stopColor: REVENUE, stopOpacity: 0 }} />
          </linearGradient>
        </defs>
        {/* gridlines (theme-aware border colour) */}
        {[0, 0.25, 0.5, 0.75, 1].map((g) => (
          <line
            key={g}
            x1={PAD_LEFT}
            x2={W}
            y1={padTop + g * innerH}
            y2={padTop + g * innerH}
            style={{ stroke: 'var(--border)', strokeWidth: 1 }}
          />
        ))}
        <path d={rev.area} fill={`url(#rev-${gid})`} />
        {/* Spend dashed + revenue solid → distinguishable without colour (colour-blind safe). */}
        <path d={spend.line} style={stroke(SPEND, 2, '5 4')} vectorEffect="non-scaling-stroke" />
        <path d={rev.line} style={stroke(REVENUE, 2.25)} vectorEffect="non-scaling-stroke" />
        {/* End-point markers: filled dot (revenue) vs hollow ring (spend). */}
        <circle cx={rev.x(lastIdx)} cy={rev.y(latest.revenueUsd)} r="3.5" style={{ fill: REVENUE }} />
        <circle cx={spend.x(lastIdx)} cy={spend.y(latest.spendUsd)} r="3.5" style={stroke(SPEND, 2)} vectorEffect="non-scaling-stroke" />
        {hover != null && hp && (
          <g>
            <line x1={rev.x(hover)} x2={rev.x(hover)} y1={padTop} y2={height - padBottom} style={{ stroke: 'var(--border-strong)', strokeWidth: 1 }} vectorEffect="non-scaling-stroke" />
            <circle cx={rev.x(hover)} cy={rev.y(hp.revenueUsd)} r="3.5" style={{ fill: REVENUE }} />
            <circle cx={spend.x(hover)} cy={spend.y(hp.spendUsd)} r="3.5" style={stroke(SPEND, 2)} vectorEffect="non-scaling-stroke" />
          </g>
        )}
      </svg>

      {/* Y-axis tick labels (HTML overlay so text isn't squashed by preserveAspectRatio="none"). */}
      <div className={styles.yAxis} aria-hidden>
        {yTicks.map((t) => (
          <span key={t.g} className={styles.yTick} style={{ top: `${(t.y / height) * 100}%` }}>
            {tickUsd(t.value)}
          </span>
        ))}
      </div>

      {/* X-axis day labels (first / middle / last). */}
      <div className={styles.xAxis} aria-hidden>
        {xLabelIdx.map((i) => {
          const pct = ((PAD_LEFT + (n <= 1 ? (W - PAD_LEFT) / 2 : (i / (n - 1)) * (W - PAD_LEFT))) / W) * 100;
          const align = i === 0 ? 'flex-start' : i === lastIdx ? 'flex-end' : 'center';
          const shift = i === 0 ? '0' : i === lastIdx ? '-100%' : '-50%';
          return (
            <span key={i} className={styles.xTick} style={{ left: `${pct}%`, transform: `translateX(${shift})`, justifyContent: align }}>
              {series[i]!.day}
            </span>
          );
        })}
      </div>

      {/* Legend: solid swatch (revenue) vs dashed swatch (spend) — reinforces the non-colour cue. */}
      <div className={styles.legend} aria-hidden>
        <span className={styles.legItem}>
          <span className={`${styles.swatch} ${styles.swatchRev}`} /> Revenue
        </span>
        <span className={styles.legItem}>
          <span className={`${styles.swatch} ${styles.swatchSpend}`} /> Spend
        </span>
      </div>

      {/* Visually-hidden data table — gives screen readers the full series (WCAG 1.1.1). */}
      <table className={styles.srOnly}>
        <caption>Daily revenue, spend, and profit</caption>
        <thead>
          <tr>
            <th scope="col">Day</th>
            <th scope="col">Revenue</th>
            <th scope="col">Spend</th>
            <th scope="col">Profit</th>
          </tr>
        </thead>
        <tbody>
          {series.map((p) => (
            <tr key={p.day}>
              <th scope="row">{p.day}</th>
              <td>{formatUsd(p.revenueUsd)}</td>
              <td>{formatUsd(p.spendUsd)}</td>
              <td>{formatUsd(p.profitUsd)}</td>
            </tr>
          ))}
        </tbody>
      </table>

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
export function Sparkline({
  values,
  tone = 'gold',
  height = 34,
  label,
}: {
  values: number[];
  tone?: 'gold' | 'rust' | 'green';
  height?: number;
  label?: string;
}) {
  const color = tone === 'rust' ? SPEND : tone === 'green' ? 'var(--green)' : REVENUE;
  const w = 120;
  const n = values.length;
  if (n === 0) return <svg viewBox={`0 0 ${w} ${height}`} className={styles.spark} aria-hidden />;

  // Domain spans both negatives and positives, anchored to include zero so a
  // dip below the baseline (e.g. negative profit) renders correctly.
  const lo = Math.min(0, ...values);
  const hi = Math.max(0, ...values, 1);
  const span = hi - lo || 1;
  const x = (i: number): number => (n <= 1 ? w / 2 : (i / (n - 1)) * w);
  const y = (v: number): number => 3 + (1 - (v - lo) / span) * (height - 6);
  const line = `M${values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' L')}`;
  const zeroY = y(0);
  const lastIdx = n - 1;
  const last = values[lastIdx]!;
  const seriesLabel = label ?? 'Trend';
  const ariaLabel = `${seriesLabel} sparkline: ${formatUsd(values[0]!)} to ${formatUsd(last)} over ${n} day${n === 1 ? '' : 's'}.`;

  return (
    <span className={styles.sparkWrap} role="img" aria-label={ariaLabel}>
      <svg viewBox={`0 0 ${w} ${height}`} preserveAspectRatio="none" className={styles.spark} aria-hidden>
        {/* Zero baseline — visible only when the series actually crosses below zero. */}
        {lo < 0 && <line x1="0" x2={w} y1={zeroY} y2={zeroY} style={{ stroke: 'var(--border)', strokeWidth: 1 }} vectorEffect="non-scaling-stroke" />}
        <path d={line} style={stroke(color, 2)} vectorEffect="non-scaling-stroke" />
        <circle cx={x(lastIdx)} cy={y(last)} r="2.25" style={{ fill: color }} />
      </svg>
    </span>
  );
}
