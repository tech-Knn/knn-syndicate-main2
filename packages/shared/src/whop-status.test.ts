import { describe, expect, it } from 'vitest';
import { whopAdEffectiveStatus, whopAdGroupEffectiveStatus, whopAdRejected, whopBillingFailed, whopEffectiveStatus, whopSyncTarget } from './whop-status.js';

const c = (status: string, delivery_status: string) => ({ status, delivery_status });

describe('whopSyncTarget', () => {
  it('mirrors a pause or a resume done in Whop', () => {
    expect(whopSyncTarget(c('paused', 'paused'), [])).toBe('PAUSED');
    expect(whopSyncTarget(c('active', 'active'), [])).toBe('ACTIVE');
    expect(whopSyncTarget(c('active', 'processing'), [])).toBe('ACTIVE');
    expect(whopSyncTarget(c('active', 'scheduled'), [])).toBe('ACTIVE');
  });

  it('rejects the campaign when Meta rejected ALL its ads, however Whop words it, and that beats a pause', () => {
    expect(whopSyncTarget(c('active', 'all_ads_rejected'), [])).toBe('META_REJECTED');
    const rejected = { status: 'rejected', delivery_status: 'rejected' };
    expect(whopSyncTarget(c('active', 'active'), [rejected])).toBe('META_REJECTED');
    expect(whopSyncTarget(c('paused', 'paused'), [rejected, { status: 'active', delivery_status: 'in_appeal' }])).toBe('META_REJECTED');
  });

  it('does NOT reject a campaign for SOME rejected ads: the rest keep running', () => {
    const ok = { status: 'active', delivery_status: 'active' };
    const rejected = { status: 'rejected', delivery_status: 'rejected' };
    expect(whopSyncTarget(c('active', 'active'), [ok, rejected])).toBe('ACTIVE');
    // ads still in review count as not rejected; 2 of 12 rejected is the case that paused a live campaign
    const inReview = { status: 'in_review', delivery_status: 'in_review' };
    expect(whopSyncTarget(c('active', 'active'), [rejected, rejected, inReview, ok])).toBe('ACTIVE');
    // a campaign paused in Whop with one rejected ad stays a paused campaign, not a rejected one
    expect(whopSyncTarget(c('paused', 'paused'), [ok, rejected])).toBe('PAUSED');
    // a campaign-level appeal with no ads to judge by is not acted on
    expect(whopSyncTarget(c('active', 'in_appeal'), [])).toBe('ACTIVE');
  });

  it('leaves alone what it cannot be sure of: drafts and lifecycles we do not know', () => {
    expect(whopSyncTarget(c('draft', 'draft'), [])).toBeNull();
    expect(whopSyncTarget(c('in_review', 'processing'), [])).toBeNull();
    expect(whopSyncTarget(c('flagged', 'issues'), [])).toBeNull();
    // An ended campaign is still ACTIVE by configuration; nothing is flipped on its account.
    expect(whopSyncTarget(c('active', 'completed'), [])).toBe('ACTIVE');
  });

  it('does not treat a billing failure as a state change', () => {
    expect(whopSyncTarget(c('active', 'payment_failed'), [])).toBe('ACTIVE');
    expect(whopSyncTarget(c('paused', 'payment_failed'), [])).toBe('PAUSED');
    expect(whopBillingFailed(c('active', 'payment_failed'))).toBe(true);
    expect(whopBillingFailed(c('active', 'active'))).toBe(false);
  });

  it('is case-insensitive and tolerant of missing fields', () => {
    expect(whopSyncTarget({ status: 'ACTIVE' }, [])).toBe('ACTIVE');
    expect(whopSyncTarget({}, [])).toBeNull();
    expect(whopAdRejected({ delivery_status: 'REJECTED' })).toBe(true);
  });
});

describe('display statuses', () => {
  it('maps Whop\'s words onto the vocabulary the badges already colour', () => {
    expect(whopEffectiveStatus('active')).toBe('ACTIVE');
    expect(whopEffectiveStatus('in_review')).toBe('PENDING_REVIEW');
    expect(whopEffectiveStatus('rejected')).toBe('DISAPPROVED');
    expect(whopEffectiveStatus('payment_failed')).toBe('PENDING_BILLING_INFO');
    expect(whopEffectiveStatus('ad_groups_off')).toBe('ADSET_PAUSED');
  });

  it('shows a word with no equivalent as itself, and nothing for nothing', () => {
    expect(whopEffectiveStatus('scheduled')).toBe('SCHEDULED');
    expect(whopEffectiveStatus('')).toBeNull();
    expect(whopEffectiveStatus(null)).toBeNull();
  });

  it('lets a paused or rejected ad win over what delivery says', () => {
    expect(whopAdEffectiveStatus({ status: 'paused', delivery_status: 'active' })).toBe('PAUSED');
    expect(whopAdEffectiveStatus({ status: 'rejected', delivery_status: 'processing' })).toBe('DISAPPROVED');
    expect(whopAdEffectiveStatus({ status: 'active', delivery_status: 'learning' })).toBe('ACTIVE');
  });

  it('derives an ad group\'s status from its ads: problems show, any delivering ad is ACTIVE, all paused is PAUSED', () => {
    expect(whopAdGroupEffectiveStatus([])).toBeNull();
    expect(whopAdGroupEffectiveStatus(['ACTIVE', 'DISAPPROVED'])).toBe('DISAPPROVED');
    expect(whopAdGroupEffectiveStatus(['ACTIVE', 'WITH_ISSUES'])).toBe('WITH_ISSUES');
    expect(whopAdGroupEffectiveStatus(['PAUSED', 'ACTIVE'])).toBe('ACTIVE');
    expect(whopAdGroupEffectiveStatus(['PAUSED', 'PENDING_REVIEW'])).toBe('PENDING_REVIEW');
    expect(whopAdGroupEffectiveStatus(['PAUSED', 'PAUSED'])).toBe('PAUSED');
    expect(whopAdGroupEffectiveStatus([null, 'ACTIVE'])).toBe('ACTIVE');
  });
});
