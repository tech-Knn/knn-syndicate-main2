'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { IconArrowLeft, IconShield } from '@/components/icons';
import type { Campaign } from '@/lib/types';
import styles from './campaign.module.css';
import { Chip, CopyButton, Menu, type MenuEntry, StatusPill } from './parts';
import { funnelOf, networkName, statusMeta, timeAgo } from './status';

/** Who runs it, in the owner's own words: the Whop business or the Facebook ad account. */
function providerLabel(c: Campaign): string {
  if (c.adProvider === 'WHOP') return c.whopBusiness?.label ?? c.whopBizId ?? 'Whop business';
  return c.adAccount?.name ?? 'Facebook ad account';
}

export function CampaignHeader({ campaign: c, actions, menu }: { campaign: Campaign; actions?: ReactNode; menu: MenuEntry[] }) {
  const meta = statusMeta(c);
  const funnel = funnelOf(c);
  const launched = Boolean(c.submittedAt);
  return (
    <header className={styles.header}>
      <Link href="/dashboard/campaigns" className={styles.crumb}>
        <IconArrowLeft size={16} />
        Campaigns
      </Link>
      <div className={styles.titleRow}>
        <div className={styles.titleBlock}>
          <h1 className={styles.title}>{c.name}</h1>
          <div className={styles.metaRow}>
            <StatusPill meta={meta} />
            <Chip>
              {networkName(c)} · <strong>{providerLabel(c)}</strong>
            </Chip>
            {funnel && (
              <Chip icon={<IconShield size={14} />} title={funnel === 'CLOAKER' ? 'Visitors who are not real ad clicks see a clean white page.' : 'Everyone reaches the article; there is no white page.'}>
                <strong>{funnel === 'CLOAKER' ? 'Cloaker' : 'Normal'}</strong> funnel
              </Chip>
            )}
            <Chip mono title="Campaign id">
              {c.id.slice(0, 8)}
              <CopyButton value={c.id} label="campaign id" />
            </Chip>
            <Chip>{launched ? `Submitted ${timeAgo(c.submittedAt)}` : `Created ${timeAgo(c.createdAt)}`}</Chip>
          </div>
        </div>
        <div className={styles.actions}>
          {actions}
          <Menu entries={menu} />
        </div>
      </div>
    </header>
  );
}
