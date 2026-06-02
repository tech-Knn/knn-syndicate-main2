/**
 * Funnel mode — whether a buyer's campaigns run the NORMAL straight-monetized redirect or the
 * CLOAKER token + ad-id-verified funnel (with a separate clean white site as fallback + display link).
 *
 * Resolution (decided with the operator):
 *   - Super-admin gates a COMPANY: `cloakingEnabled`. If off, every buyer there is NORMAL — full stop.
 *   - Within an enabled company, the org has a `defaultFunnelMode` its buyers inherit…
 *   - …unless a per-buyer override (`userFunnelMode`) is set (by super-admin or the company admin).
 *
 * Pure + dependency-free so it's the single source of truth for the API, the launch pipeline, and
 * the web wizard (which hides the fallback/display-link fields for cloaker buyers).
 */

export type FunnelMode = 'NORMAL' | 'CLOAKER';

export const FUNNEL_MODES: readonly FunnelMode[] = ['NORMAL', 'CLOAKER'] as const;

export interface FunnelModeInputs {
  /** Org-level master gate (super-admin only). False → buyer is always NORMAL. */
  cloakingEnabled: boolean;
  /** Org-level default mode buyers inherit (only meaningful when cloakingEnabled). */
  defaultFunnelMode: FunnelMode;
  /** Per-buyer override; null/undefined = inherit the org default. */
  userFunnelMode?: FunnelMode | null;
}

/** The mode a specific buyer's campaigns actually run in. */
export function effectiveFunnelMode(i: FunnelModeInputs): FunnelMode {
  if (!i.cloakingEnabled) return 'NORMAL'; // master gate off → no cloaking, no exceptions
  return i.userFunnelMode ?? i.defaultFunnelMode;
}

/** Convenience: does this buyer run the cloaker funnel? */
export function isCloakerBuyer(i: FunnelModeInputs): boolean {
  return effectiveFunnelMode(i) === 'CLOAKER';
}
