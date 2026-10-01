/**
 * What the Analytics page shows when it opens: today, and only the campaigns that are live. A media buyer opening the page
 * wants the campaigns spending right now, not every draft and archived one they ever made. Everything else is one click
 * away (the status chips, "Show all", the date picker).
 */
export const DEFAULT_STATUSES: readonly string[] = ['ACTIVE'];

export const defaultStatusSel = (): Set<string> => new Set(DEFAULT_STATUSES);

/** True when `sel` is exactly the opening view's status selection. */
export function isDefaultStatusSel(sel: ReadonlySet<string>): boolean {
  return sel.size === DEFAULT_STATUSES.length && DEFAULT_STATUSES.every((s) => sel.has(s));
}

/**
 * The status chips to draw: every status present in the data, plus any that is selected but has no campaign in the
 * range (otherwise the opening "Active" filter would be invisible, and impossible to switch off, on a day nothing is live).
 */
export function chipStatuses(present: Iterable<string>, selected: ReadonlySet<string>): string[] {
  return [...new Set([...present, ...selected])].sort();
}

/**
 * The status selection after landing on a campaign through a deep link (`?campaign=<id>`): the opening filter is dropped when
 * it would hide that very campaign (a paused one opened from its own page), otherwise left as it is.
 */
export function statusSelForDeepLink(sel: ReadonlySet<string>, campaignStatus: string): Set<string> {
  return sel.size === 0 || sel.has(campaignStatus) ? new Set(sel) : new Set();
}
