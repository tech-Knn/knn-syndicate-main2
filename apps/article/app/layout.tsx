import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';
import { ResourceHints } from './resource-hints';

export const metadata: Metadata = {
  title: 'Articles',
  description: 'Editorial content.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        {/* Warm Google's ad origins for the whole funnel (hydration-safe; see ResourceHints). */}
        <ResourceHints />
        {children}
      </body>
    </html>
  );
}
