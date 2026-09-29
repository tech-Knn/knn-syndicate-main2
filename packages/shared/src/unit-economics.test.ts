import { describe, expect, it } from 'vitest';
import { AD_CLICK_EVENT_NAME, FUNNEL_EVENT_NAME } from './conversions.js';
import { costPer, cvr, epv, formatRate, formatUnitUsd, lpCtr, perVisit, rpcPerAdClick, vcvr } from './unit-economics.js';

describe('ClickFlare-named unit metrics', () => {
  it('EPV / RPC / vCVR / CPC match their definitions and are null without a denominator', () => {
    expect(epv(150, 13_500)).toBeCloseTo(0.0111, 4); // revenue ÷ visits
    expect(rpcPerAdClick(150, 3_165)).toBeCloseTo(0.0474, 4); // revenue ÷ ad clicks (ClickFlare Dynamic payout)
    expect(vcvr(3_165, 13_500)).toBeCloseTo(0.2344, 4); // ad clicks ÷ visits
    expect(costPer(170, 13_500)).toBeCloseTo(0.0126, 4); // CPC = spend ÷ visits
    expect(perVisit(2_414, 13_500)).toBeCloseTo(0.1788, 4);
    expect([epv(1, 0), rpcPerAdClick(1, 0), vcvr(1, 0), costPer(1, 0), perVisit(1, 0)]).toEqual([null, null, null, null, null]);
  });

  it('RPC and vCVR match ClickFlare on a real row (Dynamic payout = revenue ÷ conversions; visitCvr = conversions ÷ visits)', () => {
    // ClickFlare 2026-09-29, "Second hand mobile": $218.85 (rounded to cents), 7,656 conversions,
    // 32,246 visits → dynamicPayout 0.02858506, visitCvr 23.742479%.
    expect(rpcPerAdClick(218.85, 7_656)).toBeCloseTo(0.02858506, 5);
    expect(vcvr(7_656, 32_246)! * 100).toBeCloseTo(23.742479, 5);
  });

  it('CTR (keyword clicks ÷ visits) × CVR (ad clicks ÷ keyword clicks) = vCVR, like ClickFlare', () => {
    // Staging, 7 days: 10,969 visits → 5,078 keyword clicks → 2,180 ad clicks.
    expect(lpCtr(5_078, 10_969)).toBeCloseTo(0.4629, 4);
    expect(cvr(2_180, 5_078)).toBeCloseTo(0.4293, 4);
    expect(lpCtr(5_078, 10_969)! * cvr(2_180, 5_078)!).toBeCloseTo(vcvr(2_180, 10_969)!, 12);
    expect([lpCtr(1, 0), cvr(1, 0)]).toEqual([null, null]);
  });

  it('the funnel counts the recorded events of each stage (not stage names)', () => {
    expect(FUNNEL_EVENT_NAME).toEqual({ lander: 'ViewContent', search: 'AddToCart', adclick: 'Search' });
    expect(AD_CLICK_EVENT_NAME).toBe('Search');
  });

  it('formats sub-dollar unit prices with 3 decimals so they stay distinguishable', () => {
    expect(formatUnitUsd(0.0111)).toBe('$0.011');
    expect(formatUnitUsd(0.0474)).toBe('$0.047');
    expect(formatUnitUsd(1.5)).toBe('$1.50');
    expect(formatUnitUsd(0)).toBe('$0.00');
    expect(formatUnitUsd(null)).toBe('—');
  });

  it('formats rates with 1 decimal, 2 below 1%', () => {
    expect(formatRate(0.2344)).toBe('23.4%');
    expect(formatRate(0.0085)).toBe('0.85%');
    expect(formatRate(0)).toBe('0.0%');
    expect(formatRate(null)).toBe('—');
  });
});
