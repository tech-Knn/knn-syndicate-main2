'use client';

import Link from 'next/link';
import { useEffect } from 'react';
import { IconAlert } from '@/components/icons';
import { Button, EmptyState } from '@/components/ui';

/**
 * The safety net for every dashboard page: an error while drawing one page used to blank the whole app, sidebar
 * included. The shell around it stays, and this says what happened and how to get back.
 */
export default function DashboardError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error('[dashboard] a page failed to render', error);
  }, [error]);
  return (
    <EmptyState
      icon={<IconAlert size={28} />}
      title="This page hit a problem"
      description="Nothing you had saved is lost. Try again, or go back to your campaigns. If it keeps happening, tell us what you were doing."
      action={
        <div style={{ display: 'flex', gap: 'var(--space-3)', justifyContent: 'center', flexWrap: 'wrap' }}>
          <Button onClick={reset}>Try again</Button>
          <Link href="/dashboard/campaigns">
            <Button variant="secondary">Back to campaigns</Button>
          </Link>
        </div>
      }
    />
  );
}
