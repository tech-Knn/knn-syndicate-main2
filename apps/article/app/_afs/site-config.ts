import { headers } from 'next/headers';
import type { SiteConfig } from './csa';

/**
 * Resolve the AFS monetization config for the CURRENT request's host (Phase D
 * funnel rewire). Each registered Domain maps to one AFS account ⇒ its pubId; the
 * domain carries its own styleId/adsafe. This is what lets a single article app
 * serve many websites, each monetizing under its OWN AFS account.
 *
 * Falls back to the build-time env (`NEXT_PUBLIC_AFS_*`) when the host isn't
 * registered or the API is unreachable — so single-domain deploys and local dev
 * keep working unchanged. Server-only (reads the request Host header).
 */

// articles.<domain> is a different origin than the API (app.<domain>), so the
// server-side fetch needs an absolute base. Matches a/[slug]/page.tsx.
const API_BASE =
  process.env.ARTICLE_API_BASE ?? process.env.NEXT_PUBLIC_API_BASE ?? 'http://localhost:3000';

/** Build-time env defaults (single-domain / local dev / unregistered host / API miss). */
function envConfig(): SiteConfig {
  return {
    pubId: process.env.NEXT_PUBLIC_AFS_PUB_ID ?? '',
    styleId: process.env.NEXT_PUBLIC_AFS_STYLE_ID ?? '',
    adsafe: process.env.NEXT_PUBLIC_AFS_ADSAFE || 'medium',
    adtest: process.env.NEXT_PUBLIC_AFS_ADTEST === 'on',
  };
}

interface SiteConfigResponse {
  pubId?: string;
  styleId?: string | null;
  adsafe?: string | null;
}

export async function resolveSiteConfig(): Promise<SiteConfig> {
  const env = envConfig();
  let host = '';
  try {
    host = (await headers()).get('host') ?? '';
  } catch {
    return env;
  }
  if (!host) return env;
  try {
    // Cached per host (config changes rarely); the API also sends cache-control.
    const res = await fetch(`${API_BASE}/api/public/site-config?host=${encodeURIComponent(host)}`, {
      next: { revalidate: 300 },
    });
    if (!res.ok) return env; // 404 (unregistered) or error → env defaults
    const data = (await res.json()) as SiteConfigResponse;
    if (!data.pubId) return env;
    return {
      pubId: data.pubId,
      // adtest is a global build toggle, not a per-domain setting.
      adtest: env.adtest,
      styleId: data.styleId || env.styleId,
      adsafe: data.adsafe || env.adsafe,
    };
  } catch {
    return env;
  }
}
