import { NextResponse } from 'next/server';

/**
 * Domain liveness probe. The super-admin Domains tool hits `https://{host}/api/site-verify`
 * to confirm a registered domain's DNS actually points at this article app (i.e. it's
 * served by us). Returns the requesting host so the tool can sanity-check it.
 */
export const dynamic = 'force-dynamic';

export function GET(request: Request): NextResponse {
  const host = request.headers.get('host') ?? '';
  return NextResponse.json({ ok: true, app: 'knn-article', host });
}
