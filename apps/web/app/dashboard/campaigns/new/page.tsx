'use client';

import { CampaignWizard } from '@/components/campaign-wizard';
import { Card, EmptyState } from '@/components/ui';
import { useAuth } from '../../../providers';
import styles from '../campaigns.module.css';

export default function NewCampaignPage() {
  const { user } = useAuth();

  // Role-correct IA: campaigns are created + launched by media buyers (and company admins),
  // not platform admins. A SUPER_ADMIN landing here used to hit a "No Facebook ad accounts"
  // dead-end; show a clear explanation instead.
  if (user?.role === 'SUPER_ADMIN') {
    return (
      <Card className={styles.center} style={{ padding: 'var(--space-8) var(--space-5)' }}>
        <EmptyState
          icon={<span aria-hidden>🛠️</span>}
          title="Campaign creation is for media buyers"
          description="As a platform admin you oversee companies, domains, channels, and AdSense. Campaigns are built and launched by media buyers inside each company — manage everything from the Platform tab."
        />
      </Card>
    );
  }

  return <CampaignWizard />;
}
