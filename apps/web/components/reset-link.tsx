'use client';

import { useState } from 'react';
import { Banner, Button, Modal, useToast } from '@/components/ui';
import { admin } from '@/lib/api';

/**
 * Admin-issued password reset (D37): no email. The admin gets a single-use link to hand over any way they like; the user opens it
 * and chooses their own password, so the admin never sees it. The token travels in the URL FRAGMENT (`#`), which a browser never
 * sends to a server or in a Referer header, and the reset page removes it from the address bar as soon as it has read it.
 */
export interface IssuedResetLink {
  name: string;
  email: string;
  url: string;
  expiresAt: string;
}

/** Ask the API for a link for `user` and build the page URL on this site's own origin. */
export async function issueResetLink(user: { id: string; name: string; email: string }): Promise<IssuedResetLink> {
  const r = await admin.issuePasswordReset(user.id);
  return { name: r.user.name, email: r.user.email, url: `${window.location.origin}/reset-password#${r.token}`, expiresAt: r.expiresAt };
}

const when = (iso: string): string => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/** A ready-to-paste message for WhatsApp / Telegram / Slack. */
export function resetMessage(l: IssuedResetLink): string {
  return `Hi ${l.name}, set a new password for your KNN account here: ${l.url}\nThe link works once and expires ${when(l.expiresAt)}.`;
}

export function ResetLinkDialog({ link, onClose }: { link: IssuedResetLink | null; onClose: () => void }) {
  const toast = useToast();
  const [copied, setCopied] = useState<'link' | 'message' | null>(null);

  async function copy(text: string, what: 'link' | 'message'): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(what);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      toast.error('Could not copy automatically. Select the link and copy it.');
    }
  }

  return (
    <Modal
      open={link !== null}
      onClose={onClose}
      title={link ? `Password reset link for ${link.name}` : undefined}
      footer={<Button onClick={onClose}>Done</Button>}
    >
      {link && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.9rem' }}>
          <p style={{ margin: 0 }}>
            Send this link to <strong>{link.email}</strong> privately (WhatsApp, Telegram, Slack…). They open it and choose their own password; you never see it.
          </p>
          <input
            readOnly
            aria-label="Link to send"
            value={link.url}
            onFocus={(e) => e.currentTarget.select()}
            className="mono"
            style={{ width: '100%', padding: '0.6rem 0.7rem', borderRadius: 8, border: '1px solid var(--border, #444)', background: 'transparent', color: 'inherit' }}
          />
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            <Button onClick={() => void copy(link.url, 'link')}>{copied === 'link' ? 'Copied' : 'Copy link'}</Button>
            <Button onClick={() => void copy(resetMessage(link), 'message')}>{copied === 'message' ? 'Copied' : 'Copy as message'}</Button>
          </div>
          <Banner tone="warning" title="Shown only once">
            Works once and expires {when(link.expiresAt)}. Anyone who has it can set this account&apos;s password, so don&apos;t post it anywhere public. Closing this
            window loses it; issue another and the old one stops working.
          </Banner>
        </div>
      )}
    </Modal>
  );
}
