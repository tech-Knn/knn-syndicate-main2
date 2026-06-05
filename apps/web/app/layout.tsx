import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import localFont from 'next/font/local';
import './globals.css';
import { THEME_INIT_SCRIPT, ThemeProvider } from '@/components/theme';
import { UIProvider } from '@/components/ui';
import { AuthProvider } from './providers';

// Self-hosted (vendored) Inter variable — premium type without any build-time network fetch.
const inter = localFont({
  src: './fonts/inter-variable.woff2',
  variable: '--font-inter',
  display: 'swap',
  weight: '100 900',
});

export const metadata: Metadata = {
  title: {
    default: 'KNN Syndicate — Search Arbitrage Platform',
    template: '%s · KNN Syndicate',
  },
  description: 'Launch Facebook ads, monetize with AFS, attribute revenue in real time.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={inter.variable} suppressHydrationWarning>
      <body>
        {/* Sets data-theme before first paint (no flash). First body child + not in a manual
            <head> — Next manages <head> via metadata and can reorder it, which broke hydration. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        <ThemeProvider>
          <AuthProvider>
            <UIProvider>{children}</UIProvider>
          </AuthProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
