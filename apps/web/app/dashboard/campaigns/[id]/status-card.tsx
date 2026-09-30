'use client';

import type { ReactNode } from 'react';
import { whopEffectiveStatus } from '@knn/shared';
import { FbStatusBadge } from '@/components/fb-status-badge';
import { IconAlert, IconBolt, IconCheck, IconClock, IconFlag, IconPause, IconRocket } from '@/components/icons';
import { Button, Spinner } from '@/components/ui';
import type { Campaign } from '@/lib/types';
import styles from './campaign.module.css';
import { NO_REASON_TEXT, launchStuck } from './format';
import { toneClass } from './parts';
import { networkName, statusMeta } from './status';

// Statuses where the campaign can be pushed live to its ad network (it has a channel). Manual
// launch is available to the owning buyer + admins (the API owner-scopes it).
export const LAUNCHABLE = new Set(['PROCESSING', 'BATCHED']);
// Pre-launch states that can be reopened to DRAFT to fix config (releases the channel).
// Excludes LAUNCHING/ACTIVE/PAUSED (already at the ad network, pause first) and the review
// states (DRAFT/PENDING/REJECTED already have their own withdraw/revise paths).
export const REOPENABLE = new Set(['PROCESSING', 'BATCHED', 'QUEUED_NO_CHANNEL']);
// Live at the ad network: the owning buyer (or an admin) can pause/resume delivery.
export const LIVE_TOGGLEABLE = new Set(['ACTIVE', 'PAUSED']);

export interface StatusActions {
  launching: boolean;
  reopening: boolean;
  toggling: boolean;
  cloning: boolean;
  onLaunch: () => void;
  onReopen: () => void;
  onToggle: (active: boolean) => void;
  onClone: () => void;
}

const adCount = (c: Campaign): number => c.adSets.reduce((n, s) => n + s.ads.length, 0);

/**
 * The single "where is this and what do I do next" card. It replaces a stack of banners: one state, one sentence,
 * the next action, and (when there is one) the reason in Whop's or Meta's own words.
 */
export function StatusCard({ campaign: c, actions }: { campaign: Campaign; actions: StatusActions }) {
  const meta = statusMeta(c);
  const net = networkName(c);
  const issues = c.whopIssues ?? [];
  const launchError = issues.find((i) => i.id === 'knn-launch');
  const reported = issues.filter((i) => i.id !== 'knn-launch');
  const launchBlocked = Boolean(launchError) && (c.status === 'PROCESSING' || c.status === 'BATCHED');

  let icon: ReactNode = <IconBolt size={20} />;
  let title: string = meta.label;
  let text: ReactNode = null;
  let tone = meta.tone;
  let buttons: ReactNode = null;
  let extra: ReactNode = null;

  const reopenBtn = (
    <Button variant="ghost" onClick={actions.onReopen} loading={actions.reopening} disabled={actions.launching}>
      {actions.reopening ? 'Reopening…' : 'Reopen & edit'}
    </Button>
  );

  switch (c.status) {
    case 'ACTIVE':
    case 'PAUSED': {
      const live = c.status === 'ACTIVE';
      icon = live ? <IconBolt size={20} /> : <IconPause size={20} />;
      title = live ? `Live on ${net}` : 'Paused';
      text = live
        ? 'Ads are delivering. Pause to stop delivery and spend without losing the campaign; resume anytime.'
        : `Ads are not delivering on ${net}. Resume to put them back live.`;
      buttons = live ? (
        <Button variant="danger" onClick={() => actions.onToggle(false)} loading={actions.toggling}>
          {actions.toggling ? 'Pausing…' : 'Pause campaign'}
        </Button>
      ) : (
        <Button onClick={() => actions.onToggle(true)} loading={actions.toggling}>
          {actions.toggling ? 'Resuming…' : 'Resume campaign'}
        </Button>
      );
      if (c.adProvider === 'WHOP' && (c.whopDeliveryStatus || reported.length > 0)) {
        extra = (
          <>
            <div className={styles.inlineRow}>
              <span className={styles.syncNote}>Whop delivery</span>
              <FbStatusBadge status={whopEffectiveStatus(c.whopDeliveryStatus)} />
              {c.whopDeliveryStatus && (
                <span className={styles.syncNote}>Whop says “{c.whopDeliveryStatus.replace(/_/g, ' ')}”. Refreshed every 30 minutes.</span>
              )}
            </div>
            {reported.length > 0 && (
              <ul className={`${styles.issues} ${toneClass('warning')}`}>
                {reported.map((i) => (
                  <li key={i.id}>{i.message}</li>
                ))}
              </ul>
            )}
          </>
        );
      }
      break;
    }
    case 'PROCESSING':
    case 'BATCHED': {
      const batched = c.status === 'BATCHED';
      icon = batched ? <IconClock size={20} /> : <IconRocket size={20} />;
      title = batched ? 'Rate-limited' : launchBlocked ? `${net} did not launch this campaign` : 'Ready to publish';
      tone = batched || launchBlocked ? 'warning' : 'brand';
      text = launchBlocked
        ? `${launchError!.message.replace(/[.!?:]*\s*$/, '.')}${/\blaunch again\b/i.test(launchError!.message) ? '' : ' Fix that, then launch again.'} What ${net} already holds is reused.`
        : batched
          ? `${net} rate-limited the launch part-way. Whatever was already created there is kept, and Launch continues from where it stopped, so nothing is created twice. Need to fix something first? Reopen to edit.`
          : `A channel is assigned. Launching generates the article, wires the redirect, and creates the ads on ${net}. Need to fix something first? Reopen to edit.`;
      buttons = (
        <>
          {reopenBtn}
          <Button onClick={actions.onLaunch} loading={actions.launching} disabled={actions.reopening}>
            {actions.launching ? 'Launching…' : `Launch to ${net}`}
          </Button>
        </>
      );
      if (!batched && !launchBlocked) {
        const dollars = c.dailyBudgetCents != null ? `$${(c.dailyBudgetCents / 100).toFixed(2)} a day` : null;
        extra = (
          <div className={styles.checks}>
            <span className={styles.check}>
              <IconCheck size={14} /> Channel assigned
            </span>
            <span className={styles.check}>
              <IconCheck size={14} /> {adCount(c)} ad{adCount(c) === 1 ? '' : 's'} ready
            </span>
            {dollars && (
              <span className={styles.check}>
                <IconCheck size={14} /> {dollars}
              </span>
            )}
          </div>
        );
      }
      break;
    }
    case 'QUEUED_NO_CHANNEL':
      icon = <IconClock size={20} />;
      title = 'Waiting for a channel';
      text = 'No AdSense channel is free for this campaign yet. Reopen to edit it, or leave it queued.';
      buttons = reopenBtn;
      break;
    case 'LAUNCHING':
      icon = <Spinner />;
      title = `Launching on ${net}`;
      text = launchStuck(c)
        ? `This is taking longer than usual: nothing has moved for over 15 minutes. ${c.adProvider === 'WHOP' ? 'A Whop launch that goes quiet is settled automatically from Whop’s side.' : 'Nothing is lost, and it can be reopened.'} This page keeps checking.`
        : `Building the campaign, its ads and the redirect. This page updates by itself when it finishes.`;
      tone = launchStuck(c) ? 'warning' : tone;
      break;
    case 'PENDING_APPROVAL':
      icon = <IconClock size={20} />;
      title = 'Waiting for approval';
      text = 'An admin reviews new campaigns before they launch. You will be notified when it is decided.';
      break;
    case 'APPROVED':
      icon = <IconCheck size={20} />;
      title = 'Approved';
      text = 'Approved. A channel is assigned next, and then it can launch.';
      break;
    case 'META_REJECTED':
      icon = <IconAlert size={20} />;
      title = 'Meta rejected this campaign';
      text = 'Meta’s ad review turned it down, so nothing is delivering. Read the reason, then make a corrected copy and launch that.';
      buttons = (
        <Button onClick={actions.onClone} loading={actions.cloning}>
          Clone to fix
        </Button>
      );
      // Always say something: a rejection with no readable reason still needs to tell the buyer what to do next.
      extra = (
        <ul className={`${styles.issues} ${toneClass('danger')}`}>
          {reported.map((i) => (
            <li key={i.id}>{i.message}</li>
          ))}
          {reported.length === 0 && <li>{c.rejectionReason && c.rejectionReason !== 'Meta review rejected the ad' ? c.rejectionReason : NO_REASON_TEXT}</li>}
        </ul>
      );
      break;
    case 'REJECTED':
      icon = <IconAlert size={20} />;
      title = 'Not approved';
      text = c.rejectionReason ? c.rejectionReason : 'An admin did not approve this campaign.';
      buttons = (
        <Button variant="ghost" onClick={actions.onClone} loading={actions.cloning}>
          Clone to revise
        </Button>
      );
      break;
    case 'ARCHIVED':
      icon = <IconFlag size={20} />;
      title = 'Archived';
      text = 'This campaign was archived and no longer delivers.';
      break;
    default:
      return null;
  }

  return (
    <section className={`${styles.status} ${toneClass(tone)}`} aria-live="polite">
      <div className={styles.statusIcon} aria-hidden>
        {icon}
      </div>
      <div className={styles.statusBody}>
        <h2 className={styles.statusTitle}>{title}</h2>
        {text && <p className={styles.statusText}>{text}</p>}
      </div>
      {buttons && <div className={styles.statusActions}>{buttons}</div>}
      {extra && <div className={styles.statusExtra}>{extra}</div>}
    </section>
  );
}
