'use client';

import { useEffect, useState } from 'react';
import { IconAlert, IconGlobe } from '@/components/icons';
import { Badge, Button, Skeleton } from '@/components/ui';
import { campaigns, publicSite, type PublicSiteConfig } from '@/lib/api';
import type { Campaign, OfferRow } from '@/lib/types';
import styles from './campaign.module.css';
import { CopyField, toneClass } from './parts';
import { useAuth } from '../../../providers';
import { HAS_DELIVERY, funnelOf, goLink, networkName, routingVisibility } from './status';

/** One offer (a money website) with the publisher id and style its landing page really uses. */
interface MoneySite {
  offer: OfferRow;
  config: PublicSiteConfig | null;
}

function useMoneySites(campaignId: string, enabled: boolean, withConfig: boolean): { sites: MoneySite[] | null; failed: boolean; retry: () => void } {
  const [sites, setSites] = useState<MoneySite[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    setFailed(false);
    void campaigns
      .offers(campaignId)
      .then(async (offers) => {
        // The publisher id and style are only ever shown to the platform, so nobody else's page even asks for them.
        const configs = await Promise.all(offers.map((o) => (withConfig ? publicSite.config(o.host).catch(() => null) : Promise.resolve(null))));
        if (alive) setSites(offers.map((offer, i) => ({ offer, config: configs[i] ?? null })));
      })
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [campaignId, enabled, withConfig, tick]);
  return { sites, failed, retry: () => setTick((t) => t + 1) };
}

/** Where every click goes, written out: the go-link, the money page (with its channel and style) and the white page. */
export function RoutingTab({ campaign: c }: { campaign: Campaign }) {
  const { user } = useAuth();
  const see = routingVisibility(user?.role);
  const launched = Boolean(c.redirectDomainHost);
  // A campaign that ran before routing details were recorded has no go-link host or white domain on file.
  const legacy = !launched && HAS_DELIVERY.has(c.status);
  const funnel = funnelOf(c);
  const net = networkName(c);
  const { sites, failed, retry } = useMoneySites(c.id, launched || legacy, see.publisherAndStyle);
  const paid = sites?.filter((s) => s.offer.kind === 'PAID') ?? [];
  const organic = sites?.find((s) => s.offer.kind === 'ORGANIC');
  const ads = c.adSets.flatMap((s) => s.ads);

  if (!launched && !legacy) {
    return (
      <section className={styles.panel}>
        <div className={styles.empty}>
          <IconGlobe size={26} />
          <strong>Routing is set when the campaign launches</strong>
          <span>The go-link host, the white page and the landing site are chosen at launch, and all of it shows up here.</span>
        </div>
      </section>
    );
  }

  const main = paid[0];
  return (
    <div className={styles.stack}>
      {legacy && (
        <div className={`${styles.note} ${toneClass('brand')}`}>
          <IconAlert size={16} />
          <span>
            <strong>This campaign ran before routing details were recorded,</strong> so its go-link host and white page are not on file and are not shown. The websites it sends paid clicks to are below.
          </span>
        </div>
      )}
      {!legacy && (
      <section className={styles.panel}>
        <div className={styles.panelHead}>
          <div>
            <h3 className={styles.panelTitle}>How a click travels</h3>
            <p className={styles.panelSub}>The redirect link decides at the edge, in milliseconds, which page a visitor gets.</p>
          </div>
        </div>
        <div className={styles.flow}>
          <div className={styles.node}>
            <span className={styles.nodeLabel}>1 · Ad click</span>
            <span className={styles.nodeTitle}>{net} ad</span>
            <span className={styles.nodeSub}>Opens the ad’s own go-link.</span>
          </div>
          <span className={styles.arrow} aria-hidden />
          <div className={styles.node}>
            <span className={styles.nodeLabel}>2 · Go-link</span>
            <span className={styles.nodeTitle}>{c.redirectDomainHost}</span>
            <span className={styles.nodeSub}>Paid click or not? Checked on every visit.</span>
          </div>
          <span className={styles.arrow} aria-hidden />
          <div className={styles.lanes}>
            <div className={`${styles.lane} ${toneClass('success')}`}>
              <span className={styles.laneTag}>Paid click</span>
              <div className={`${styles.node} ${styles.nodeAccent}`}>
                <span className={styles.nodeLabel}>Money page</span>
                {!sites && !failed ? (
                  <Skeleton className={styles.skel} />
                ) : main ? (
                  <>
                    <span className={styles.nodeTitle}>{main.offer.host}</span>
                    <span className={styles.nodeSub}>
                      Channel {main.offer.channelId ?? 'pending'}
                      {see.publisherAndStyle ? ` · Style ${main.config?.styleId ?? 'default'}` : ''}
                      {paid.length > 1 ? ` · +${paid.length - 1} more site${paid.length === 2 ? '' : 's'}` : ''}
                    </span>
                  </>
                ) : (
                  <span className={styles.nodeSub}>{failed ? 'Could not load the landing site.' : 'No paid website set: the default article site is used.'}</span>
                )}
              </div>
            </div>
            <div className={`${styles.lane} ${toneClass(funnel === 'CLOAKER' ? 'brand' : 'neutral')}`}>
              <span className={styles.laneTag}>Everyone else</span>
              <div className={`${styles.node} ${styles.nodeAccent}`}>
                <span className={styles.nodeLabel}>{funnel === 'CLOAKER' ? 'White page' : 'Plain article'}</span>
                <span className={styles.nodeTitle}>
                  {funnel === 'CLOAKER' ? (see.whiteHost ? c.whiteDomainHost : 'A clean white page') : (organic?.offer.host ?? 'The article, without ad tracking')}
                </span>
                <span className={styles.nodeSub}>
                  {funnel === 'CLOAKER'
                    ? 'A clean content site for reviewers, bots and organic visits.'
                    : 'Normal mode: there is no white page, so anyone who is not a paid click sees the plain article.'}
                </span>
              </div>
            </div>
          </div>
        </div>
      </section>
      )}

      {c.adProvider === 'WHOP' && see.cloakNote && !legacy && (
        <div className={`${styles.note} ${toneClass('warning')}`}>
          <IconAlert size={16} />
          <span>
            <strong>How Whop clicks are recognised.</strong> Whop does not pass on Meta’s ad id, so a paid click is recognised by Whop’s own markers (<code>utm_whop=true</code> or its campaign, ad group and ad ids), not by the per-ad check Facebook campaigns use.
            Anyone who copies a full ad link with those markers reaches the money page.
          </span>
        </div>
      )}

      <div className={legacy ? styles.stack : styles.twoCol}>
        {!legacy && (
        <section className={styles.panel}>
          <div className={styles.panelHead}>
            <div>
              <h3 className={styles.panelTitle}>Go-links</h3>
              <p className={styles.panelSub}>One per ad, so each ad is measured on its own. {net} adds its tracking parameters to these when the ad runs.</p>
            </div>
          </div>
          <div className={styles.linkRows}>
            {ads.map((ad) => (
              <div key={ad.id} className={styles.linkRow}>
                <span className={styles.cellName}>{ad.name}</span>
                <CopyField value={goLink(c.redirectDomainHost!, ad.redirectId)} label={`go-link for ${ad.name}`} />
              </div>
            ))}
          </div>
        </section>
        )}

        <section className={styles.panel}>
          <div className={styles.panelHead}>
            <div>
              <h3 className={styles.panelTitle}>Money pages</h3>
              <p className={styles.panelSub}>The sites paid clicks land on{see.publisherAndStyle ? ', with the Google settings each one really uses' : ''}.</p>
            </div>
          </div>
          {!sites && !failed ? (
            <Skeleton className={styles.skel} />
          ) : !sites || sites.length === 0 ? (
            <div className={styles.empty}>
              {failed ? (
                <>
                  <strong>Could not load the websites</strong>
                  <Button variant="secondary" onClick={retry}>
                    Try again
                  </Button>
                </>
              ) : (
                <>
                  <strong>No websites are attached to this campaign’s offers</strong>
                  <span>It sends paid clicks to the default article site.</span>
                </>
              )}
            </div>
          ) : (
            <div className={styles.stack}>
              {sites.map(({ offer, config }) => (
                <dl key={offer.id} className={styles.facts}>
                  <dt>Website</dt>
                  <dd>{offer.host}</dd>
                  <dt>Traffic</dt>
                  <dd>
                    <Badge tone={offer.kind === 'PAID' ? 'brand' : 'neutral'}>{offer.kind.toLowerCase()}</Badge> · {offer.weightPct}% of clicks
                  </dd>
                  <dt>AFS channel</dt>
                  <dd>{offer.channelId ?? 'Pending'}</dd>
                  {see.publisherAndStyle && (
                    <>
                      <dt>Style id</dt>
                      <dd>{config?.styleId ?? 'Default (set on the article server)'}</dd>
                      <dt>Publisher</dt>
                      <dd>{config?.pubId ?? 'Not registered'}</dd>
                    </>
                  )}
                  {offer.articleTitle && (
                    <>
                      <dt>Article</dt>
                      <dd>{offer.articleTitle}</dd>
                    </>
                  )}
                </dl>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
