import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import Script from 'next/script';
import './globals.css';
import { ResourceHints } from './resource-hints';

export const metadata: Metadata = {
  title: 'Articles',
  description: 'Editorial content.',
};

// Microsoft Clarity project id — baked at build time (NEXT_PUBLIC_*). When unset
// the script is not emitted at all, so local dev / tests never phone home.
const CLARITY_ID = process.env.NEXT_PUBLIC_CLARITY_PROJECT_ID;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        {/* Warm Google's ad origins for the whole funnel (hydration-safe; see ResourceHints). */}
        <ResourceHints />
        {children}
        {/* Microsoft Clarity — session replay + heatmaps for the RSOC funnel. Loaded after
         *  the page is interactive so it doesn't block first paint / Core Web Vitals. */}
        {CLARITY_ID && (
          <Script id="ms-clarity" strategy="afterInteractive">
            {`(function(c,l,a,r,i,t,y){c[a]=c[a]||function(){(c[a].q=c[a].q||[]).push(arguments)};t=l.createElement(r);t.async=1;t.src="https://www.clarity.ms/tag/"+i;y=l.getElementsByTagName(r)[0];y.parentNode.insertBefore(t,y);})(window,document,"clarity","script","${CLARITY_ID}");`}
          </Script>
        )}
      </body>
    </html>
  );
}
