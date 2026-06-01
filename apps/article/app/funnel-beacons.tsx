'use client';

import { useEffect } from 'react';

/**
 * RSOC conversion funnel → Facebook CAPI. As a PAID visitor (one carrying a redirect
 * `txid`/clickId) moves down the funnel, we beacon each stage to the public /api/events,
 * which records it and fires the matching Facebook standard event server-side:
 *
 *   lander  → fires on the article page view          → ViewContent
 *   search  → fires when the /search page is reached    → AddToCart
 *   adclick → fires when a monetized AFS ad is clicked  → Search   ← the MAIN conversion
 *
 * Organic visitors have no txid → nothing fires (the server also no-ops unknown clicks).
 * Beacon target is `NEXT_PUBLIC_EVENTS_URL` (baked at build); unset → inert.
 */
const EVENTS_URL = process.env.NEXT_PUBLIC_EVENTS_URL ?? '';

// Per-term RSOC telemetry endpoint (observe-only). Prefer an explicit URL; else derive from the
// conversion-beacon URL (same API host). Empty → inert (self-dormant).
const TERM_TELEMETRY_URL =
  process.env.NEXT_PUBLIC_TERM_TELEMETRY_URL ||
  (EVENTS_URL ? EVENTS_URL.replace(/\/api\/events\/?$/, '/api/telemetry/term') : '');

type Stage = 'lander' | 'search' | 'adclick';

/** Fire one per-term telemetry signal (observe-only). Best-effort beacon; inert if no URL/term. */
function fireTermSignal(term: string, event: 'render' | 'click', filled?: boolean): void {
  if (!TERM_TELEMETRY_URL || !term) return;
  const u = new URL(TERM_TELEMETRY_URL);
  u.searchParams.set('term', term);
  u.searchParams.set('event', event);
  if (filled !== undefined) u.searchParams.set('filled', filled ? '1' : '0');
  if (typeof navigator.sendBeacon === 'function') {
    navigator.sendBeacon(u.toString());
  } else {
    void fetch(u.toString(), { method: 'POST', keepalive: true, mode: 'no-cors' });
  }
}

/** Fire one funnel-stage beacon. Deduped once per (stage, click) in this session; the
 *  server also dedups on (clickId, eventName), so a double-send is harmless. */
function fireConversion(clickId: string, stage: Stage, opts?: { value?: string; currency?: string }): void {
  if (!EVENTS_URL || !clickId) return;
  const key = `knn_conv_${stage}_${clickId}`;
  try {
    if (sessionStorage.getItem(key)) return;
    sessionStorage.setItem(key, '1');
  } catch {
    // sessionStorage may be unavailable; proceed (best-effort dedup only).
  }
  const u = new URL(EVENTS_URL);
  u.searchParams.set('click_id', clickId);
  u.searchParams.set('stage', stage);
  if (opts?.value) u.searchParams.set('value', opts.value);
  if (opts?.currency) u.searchParams.set('currency', opts.currency);
  u.searchParams.set('url', window.location.href);
  if (typeof navigator.sendBeacon === 'function') {
    navigator.sendBeacon(u.toString());
  } else {
    void fetch(u.toString(), { method: 'POST', keepalive: true, mode: 'no-cors' });
  }
}

/** Article page: fire the `lander` (ViewContent) event on view, for paid visitors. */
export function LanderBeacon({ clickId }: { clickId?: string }) {
  useEffect(() => {
    if (clickId) fireConversion(clickId, 'lander');
  }, [clickId]);
  return null;
}

/**
 * /search page: fire `search` (AddToCart) on arrival, then `adclick` (Search — the main
 * conversion) when the cross-origin AFS ad iframe signals a click. The ad lives in a
 * Google iframe so the click can't be read directly; we infer it the way production AFS
 * trackers do — a `postMessage` from `syndicatedsearch.goog` while that iframe is focused.
 */
export function ConversionTracker({
  clickId,
  value,
  currency,
  term,
}: {
  clickId?: string;
  value?: string;
  currency?: string;
  /** The related-search term (the /search `q`) — records a per-term ad-click in RSOC telemetry. */
  term?: string;
}) {
  useEffect(() => {
    // The ad-click listener is independent of clickId so per-term telemetry works even for
    // visitors without a redirect txid; the CAPI conversion still requires the clickId.
    const onMessage = (event: MessageEvent): void => {
      const el = document.activeElement;
      if (!el || el.tagName !== 'IFRAME') return;
      if (!event.origin.startsWith('https://syndicatedsearch.goog')) return;
      if (clickId) fireConversion(clickId, 'adclick', { value, currency });
      if (term) fireTermSignal(term, 'click');
    };

    // Reaching /search IS the AddToCart funnel step (paid visitors only).
    if (clickId) fireConversion(clickId, 'search');
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [clickId, value, currency, term]);

  return null;
}
