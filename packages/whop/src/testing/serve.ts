import { startMockWhop } from './mock-whop.js';

/**
 * Run the mock Whop API on a fixed port so the dashboard can be tried without a Whop account:
 *   pnpm --filter @knn/whop mock
 * then start the API with WHOP_ADS_ENABLED=true WHOP_API_BASE=http://127.0.0.1:4919/api/v1 (and
 * WHOP_SANDBOX_API_BASE the same), and turn Whop Ads on for a company in Platform → Companies.
 * Not for production: the keys below are public.
 */
async function main(): Promise<void> {
  const port = Number(process.env.MOCK_WHOP_PORT ?? 4919);
  const mock = await startMockWhop({ port });
  mock.addBusiness({ bizId: 'biz_DEMO1234', apiKey: 'whop_demo_key_ready_0001', title: 'Demo Ads Co' });
  mock.addBusiness({
    bizId: 'biz_SETUP5678',
    apiKey: 'whop_demo_key_setup_0002',
    title: 'Needs Setup Co',
    agreement: 'pending_signature',
    payment: null,
    pages: [],
    pixel: { installed: false, last_seen_days: null, last_fired_days: {}, firing_data_ok: true },
  });
  mock.addBusiness({
    bizId: 'biz_LIMITED9012',
    apiKey: 'whop_demo_key_limited_0003',
    title: 'Limited Key Co',
    permissions: ['ad_campaign:basic:read'],
  });
  console.log(`Mock Whop API on ${mock.baseUrl}`);
  console.log('  biz_DEMO1234     key whop_demo_key_ready_0001    everything ready');
  console.log('  biz_SETUP5678    key whop_demo_key_setup_0002    agreement, payment, page and pixel still to do');
  console.log('  biz_LIMITED9012  key whop_demo_key_limited_0003  key is missing permissions');
}
void main();
