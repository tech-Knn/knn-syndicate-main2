import { describe, expect, it } from 'vitest';
import { buildNotificationPayload } from './notify.js';

describe('buildNotificationPayload', () => {
  it('formats a Slack-compatible payload with type, title, body and scope', () => {
    const { text } = buildNotificationPayload({ type: 'fb_connection_broken', title: 'Reconnect Facebook', body: 'Token revoked.', orgId: 'o1', userId: 'u1' });
    expect(text).toContain('*[fb_connection_broken]*');
    expect(text).toContain('Reconnect Facebook');
    expect(text).toContain('Token revoked.');
    expect(text).toContain('org=o1 user=u1');
  });
  it('omits the scope line when no org/user is given', () => {
    const { text } = buildNotificationPayload({ type: 't', title: 'T', body: 'B' });
    expect(text).toBe('*[t]* T\nB');
  });
});
