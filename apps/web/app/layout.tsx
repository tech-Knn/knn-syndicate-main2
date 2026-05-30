import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';
import { UIProvider } from '@/components/ui';
import { AuthProvider } from './providers';

export const metadata: Metadata = {
  title: 'KNN Syndicate — Search Arbitrage Platform',
  description: 'Launch Facebook ads, monetize with AFS, attribute revenue in real time.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <AuthProvider>
          <UIProvider>{children}</UIProvider>
        </AuthProvider>
      </body>
    </html>
  );
}
