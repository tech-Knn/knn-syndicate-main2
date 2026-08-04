import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma, withSystem } from '@knn/db';
import { currentBusinessDay } from '@knn/shared';
import { getRsocUnitPerformance, getTermPerformance, recordTermSignal } from './term-telemetry.service.js';

const suffix = Date.now().toString(36);
const day = currentBusinessDay();
const termA = `tt-a-${suffix} insurance quotes`;
const termB = `tt-b-${suffix} solar deals`;

async function cleanup(): Promise<void> {
  await withSystem((tx) => tx.termStatDaily.deleteMany({ where: { term: { contains: `-${suffix}` } } }));
}

beforeEach(cleanup);
afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

describe('recordTermSignal', () => {
  it('increments searches + fills on render, clicks on click — keyed by (term, IST day)', async () => {
    await recordTermSignal({ term: termA, event: 'render', filled: true });
    await recordTermSignal({ term: termA, event: 'render', filled: false });
    await recordTermSignal({ term: termA, event: 'click' });

    const row = await withSystem((tx) => tx.termStatDaily.findUnique({ where: { term_day: { term: termA, day } } }));
    expect(row).not.toBeNull();
    expect(row!.searches).toBe(2);
    expect(row!.fills).toBe(1);
    expect(row!.clicks).toBe(1);
  });

  it('normalizes/lowercases the term and no-ops on an empty term', async () => {
    await recordTermSignal({ term: '  ' + termA.toUpperCase() + ' ', event: 'render', filled: true });
    await recordTermSignal({ term: '   ', event: 'render', filled: true }); // empty → ignored
    const rows = await withSystem((tx) => tx.termStatDaily.findMany({ where: { term: { contains: `-${suffix}` } } }));
    // Only the lowercased termA row exists (the blank was ignored).
    expect(rows).toHaveLength(1);
    expect(rows[0]!.term).toBe(termA.toLowerCase());
    expect(rows[0]!.searches).toBe(1);
  });
});

describe('getTermPerformance', () => {
  it('ranks by searches and computes fillRate/ctr (null below the term floor)', async () => {
    await withSystem((tx) =>
      tx.termStatDaily.createMany({
        data: [
          { term: termA, day, searches: 100, fills: 80, clicks: 40 }, // above floor
          { term: termB, day, searches: 5, fills: 2, clicks: 1 }, // below floor (20)
        ],
      }),
    );
    const res = await getTermPerformance({ limit: 50 });
    const a = res.terms.find((t) => t.term === termA)!;
    const b = res.terms.find((t) => t.term === termB)!;
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
    // termA (100 searches) ranks ahead of termB (5).
    expect(res.terms.findIndex((t) => t.term === termA)).toBeLessThan(res.terms.findIndex((t) => t.term === termB));
    expect(a.fillRate).toBeCloseTo(0.8, 5); // 80/100
    expect(a.ctr).toBeCloseTo(0.5, 5); // 40/80
    expect(b.fillRate).toBeNull(); // 5 searches < floor
    expect(b.ctr).toBeNull(); // 2 fills < floor
  });

  it('excludes synthetic `unit:<host>` rows from per-term rankings', async () => {
    const unitHost = `unit:tt-host-${suffix}.example`;
    await withSystem((tx) =>
      tx.termStatDaily.createMany({
        data: [
          { term: termA, day, searches: 100, fills: 80, clicks: 40 },
          { term: unitHost, day, searches: 250, fills: 0, clicks: 0 }, // must NOT appear
        ],
      }),
    );
    const res = await getTermPerformance({ limit: 50 });
    expect(res.terms.some((t) => t.term.startsWith('unit:'))).toBe(false);
    expect(res.terms.some((t) => t.term === termA)).toBe(true);
  });
});

describe('getRsocUnitPerformance', () => {
  it('rolls up per-host unit fills from the `unit:<host>` namespace', async () => {
    const hostA = `tt-host-${suffix}.example`;
    const hostB = `tt-host-b-${suffix}.example`;
    await withSystem((tx) =>
      tx.termStatDaily.createMany({
        data: [
          { term: `unit:${hostA}`, day, searches: 40, fills: 10, clicks: 0 }, // 25% fill, above floor
          { term: `unit:${hostB}`, day, searches: 3, fills: 0, clicks: 0 }, // below floor → null fillRate
          { term: termA, day, searches: 999, fills: 0, clicks: 0 }, // real term, must NOT appear here
        ],
      }),
    );
    const res = await getRsocUnitPerformance({ limit: 50 });
    const a = res.hosts.find((h) => h.host === hostA)!;
    const b = res.hosts.find((h) => h.host === hostB)!;
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
    expect(a.impressions).toBe(40);
    expect(a.fills).toBe(10);
    expect(a.fillRate).toBeCloseTo(0.25, 5);
    expect(b.fillRate).toBeNull();
    // Real terms (non-`unit:` prefix) must not leak in.
    expect(res.hosts.some((h) => h.host === termA)).toBe(false);
  });
});
