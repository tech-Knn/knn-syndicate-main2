import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: 'Articles',
  description: 'Editorial content.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      {/* Warm Google's ad origins for the WHOLE funnel. Both the article (content) page and
          /search load ads.js + serve from syndicatedsearch.goog, so preconnecting here means
          the TLS handshake is already done by the time the user clicks through to /search —
          the ad request on the money page pays ~0 connection cost. React 19 hoists these to
          <head>. */}
      <link rel="preconnect" href="https://www.google.com" />
      <link rel="preconnect" href="https://syndicatedsearch.goog" />
      <link rel="preconnect" href="https://afs.googleusercontent.com" />
      <link rel="dns-prefetch" href="https://www.google.com" />
      <link rel="dns-prefetch" href="https://syndicatedsearch.goog" />
      <body>{children}</body>
    </html>
  );
}
