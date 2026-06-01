import type { Metadata } from 'next';
import { LegalPage } from '../_components/legal-page';
import { resolveSiteName } from '../_afs/site-config';

export const metadata: Metadata = { title: 'Copyright' };

export default async function CopyrightPage() {
  const site = await resolveSiteName();
  const year = new Date().getFullYear();
  return (
    <LegalPage title="Copyright Notice">
      <p className="updated">Last updated: June 1, 2026</p>
      <p>
        © {year} {site}. All rights reserved. All content on this website — including articles, text,
        graphics, logos, and the selection and arrangement thereof — is the property of {site} or its content
        suppliers and is protected by copyright and other intellectual-property laws.
      </p>
      <h2>Permitted use</h2>
      <p>
        You may view and share links to our pages for personal, non-commercial use. You may quote a short
        excerpt with clear attribution and a link back to the original page.
      </p>
      <h2>Restrictions</h2>
      <p>
        You may not reproduce, republish, distribute, or create derivative works from our content — in whole
        or in substantial part — without our prior written permission.
      </p>
      <h2>Copyright complaints</h2>
      <p>
        We respect the intellectual-property rights of others. If you believe content on this site infringes
        your copyright, please notify us through our <a href="/contact">Contact</a> page with: a description
        of the work, the URL of the allegedly infringing material, your contact details, and a statement made
        in good faith. We will review and respond to valid notices promptly.
      </p>
    </LegalPage>
  );
}
