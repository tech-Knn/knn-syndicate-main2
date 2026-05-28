'use client';

import { useEffect } from 'react';

/**
 * RSOC final-ad-click detector. The AFS ads live in a cross-origin Google iframe, so
 * we can't see the click directly — we infer it the way production AFS trackers do:
 * a `postMessage` from the `syndicatedsearch.goog` origin while that ad iframe is the
 * focused/active element. On the first such signal we beacon our public `/api/events`
 * with the click id (txid); the server resolves the ad's pixel + the buyer's token and
 * fires Facebook CAPI S2S. Once per session (sessionStorage), like ClickFlare.
 *
 * The beacon target is `NEXT_PUBLIC_EVENTS_URL` (the public API events endpoint, baked
 * at build time). Unset → the detector is inert (no beacon).
 */
const EVENTS_URL = process.env.NEXT_PUBLIC_EVENTS_URL ?? '';
const FIRED_KEY = 'knn_conv_fired';

export function ConversionTracker({
  clickId,
  value,
  currency,
}: {
  clickId?: string;
  value?: string;
  currency?: string;
}) {
  useEffect(() => {
    if (!EVENTS_URL || !clickId) return;

    const onMessage = (event: MessageEvent): void => {
      const el = document.activeElement;
      if (!el || el.tagName !== 'IFRAME') return;
      if (!event.origin.startsWith('https://syndicatedsearch.goog')) return;
      try {
        if (sessionStorage.getItem(FIRED_KEY)) return;
        sessionStorage.setItem(FIRED_KEY, '1');
      } catch {
        // sessionStorage may be unavailable; proceed (best-effort dedup only).
      }

      const u = new URL(EVENTS_URL);
      u.searchParams.set('click_id', clickId);
      if (value) u.searchParams.set('value', value);
      if (currency) u.searchParams.set('currency', currency);
      u.searchParams.set('url', window.location.href);

      if (typeof navigator.sendBeacon === 'function') {
        navigator.sendBeacon(u.toString());
      } else {
        void fetch(u.toString(), { method: 'POST', keepalive: true, mode: 'no-cors' });
      }
    };

    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [clickId, value, currency]);

  return null;
}
