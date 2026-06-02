import { describe, expect, it } from 'vitest';
import { effectiveFunnelMode, isCloakerBuyer } from './funnel.js';

describe('effectiveFunnelMode', () => {
  it('forces NORMAL when the company gate is off, even if a CLOAKER override is set', () => {
    expect(effectiveFunnelMode({ cloakingEnabled: false, defaultFunnelMode: 'CLOAKER', userFunnelMode: 'CLOAKER' })).toBe('NORMAL');
    expect(effectiveFunnelMode({ cloakingEnabled: false, defaultFunnelMode: 'NORMAL', userFunnelMode: null })).toBe('NORMAL');
  });

  it('uses the org default when the gate is on and there is no per-buyer override', () => {
    expect(effectiveFunnelMode({ cloakingEnabled: true, defaultFunnelMode: 'CLOAKER', userFunnelMode: null })).toBe('CLOAKER');
    expect(effectiveFunnelMode({ cloakingEnabled: true, defaultFunnelMode: 'NORMAL', userFunnelMode: undefined })).toBe('NORMAL');
  });

  it('lets a per-buyer override win over the org default (both directions) when the gate is on', () => {
    expect(effectiveFunnelMode({ cloakingEnabled: true, defaultFunnelMode: 'NORMAL', userFunnelMode: 'CLOAKER' })).toBe('CLOAKER');
    expect(effectiveFunnelMode({ cloakingEnabled: true, defaultFunnelMode: 'CLOAKER', userFunnelMode: 'NORMAL' })).toBe('NORMAL');
  });

  it('isCloakerBuyer mirrors the resolution', () => {
    expect(isCloakerBuyer({ cloakingEnabled: true, defaultFunnelMode: 'CLOAKER' })).toBe(true);
    expect(isCloakerBuyer({ cloakingEnabled: false, defaultFunnelMode: 'CLOAKER', userFunnelMode: 'CLOAKER' })).toBe(false);
  });
});
