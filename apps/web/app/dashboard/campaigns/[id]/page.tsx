'use client';

import { use, useEffect, useState } from 'react';
import { CampaignWizard } from '@/components/campaign-wizard';
import { Spinner } from '@/components/ui';
import { campaigns } from '@/lib/api';
import { type Campaign } from '@/lib/types';
import { OffersEditor } from './offers-editor';

export default function EditCampaignPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [campaign, setCampaign] = useState<Campaign | null | 'error'>(null);

  useEffect(() => {
    let active = true;
    void campaigns
      .get(id)
      .then((c) => active && setCampaign(c))
      .catch(() => active && setCampaign('error'));
    return () => {
      active = false;
    };
  }, [id]);

  if (campaign === 'error') {
    return <p style={{ color: 'var(--muted)' }}>Campaign not found.</p>;
  }
  if (campaign === null) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: '3rem' }}>
        <Spinner />
      </div>
    );
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
      <CampaignWizard campaign={campaign} />
      <OffersEditor campaignId={campaign.id} status={campaign.status} />
    </div>
  );
}
