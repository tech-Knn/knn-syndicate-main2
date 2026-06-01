import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { LegalPage } from '../_components/legal-page';
import { resolveSiteName } from '../_afs/site-config';

export const metadata: Metadata = { title: 'Contact' };

export default async function ContactPage() {
  const site = await resolveSiteName();
  const host = ((await headers()).get('host') ?? '').toLowerCase().replace(/:\d+$/, '');
  // Derive a contact address from the registrable domain (strip the articles/www/app prefix).
  const domain = host.replace(/^(articles|www|app)\./, '');
  const email = domain.includes('.') ? `contact@${domain}` : null;

  return (
    <LegalPage title="Contact Us">
      <p>
        We&rsquo;d love to hear from you. Whether you have a question about one of our articles, a
        correction, a partnership enquiry, or feedback on {site}, please get in touch.
      </p>
      {email ? (
        <p>
          Email: <a href={`mailto:${email}`}>{email}</a>
        </p>
      ) : null}
      <p>
        We aim to respond to all genuine enquiries within a few business days. For privacy or data requests,
        please mention &ldquo;Privacy&rdquo; in your subject line and see our{' '}
        <a href="/privacy">Privacy Policy</a>.
      </p>
    </LegalPage>
  );
}
