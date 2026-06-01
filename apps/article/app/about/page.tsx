import type { Metadata } from 'next';
import { LegalPage } from '../_components/legal-page';
import { resolveSiteName } from '../_afs/site-config';

export const metadata: Metadata = { title: 'About' };

export default async function AboutPage() {
  const site = await resolveSiteName();
  return (
    <LegalPage title={`About ${site}`}>
      <p>
        {site} publishes practical, easy-to-read guides on everyday topics — home and lifestyle, money and
        consumer choices, health and wellbeing, and more. Our goal is simple: give readers clear, useful
        information that helps them make better-informed decisions.
      </p>
      <p>
        Each article is written to be approachable and to-the-point, with the context you need and none of
        the filler you don&rsquo;t. We continually review and update our content so it stays accurate and
        relevant.
      </p>
      <h2>Our content</h2>
      <p>
        Articles are intended for general information only and are not professional advice. Where a topic
        touches on financial, legal, medical, or similar matters, please consult a qualified professional
        before acting. See our <a href="/disclaimer">Disclaimer</a> for details.
      </p>
      <h2>Advertising</h2>
      <p>
        {site} is supported by advertising, including ads served by third-party networks such as Google. This
        lets us keep our content free to read. See our <a href="/privacy">Privacy Policy</a> for how
        advertising cookies work and how to manage them.
      </p>
      <h2>Get in touch</h2>
      <p>
        We welcome feedback and corrections — reach us through our <a href="/contact">Contact</a> page.
      </p>
    </LegalPage>
  );
}
