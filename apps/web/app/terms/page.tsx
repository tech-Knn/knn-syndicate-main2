import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Terms of Service',
  description: 'The terms that govern your use of the KNN Syndicate platform.',
};

const UPDATED = 'October 6, 2026';

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

export default function TermsPage() {
  return (
    <main style={wrap}>
      <span className="eyebrow">KNN Syndicate</span>
      <h1 style={h1}>Terms of Service</h1>
      <p style={muted}>Last updated: {UPDATED}</p>

      <p style={{ marginTop: '1.25rem' }}>
        These Terms of Service (&ldquo;Terms&rdquo;) govern your use of the KNN Syndicate platform
        (&ldquo;we&rdquo;, &ldquo;us&rdquo;, the &ldquo;Platform&rdquo;), a self-hosted advertising-management
        platform that lets authorized users launch and manage advertising campaigns, route traffic to monetized content, and
        measure performance. By creating an account, connecting a third-party service, or otherwise using the Platform you
        agree to these Terms. If you do not agree, do not use the Platform.
      </p>

      <h2 style={h2}>Who can use the Platform</h2>
      <p>
        The Platform is for authorized media buyers, company administrators, and platform administrators who have been
        granted access by their organization. You must be at least 18 years old and legally capable of entering into these
        Terms on your own behalf or on behalf of the organization you represent. Accounts are personal and non-transferable;
        you are responsible for keeping your credentials safe and for all activity that occurs under your account.
      </p>

      <h2 style={h2}>Your advertising responsibilities</h2>
      <ul>
        <li style={li}>
          You are responsible for the campaigns you launch, including the creative, targeting, destination websites, and
          offers. You will comply with the policies of every network you advertise through, including Meta&rsquo;s{' '}
          <a href="https://www.facebook.com/policies/ads/" style={{ color: 'var(--rust)' }}>Advertising Policies</a>,
          Meta&rsquo;s{' '}
          <a href="https://developers.facebook.com/terms/" style={{ color: 'var(--rust)' }}>Platform Terms</a>, Google&rsquo;s{' '}
          <a href="https://support.google.com/adspolicy/answer/6008942" style={{ color: 'var(--rust)' }}>Ads policies</a>,
          Google&rsquo;s{' '}
          <a href="https://support.google.com/adsense/answer/48182" style={{ color: 'var(--rust)' }}>AdSense Program policies</a>,
          and Whop&rsquo;s advertising policies, as applicable to the networks you use.
        </li>
        <li style={li}>
          You will advertise only on ad accounts, Pages, pixels, and businesses that you own or have been authorized to use
          by their owner. You will not use the Platform to run advertising on behalf of a third party without their explicit
          permission.
        </li>
        <li style={li}>
          You will not use the Platform to promote illegal content, impersonate others, infringe intellectual property, run
          deceptive or misleading advertising, or circumvent the content moderation of any ad network you connect.
        </li>
      </ul>

      <h2 style={h2}>Third-party services you connect</h2>
      <p>
        The Platform integrates with third-party services at your direction, including Facebook/Meta, Google AdSense, Whop,
        and others you may add. When you connect a third-party service you grant us permission to call its APIs on your
        behalf using the access you authorize. You remain subject to each service&rsquo;s own terms, and your access to our
        features is contingent on that service continuing to allow the integration. We are not responsible for the
        availability, decisions, or billing of any third-party service.
      </p>

      <h2 style={h2}>Data and privacy</h2>
      <p>
        Our handling of personal and account data is described in our{' '}
        <a href="/privacy" style={{ color: 'var(--rust)' }}>Privacy Policy</a>, which is incorporated into these Terms by
        reference. Access tokens are encrypted at rest and are never logged in plaintext. You can disconnect any third-party
        integration at any time from the dashboard, which revokes the Platform&rsquo;s access and deletes the stored
        credentials for that integration.
      </p>

      <h2 style={h2}>Acceptable use</h2>
      <ul>
        <li style={li}>No attempts to break authentication, bypass tenant isolation, or access data belonging to another organization.</li>
        <li style={li}>No automated scraping, load testing, or denial-of-service directed at the Platform or the third-party services it connects to.</li>
        <li style={li}>No uploading of malware, exfiltration tooling, or content that violates applicable law.</li>
        <li style={li}>No sharing of your account or credentials with others; one person per account.</li>
      </ul>

      <h2 style={h2}>Service availability</h2>
      <p>
        The Platform is provided &ldquo;as is&rdquo; and &ldquo;as available&rdquo;. We may update, improve, or temporarily
        restrict access for maintenance, security, or legal reasons. We make no guarantee of uninterrupted operation and we
        are not responsible for issues caused by third-party services (such as a Meta rate limit, a Google policy decision,
        or a Whop outage).
      </p>

      <h2 style={h2}>Fees</h2>
      <p>
        The Platform itself is self-hosted. Any fees for the Platform, if any, are set by your organization&rsquo;s
        agreement with us separately from these Terms. You are solely responsible for all advertising spend you authorize on
        connected ad accounts and for all third-party fees charged by services you connect.
      </p>

      <h2 style={h2}>Suspension and termination</h2>
      <p>
        We may suspend or terminate your access if you violate these Terms, if a connected third-party service requires it,
        or to protect the Platform, its users, or the services it integrates with. You may stop using the Platform at any
        time; the sections of these Terms that by their nature should survive termination (ownership, disclaimers, limitation
        of liability, governing law) will continue to apply after your account ends.
      </p>

      <h2 style={h2}>Intellectual property</h2>
      <p>
        We retain all right, title, and interest in and to the Platform, including its software, design, and documentation.
        You retain all right, title, and interest in the content and campaigns you create. Nothing in these Terms grants you
        any license to our trademarks or branding beyond use strictly necessary to operate the Platform.
      </p>

      <h2 style={h2}>Disclaimer</h2>
      <p>
        To the fullest extent allowed by law, the Platform is provided without warranties of any kind, express or implied,
        including merchantability, fitness for a particular purpose, and non-infringement. We do not warrant that the
        Platform will meet your business objectives or that the results of advertising campaigns will match any projection.
      </p>

      <h2 style={h2}>Limitation of liability</h2>
      <p>
        To the fullest extent allowed by law, in no event will we be liable for any indirect, incidental, special,
        consequential, or punitive damages, including lost profits, lost revenue, lost data, or loss of goodwill, arising
        from or related to your use of the Platform.
      </p>

      <h2 style={h2}>Changes to these Terms</h2>
      <p>
        We may update these Terms from time to time; material changes will be reflected by the &ldquo;Last updated&rdquo;
        date above. Continued use of the Platform after an update constitutes acceptance of the updated Terms.
      </p>

      <h2 style={h2}>Governing law</h2>
      <p>
        These Terms are governed by the laws of India, without regard to its conflict of laws rules. Any dispute arising
        from these Terms or your use of the Platform will be brought in the courts located in Delhi, India, and you consent
        to the personal jurisdiction of those courts.
      </p>

      <h2 style={h2}>Contact</h2>
      <p style={muted}>
        Questions about these Terms: <a href="mailto:legal@rsoc.app" style={{ color: 'var(--rust)' }}>legal@rsoc.app</a>.
      </p>
    </main>
  );
}
