import { env } from '@knn/config';
import { type TxClient, withSystem } from '@knn/db';

/**
 * FX rates (D15). All revenue/spend is stored in native minor units paired with a
 * USD conversion. We store `FxRate.rate` = USD per 1 unit of a currency for an IST
 * day; USD→USD is always 1. Rates are pulled daily (exchangerate.host) for the
 * distinct currencies in play (ad-account + AdSense). The fetch is best-effort and
 * injectable; `getUsdRate` is the read side used by attribution.
 */

export interface FxDeps {
  fetch: typeof fetch;
}

interface FxApiResponse {
  rates?: Record<string, number>;
}

/**
 * USD per 1 unit of `currency` on `day`. USD → 1. Prefers the exact-day rate, then
 * the most recent stored rate for the currency (rates move slowly), and finally 1.0
 * with a warning so a missing rate degrades to native≈USD rather than zeroing revenue.
 */
export async function getUsdRate(tx: TxClient, day: string, currency: string): Promise<number> {
  const cur = (currency || 'USD').toUpperCase();
  if (cur === 'USD') return 1;
  const exact = await tx.fxRate.findUnique({ where: { day_currency: { day, currency: cur } } });
  if (exact) return Number(exact.rate);
  const latest = await tx.fxRate.findFirst({ where: { currency: cur }, orderBy: { day: 'desc' } });
  if (latest) return Number(latest.rate);
  console.warn(`[fx] no rate for ${cur} on ${day}; falling back to 1.0`);
  return 1;
}

/**
 * Fetch USD→X rates for `day` and store X→USD (= 1/rate) in `fx_rates` (idempotent
 * upsert per currency). Skips USD. Returns the count stored. The provider returns
 * units-of-X per 1 USD; we invert to USD-per-1-X for `toUsdMinor`.
 */
export async function fetchAndStoreRates(
  day: string,
  currencies: string[],
  deps: FxDeps = { fetch },
): Promise<number> {
  const wanted = [...new Set(currencies.map((c) => (c || '').toUpperCase()).filter((c) => c && c !== 'USD'))];
  if (wanted.length === 0) return 0;

  const url = new URL(`${env.FX_API_URL.replace(/\/$/, '')}/${day}`);
  url.searchParams.set('base', 'USD');
  url.searchParams.set('symbols', wanted.join(','));
  if (env.FX_API_KEY) url.searchParams.set('access_key', env.FX_API_KEY);

  const res = await deps.fetch(url);
  if (!res.ok) throw new Error(`FX fetch failed (${res.status}) for ${day}`);
  const body = (await res.json()) as FxApiResponse;
  const rates = body.rates ?? {};

  let stored = 0;
  for (const cur of wanted) {
    const perUsd = rates[cur];
    if (!perUsd || !Number.isFinite(perUsd) || perUsd <= 0) continue;
    const usdPerUnit = 1 / perUsd;
    await withSystem((tx) =>
      tx.fxRate.upsert({
        where: { day_currency: { day, currency: cur } },
        create: { day, currency: cur, rate: usdPerUnit },
        update: { rate: usdPerUnit },
      }),
    );
    stored += 1;
  }
  return stored;
}

/**
 * Best-effort: refresh FX rates for `days` covering every ad-account currency in use,
 * so the stats pull can convert native spend → USD. Failures (no FX key, provider
 * down) are logged and swallowed — `getUsdRate` then falls back to a recent/1.0 rate.
 */
export async function ensureFxRatesForDays(days: string[], deps: FxDeps = { fetch }): Promise<void> {
  const accounts = await withSystem((tx) => tx.fbAdAccount.findMany({ distinct: ['currency'], select: { currency: true } }));
  const currencies = accounts.map((a) => a.currency);
  if (currencies.every((c) => (c || 'USD').toUpperCase() === 'USD')) return;
  for (const day of days) {
    try {
      await fetchAndStoreRates(day, currencies, deps);
    } catch (err) {
      console.warn(`[fx] could not refresh rates for ${day}:`, (err as Error).message);
    }
  }
}
