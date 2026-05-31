import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Privacy Policy',
  description: 'How KNN Syndicate collects, uses, and protects your data.',
};

const UPDATED = 'May 31, 2026';

const wrap: React.CSSProperties = {
  maxWidth: 760,
  margin: '0 auto',
  padding: '3rem 1.5rem 5rem',
  color: 'var(--cream)',
  fontSize: '0.98rem',
  lineHeight: 1.7,
};
const h1: React.CSSProperties = {
  fontFamily: 'var(--font-serif)',
  fontStyle: 'italic',
  fontSize: '2.1rem',
  marginBottom: '0.4rem',
};
const h2: React.CSSProperties = { fontSize: '1.15rem', fontWeight: 600, margin: '2rem 0 0.6rem' };
const muted: React.CSSProperties = { color: 'var(--muted)' };
const li: React.CSSProperties = { marginBottom: '0.35rem' };

export default function PrivacyPage() {
  return (
    <main style={wrap}>
      <span className="eyebrow">KNN Syndicate</span>
      <h1 style={h1}>Privacy Policy</h1>
      <p style={muted}>Last updated: {UPDATED}</p>

      <p style={{ marginTop: '1.25rem' }}>
        KNN Syndicate (&ldquo;we&rdquo;, &ldquo;us&rdquo;, the &ldquo;Platform&rdquo;) is a self-hosted advertising-management
        platform that lets authorized users launch and manage advertising campaigns, route traffic to monetized content,
        and measure performance. This policy explains what information we collect, how we use it, and the choices you have.
        We only process data needed to operate the Platform for the businesses and users who connect to it.
      </p>

      <h2 style={h2}>Information we collect</h2>
      <ul>
        <li style={li}>
          <strong>Account information</strong> — your name, email, role, and the organization you belong to, used to
          authenticate you and scope what you can access.
        </li>
        <li style={li}>
          <strong>Facebook / Meta data (via your authorization)</strong> — when you connect a Facebook account through
          Facebook Login, we access the assets you grant: ad accounts, Pages, and pixels, plus the access token needed to
          manage them on your behalf. We request the permissions <em>ads_management, ads_read, pages_show_list,
          pages_read_engagement,</em> and <em>business_management</em>. We do not collect your Facebook password.
        </li>
        <li style={li}>
          <strong>Campaign &amp; performance data</strong> — the campaigns, ad sets, ads, creatives, budgets, and the
          delivery/cost/conversion metrics returned by the advertising and analytics services you connect.
        </li>
        <li style={li}>
          <strong>Usage &amp; technical data</strong> — basic logs (IP address, browser/user-agent, timestamps) used for
          security, debugging, and conversion measurement.
        </li>
      </ul>

      <h2 style={h2}>How we use information</h2>
      <ul>
        <li style={li}>To create, launch, optimize, pause, and report on advertising campaigns you direct us to run.</li>
        <li style={li}>To attribute downstream revenue and conversions back to the originating ads, and show you ROI.</li>
        <li style={li}>To authenticate users, enforce role-based access, and keep the Platform secure.</li>
        <li style={li}>To maintain and improve the Platform and diagnose problems.</li>
      </ul>

      <h2 style={h2}>How we share information</h2>
      <p>
        We share data only as needed to provide the service: with <strong>Meta/Facebook</strong> (to manage your
        campaigns and send conversion events you authorize), with advertising-monetization and analytics providers you
        connect (such as <strong>Google AdSense</strong>), and with infrastructure providers that host the Platform. We do
        not sell your personal information.
      </p>

      <h2 style={h2}>Data retention &amp; security</h2>
      <p>
        Access tokens are <strong>encrypted at rest</strong> (AES-256-GCM) and are never logged in plaintext. We retain
        account, campaign, and performance data for as long as your account is active or as needed to provide the service,
        and delete or anonymize it on request or when no longer required.
      </p>

      <h2 style={h2}>Your choices &amp; data deletion</h2>
      <p>
        You can disconnect a Facebook account at any time from the dashboard, which removes its synced assets and stored
        token. You may request access to, correction of, or deletion of your personal data, or revoke the Platform&rsquo;s
        access to your Facebook assets in your{' '}
        <a href="https://www.facebook.com/settings?tab=business_tools" style={{ color: 'var(--rust)' }}>
          Facebook Business Integrations
        </a>{' '}
        settings. To request deletion, contact us using the details below.
      </p>

      <h2 style={h2}>Cookies</h2>
      <p>
        We use only the cookies/local storage necessary to keep you signed in and operate the dashboard. We do not use
        advertising cookies on this dashboard.
      </p>

      <h2 style={h2}>Changes to this policy</h2>
      <p>We may update this policy from time to time; material changes will be reflected by the &ldquo;Last updated&rdquo; date above.</p>

      <h2 style={h2}>Contact</h2>
      <p style={muted}>
        Questions or data requests: <a href="mailto:privacy@rsoc.app" style={{ color: 'var(--rust)' }}>privacy@rsoc.app</a>.
      </p>
    </main>
  );
}
