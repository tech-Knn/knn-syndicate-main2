'use client';

import { preconnect, prefetchDNS, preload } from 'react-dom';

/**
 * Warm Google's ad origins for the WHOLE funnel. Both the article (content) page and
 * /search load ads.js and serve creatives from syndicatedsearch.goog, so connecting here
 * means the TLS handshake is already done by the time the user clicks through to /search —
 * the ad request on the money page pays ~0 connection cost.
 *
 * Uses React 19's resource-hint APIs (NOT raw <link> tags): they emit the hints into
 * <head> without rendering a reconcilable DOM node, so there's no hydration mismatch.
 * (Raw <link> tags placed in the tree get hoisted by the browser into <head>, which
 * desynced React's tree → React error #418.) Renders nothing.
 */
export function ResourceHints(): null {
  prefetchDNS('https://www.google.com');
  prefetchDNS('https://syndicatedsearch.goog');
  preconnect('https://www.google.com');
  preconnect('https://syndicatedsearch.goog');
  preconnect('https://afs.googleusercontent.com');
  // Start the ads.js download in parallel with HTML parse — otherwise the article page waits
  // for React to hydrate before even requesting it (measured 1–3s chip-render delay on mobile,
  // Sep 2026), which drops paid visitors before chips appear. High fetch priority since this
  // script is on the critical monetization path.
  preload('https://www.google.com/adsense/search/ads.js', { as: 'script', fetchPriority: 'high' });
  return null;
}
