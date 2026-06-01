import type { Metadata } from 'next';
import { LegalPage } from '../_components/legal-page';
import { resolveSiteName } from '../_afs/site-config';

export const metadata: Metadata = { title: 'Privacy Policy' };

export default async function PrivacyPage() {
  const site = await resolveSiteName();
  return (
    <LegalPage title="Privacy Policy">
      <p className="updated">Last updated: June 1, 2026</p>
      <p>
        This Privacy Policy explains how {site} (&ldquo;we&rdquo;, &ldquo;us&rdquo;) collects, uses, and
        safeguards information when you visit our website. By using the site you agree to the practices
        described here.
      </p>

      <h2>Information we collect</h2>
      <p>
        We do not require you to create an account or submit personal information to read our content. Like
        most websites, our servers automatically record standard log data — your browser type, device,
        approximate location, referring page, and the pages you visit — to operate and secure the site and
        to understand how it is used.
      </p>

      <h2>Cookies and advertising</h2>
      <p>
        We use cookies and similar technologies to deliver and measure content and advertising. Third-party
        vendors, including Google, use cookies to serve ads based on your prior visits to this and other
        websites. Google&rsquo;s use of advertising cookies enables it and its partners to serve ads to you
        based on your visit to this site and/or other sites on the Internet.
      </p>
      <ul>
        <li>
          You may opt out of personalized advertising by visiting{' '}
          <a href="https://www.google.com/settings/ads" rel="noopener noreferrer">Google Ads Settings</a>.
        </li>
        <li>
          You can opt out of a third-party vendor&rsquo;s use of cookies for personalized advertising at{' '}
          <a href="https://www.aboutads.info/choices/" rel="noopener noreferrer">aboutads.info</a>.
        </li>
        <li>Most browsers let you refuse or delete cookies through their settings.</li>
      </ul>

      <h2>How we use information</h2>
      <p>
        We use the information above to operate, maintain, secure, and improve the site, to measure and
        serve relevant advertising, and to comply with legal obligations. We do not sell your personal
        information.
      </p>

      <h2>Third-party links</h2>
      <p>
        Our pages and advertising may link to third-party websites that we do not control. We are not
        responsible for the privacy practices or content of those sites; please review their policies.
      </p>

      <h2>Children&rsquo;s privacy</h2>
      <p>Our content is intended for a general audience and is not directed to children under 13.</p>

      <h2>Changes to this policy</h2>
      <p>
        We may update this Privacy Policy from time to time. Material changes will be reflected by the
        &ldquo;Last updated&rdquo; date above.
      </p>

      <h2>Contact</h2>
      <p>
        Questions about this policy can be sent through our <a href="/contact">Contact</a> page.
      </p>
    </LegalPage>
  );
}
