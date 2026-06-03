import { withSystem } from '@knn/db';
import { sendNotification } from '../lib/notify.js';

export type DomainProbe = (host: string, path: string) => Promise<{ ok: boolean; lastCheck: string }>;

/** Ping a host; 2xx/3xx = reachable (the redirect Worker 302s, the white site 200s). */
const defaultProbe: DomainProbe = async (host, path) => {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8_000);
    const res = await fetch(`https://${host}${path}`, { signal: ctrl.signal, redirect: 'manual' }).finally(() => clearTimeout(t));
    const ok = res.status >= 200 && res.status < 400;
    return { ok, lastCheck: ok ? `ok ${res.status}` : `unexpected ${res.status}` };
  } catch (err) {
    return { ok: false, lastCheck: `unreachable: ${(err as Error).message}`.slice(0, 200) };
  }
};

/**
 * Domain health sweep (cron): ping every ACTIVE redirect (`go.*`, `/health/live`) and white domain
 * (homepage), record `healthy` + `lastCheck`, and NOTIFY the super-admin when a domain transitions
 * healthy → down — a flagged/broken host is silent revenue loss (launch rotation skips unhealthy
 * domains, and the super-admin panels surface the state). Idempotent; best-effort per host.
 */
export async function sweepDomainHealth(probe: DomainProbe = defaultProbe): Promise<{ checked: number; down: number }> {
  // A super-admin to attribute platform-level alerts to (the notify sink needs org/user).
  const sa = await withSystem((tx) => tx.user.findFirst({ where: { role: 'SUPER_ADMIN' }, select: { id: true, orgId: true } }));
  const alert = (title: string, body: string): void => {
    if (sa) sendNotification({ orgId: sa.orgId, userId: sa.id, type: 'domain_down', title, body });
    else console.warn(`[domain-health] ${title} — ${body}`);
  };

  let checked = 0;
  let down = 0;

  const redirects = await withSystem((tx) =>
    tx.redirectDomain.findMany({ where: { isActive: true }, select: { id: true, host: true, healthy: true } }),
  );
  for (const d of redirects) {
    const { ok, lastCheck } = await probe(d.host, '/health/live');
    checked++;
    if (!ok) down++;
    await withSystem((tx) =>
      tx.redirectDomain.update({ where: { id: d.id }, data: { healthy: ok, lastCheck, verifiedAt: ok ? new Date() : undefined } }),
    );
    if (d.healthy && !ok) alert(`Redirect domain down: ${d.host}`, `Health check failed (${lastCheck}). New launches won't rotate onto it.`);
  }

  const whites = await withSystem((tx) =>
    tx.whiteDomain.findMany({ where: { isActive: true }, select: { id: true, host: true, healthy: true } }),
  );
  for (const d of whites) {
    const { ok, lastCheck } = await probe(d.host, '/');
    checked++;
    if (!ok) down++;
    await withSystem((tx) =>
      tx.whiteDomain.update({ where: { id: d.id }, data: { healthy: ok, lastCheck, verifiedAt: ok ? new Date() : undefined } }),
    );
    if (d.healthy && !ok) alert(`White domain down: ${d.host}`, `Health check failed (${lastCheck}). The cloaker fallback + display link are affected.`);
  }

  if (down > 0) console.warn(`[domain-health] sweep: ${down}/${checked} active domain(s) DOWN`);
  return { checked, down };
}
