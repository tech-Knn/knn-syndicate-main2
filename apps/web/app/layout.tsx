import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';
import { THEME_INIT_SCRIPT, ThemeProvider } from '@/components/theme';
import { UIProvider } from '@/components/ui';
import { AuthProvider } from './providers';

export const metadata: Metadata = {
  title: {
    default: 'KNN Syndicate — Search Arbitrage Platform',
    template: '%s · KNN Syndicate',
  },
  description: 'Launch Facebook ads, monetize with AFS, attribute revenue in real time.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Sets data-theme before first paint (no flash of the wrong theme). */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body>
        <ThemeProvider>
          <AuthProvider>
            <UIProvider>{children}</UIProvider>
          </AuthProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
