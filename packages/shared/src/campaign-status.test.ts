import { describe, expect, it } from 'vitest';
import {
  CAMPAIGN_STATUS,
  CAMPAIGN_TRANSITIONS,
  type CampaignStatus,
  canTransitionCampaign,
  isTerminalCampaignStatus,
  nextCampaignStates,
} from './campaign-status.js';

const ALL = Object.values(CAMPAIGN_STATUS) as CampaignStatus[];

describe('campaign state machine', () => {
  it('defines transitions for every status (graph is total)', () => {
    for (const s of ALL) expect(CAMPAIGN_TRANSITIONS[s]).toBeDefined();
    expect(Object.keys(CAMPAIGN_TRANSITIONS).sort()).toEqual([...ALL].sort());
  });

  it('only ever points at valid statuses', () => {
    for (const targets of Object.values(CAMPAIGN_TRANSITIONS)) {
      for (const t of targets) expect(ALL).toContain(t);
    }
  });

  it('forbids self-transitions for every status', () => {
    for (const s of ALL) expect(canTransitionCampaign(s, s)).toBe(false);
  });

  it('allows the approval-loop transitions', () => {
    expect(canTransitionCampaign(CAMPAIGN_STATUS.DRAFT, CAMPAIGN_STATUS.PENDING_APPROVAL)).toBe(true);
    expect(canTransitionCampaign(CAMPAIGN_STATUS.PENDING_APPROVAL, CAMPAIGN_STATUS.APPROVED)).toBe(true);
    expect(canTransitionCampaign(CAMPAIGN_STATUS.PENDING_APPROVAL, CAMPAIGN_STATUS.REJECTED)).toBe(true);
    // withdraw + revise return to DRAFT
    expect(canTransitionCampaign(CAMPAIGN_STATUS.PENDING_APPROVAL, CAMPAIGN_STATUS.DRAFT)).toBe(true);
    expect(canTransitionCampaign(CAMPAIGN_STATUS.REJECTED, CAMPAIGN_STATUS.DRAFT)).toBe(true);
  });

  it('allows the launch-pipeline transitions (later phases)', () => {
    expect(canTransitionCampaign(CAMPAIGN_STATUS.APPROVED, CAMPAIGN_STATUS.PROCESSING)).toBe(true);
    expect(canTransitionCampaign(CAMPAIGN_STATUS.APPROVED, CAMPAIGN_STATUS.QUEUED_NO_CHANNEL)).toBe(true);
    expect(canTransitionCampaign(CAMPAIGN_STATUS.PROCESSING, CAMPAIGN_STATUS.LAUNCHING)).toBe(true);
    expect(canTransitionCampaign(CAMPAIGN_STATUS.BATCHED, CAMPAIGN_STATUS.LAUNCHING)).toBe(true);
    expect(canTransitionCampaign(CAMPAIGN_STATUS.LAUNCHING, CAMPAIGN_STATUS.ACTIVE)).toBe(true);
    expect(canTransitionCampaign(CAMPAIGN_STATUS.ACTIVE, CAMPAIGN_STATUS.PAUSED)).toBe(true);
    expect(canTransitionCampaign(CAMPAIGN_STATUS.PAUSED, CAMPAIGN_STATUS.ACTIVE)).toBe(true);
    expect(canTransitionCampaign(CAMPAIGN_STATUS.LAUNCHING, CAMPAIGN_STATUS.META_REJECTED)).toBe(true);
  });

  it('allows reopening a stuck pre-launch campaign back to DRAFT (edit/relaunch)', () => {
    // A campaign that's been assigned a channel but never made it onto FB can be
    // reopened to fix its config (the service releases the channel on the way back).
    expect(canTransitionCampaign(CAMPAIGN_STATUS.PROCESSING, CAMPAIGN_STATUS.DRAFT)).toBe(true);
    expect(canTransitionCampaign(CAMPAIGN_STATUS.BATCHED, CAMPAIGN_STATUS.DRAFT)).toBe(true);
    expect(canTransitionCampaign(CAMPAIGN_STATUS.QUEUED_NO_CHANNEL, CAMPAIGN_STATUS.DRAFT)).toBe(true);
    // ...but once it's live on FB it can't be silently reopened (must pause first).
    expect(canTransitionCampaign(CAMPAIGN_STATUS.ACTIVE, CAMPAIGN_STATUS.DRAFT)).toBe(false);
    expect(canTransitionCampaign(CAMPAIGN_STATUS.LAUNCHING, CAMPAIGN_STATUS.DRAFT)).toBe(false);
  });

  it('rejects illegal transitions', () => {
    // can't skip review
    expect(canTransitionCampaign(CAMPAIGN_STATUS.DRAFT, CAMPAIGN_STATUS.APPROVED)).toBe(false);
    expect(canTransitionCampaign(CAMPAIGN_STATUS.DRAFT, CAMPAIGN_STATUS.ACTIVE)).toBe(false);
    // can't un-approve back to pending, or re-approve an active campaign
    expect(canTransitionCampaign(CAMPAIGN_STATUS.APPROVED, CAMPAIGN_STATUS.PENDING_APPROVAL)).toBe(false);
    expect(canTransitionCampaign(CAMPAIGN_STATUS.ACTIVE, CAMPAIGN_STATUS.APPROVED)).toBe(false);
    // a rejected campaign isn't directly approvable (must be revised + resubmitted)
    expect(canTransitionCampaign(CAMPAIGN_STATUS.REJECTED, CAMPAIGN_STATUS.APPROVED)).toBe(false);
    // can't review something that isn't pending
    expect(canTransitionCampaign(CAMPAIGN_STATUS.ACTIVE, CAMPAIGN_STATUS.REJECTED)).toBe(false);
  });

  it('treats ARCHIVED as the only terminal state', () => {
    expect(isTerminalCampaignStatus(CAMPAIGN_STATUS.ARCHIVED)).toBe(true);
    for (const s of ALL.filter((x) => x !== CAMPAIGN_STATUS.ARCHIVED)) {
      expect(isTerminalCampaignStatus(s)).toBe(false);
    }
    expect(nextCampaignStates(CAMPAIGN_STATUS.ARCHIVED)).toEqual([]);
  });

  it('lets resolvable states reach ARCHIVED, except PENDING_APPROVAL', () => {
    const archivable: CampaignStatus[] = [
      CAMPAIGN_STATUS.DRAFT,
      CAMPAIGN_STATUS.APPROVED,
      CAMPAIGN_STATUS.PROCESSING,
      CAMPAIGN_STATUS.QUEUED_NO_CHANNEL,
      CAMPAIGN_STATUS.BATCHED,
      CAMPAIGN_STATUS.LAUNCHING,
      CAMPAIGN_STATUS.ACTIVE,
      CAMPAIGN_STATUS.PAUSED,
      CAMPAIGN_STATUS.REJECTED,
      CAMPAIGN_STATUS.META_REJECTED,
    ];
    for (const s of archivable) expect(canTransitionCampaign(s, CAMPAIGN_STATUS.ARCHIVED)).toBe(true);
    // A pending campaign must be resolved (approve/reject/withdraw), not archived directly.
    expect(canTransitionCampaign(CAMPAIGN_STATUS.PENDING_APPROVAL, CAMPAIGN_STATUS.ARCHIVED)).toBe(false);
  });
});
