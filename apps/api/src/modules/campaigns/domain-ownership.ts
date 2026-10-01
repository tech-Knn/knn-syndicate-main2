import type { TxClient } from '@knn/db';

/**
 * A domain's owner can change after a campaign was built (Platform -> Domains -> Owner). The owner check runs when offers are SAVED,
 * so a draft already pointing at a domain that has since been given to another company could still be submitted, approved and
 * launched on it. This re-checks before each step that puts a campaign on a domain for the first time: submit, approve, launch.
 *
 * It never touches a campaign that is already running: pause / resume, budgets and the daily channel rollover do not call it.
 * A domain with no owner is shared and always fine.
 */
export async function domainOwnershipProblems(tx: TxClient, orgId: string, campaignId: string): Promise<string[]> {
  const offers = await tx.offer.findMany({
    where: { campaignId },
    select: { domain: { select: { host: true, ownerOrgId: true } } },
  });
  const hosts = [...new Set(offers.filter((o) => o.domain.ownerOrgId && o.domain.ownerOrgId !== orgId).map((o) => o.domain.host))].sort();
  return hosts.map((h) => `The website ${h} is no longer available to your company. Remove it from this campaign's destination websites and pick another one.`);
}
