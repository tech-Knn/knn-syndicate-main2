import type { Metadata } from 'next';
import { LegalPage } from '../_components/legal-page';
import { resolveSiteName } from '../_afs/site-config';

export const metadata: Metadata = { title: 'Disclaimer' };

export default async function DisclaimerPage() {
  const site = await resolveSiteName();
  return (
    <LegalPage title="Disclaimer">
      <p className="updated">Last updated: June 1, 2026</p>
      <p>
        The information provided by {site} is for general informational purposes only. All content is
        provided in good faith; however, we make no representation or warranty of any kind, express or
        implied, regarding the accuracy, adequacy, validity, reliability, or completeness of any information
        on the site.
      </p>
      <h2>Not professional advice</h2>
      <p>
        Our articles are not a substitute for professional advice. Before making decisions based on financial,
        legal, medical, or other professional matters, you should consult an appropriately qualified
        professional. Your reliance on any information on this site is solely at your own risk.
      </p>
      <h2>External links</h2>
      <p>
        This site and the advertising shown on it may contain links to third-party websites or content. We do
        not warrant, endorse, or assume responsibility for the accuracy or reliability of any information
        offered by third-party sites.
      </p>
      <h2>Advertising</h2>
      <p>
        {site} displays advertising, including ads served by third parties such as Google. Advertisements do
        not constitute an endorsement or recommendation by {site}. See our <a href="/privacy">Privacy
        Policy</a> for how advertising works on this site.
      </p>
    </LegalPage>
  );
}
