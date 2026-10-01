'use client';

import { type ChangeEvent, type KeyboardEvent, useCallback, useEffect, useId, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  AGE_BOUND_MAX,
  AGE_BOUND_MIN,
  ATTRIBUTION_WINDOWS,
  BID_STRATEGIES,
  WHOP_CTAS,
  WHOP_PLACEMENT,
  WHOP_SPECIAL_CATEGORY,
  ALL_COUNTRY_CODES,
  COUNTRIES,
  CTA_OPTIONS,
  DEVICE_PLATFORMS,
  GENDERS,
  MOBILE_OS,
  PLACEMENT_OPTIONS,
  SELECTABLE_OBJECTIVES,
  SPECIAL_AD_CATEGORIES,
  type AdProvider,
  type AttributionWindow,
  type BidStrategy,
  type CampaignDraftInput,
  type CampaignObjective,
  type ConversionType,
  type CreativeType,
  type CtaOption,
  type DevicePlatform,
  type Gender,
  type MobileOs,
  type PlacementMode,
  type PxeEvent,
  type SpecialAdCategory,
  countryName,
  goalRequiresPixel,
  findBlockedRcTerms,
  isValidPerformanceGoal,
  racValueIssues,
  rcBlockedMessage,
  WHOP_MIN_DAILY_BUDGET_CENTS,
  WHOP_SPECIAL_AGE_MAX,
  WHOP_SPECIAL_AGE_MIN,
  whopLaunchProblems,
  whopUnsupportedProblems,
} from '@knn/shared';
import { ApiError, auth, campaigns as campaignsApi, facebook, getStoredUser, uploads as uploadsApi, whop as whopApi } from '@/lib/api';
import { type Campaign, type FbAccount, type FbPage, type FbPixel, type OfferDomainOption, type WhopConnection } from '@/lib/types';
import { Banner, Button, Card, DateTimePicker, InfoTip, SearchSelect, Spinner } from './ui';
import styles from './campaign-wizard.module.css';

/* ── Schedule time zones ───────────────────────────────────────────────────────────────────────
 * Facebook reckons ad-set scheduling (start/end, daily-budget reset, dayparting) in the AD ACCOUNT's
 * timezone — that's the wall-clock Ads Manager shows, and what a buyer means when they type "9 AM".
 * So the picker's wall-clock ("YYYY-MM-DDTHH:mm") is interpreted in the ad account's IANA timezone,
 * converted to a UTC instant for storage + the FB API (which schedules that absolute time). When the
 * tz is unknown (no account picked yet / legacy rows) we fall back to the browser's local zone. */

/** A stored UTC instant → "YYYY-MM-DDTHH:mm" in the BROWSER's local zone (the no-timezone fallback). */
function isoToLocalInput(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** UTC offset (ms, + east of UTC) of an IANA `tz` at a given UTC instant — DST-aware. */
function tzOffsetMs(utcMs: number, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(utcMs));
  const get = (t: string): number => Number(parts.find((p) => p.type === t)?.value);
  const hour = get('hour') % 24; // some engines render midnight as 24
  return Date.UTC(get('year'), get('month') - 1, get('day'), hour, get('minute'), get('second')) - utcMs;
}

/** A wall-clock "YYYY-MM-DDTHH:mm" interpreted in IANA `tz` → the UTC ISO instant (DST-aware). */
function zonedToUtcIso(wall: string, tz: string): string {
  if (!tz) return new Date(wall).toISOString(); // fallback: browser-local
  const [date = '', time = ''] = wall.split('T');
  const [y, mo, d] = date.split('-').map(Number);
  const [h, mi] = time.split(':').map(Number);
  const guess = Date.UTC(y ?? 1970, (mo ?? 1) - 1, d ?? 1, h ?? 0, mi ?? 0);
  let offset = tzOffsetMs(guess, tz);
  offset = tzOffsetMs(guess - offset, tz); // second pass settles DST transitions
  return new Date(guess - offset).toISOString();
}

/** A UTC ISO instant → the wall-clock "YYYY-MM-DDTHH:mm" shown in IANA `tz`. */
function utcToZoned(iso: string, tz: string): string {
  if (!tz) return isoToLocalInput(iso); // fallback: browser-local
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(d);
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? '';
  const hh = get('hour') === '24' ? '00' : get('hour');
  return `${get('year')}-${get('month')}-${get('day')}T${hh}:${get('minute')}`;
}

interface AdForm {
  key: string;
  name: string;
  headline: string;
  primaryText: string;
  description: string;
  cta: CtaOption;
  displayLink: string;
  creativeType: CreativeType;
  uploadId?: string;
  uploadName?: string;
  previewUrl?: string;
  fallbackUrl: string;
  beneficiary: string;
}

interface AdSetForm {
  key: string;
  name: string;
  dailyBudget: string;
  countries: string[];
  excludeCountries: string[];
  ageMin: number;
  ageMax: number;
  genders: Gender[];
  languages: string[];
  devicePlatforms: DevicePlatform[];
  mobileOs: MobileOs[];
  advantageAudience: boolean;
  placementMode: PlacementMode;
  placements: string[];
  optimizationGoal: string;
  pixelId?: string;
  pxeEvent: PxeEvent;
  conversionType: ConversionType;
  bidStrategy: BidStrategy | '';
  costCap: string;
  roasFactor: string;
  attributionWindow: AttributionWindow | '';
  startTime: string;
  endTime: string;
  timezone: string;
  ads: AdForm[];
}

interface CampaignForm {
  name: string;
  objective: CampaignObjective;
  specialAdCategories: SpecialAdCategory[];
  nameTemplate: string;
  adsetNameTemplate: string;
  budgetMode: 'AD_SET' | 'CAMPAIGN';
  dailyBudget: string;
  keywords: string[];
  racValue: string;
  query: string;
  fallbackUrl: string;
  /** Which ad network runs it (D33). Facebook unless the buyer switches to Whop. */
  adProvider: AdProvider;
  adAccountId: string;
  pageId: string;
  /** Whop only: the connected business, and the Facebook page its ads run under (`sacc_…`). */
  whopConnectionId: string;
  whopPageId: string;
  adSets: AdSetForm[];
}

const uuid = (): string => globalThis.crypto.randomUUID();
const centsOrUndef = (dollars: string): number | undefined => {
  const c = Math.round((parseFloat(dollars) || 0) * 100);
  return c > 0 ? c : undefined;
};
const MONEY = (cents: number): string => `$${(cents / 100).toFixed(2)}`;
function toggle<T>(list: T[], v: T): T[] {
  return list.includes(v) ? list.filter((x) => x !== v) : [...list, v];
}

function emptyAd(): AdForm {
  return { key: uuid(), name: '', headline: '', primaryText: '', description: '', cta: 'LEARN_MORE', displayLink: '', creativeType: 'IMAGE', fallbackUrl: '', beneficiary: '' };
}

function emptyAdSet(n: number): AdSetForm {
  return {
    key: uuid(),
    name: `Ad set ${n}`,
    dailyBudget: '50',
    countries: [],
    excludeCountries: [],
    ageMin: 18,
    ageMax: AGE_BOUND_MAX,
    genders: [],
    languages: [],
    devicePlatforms: [],
    mobileOs: [],
    advantageAudience: false,
    placementMode: 'automatic',
    placements: [],
    optimizationGoal: 'OFFSITE_CONVERSIONS', // valid for the default OUTCOME_SALES objective
    pxeEvent: 'adclick',
    conversionType: 'instant',
    bidStrategy: '',
    costCap: '',
    roasFactor: '',
    attributionWindow: '',
    startTime: '',
    endTime: '',
    timezone: '',
    ads: [emptyAd()],
  };
}

function toForm(c?: Campaign): CampaignForm {
  if (!c) {
    return {
      name: '',
      objective: 'OUTCOME_SALES',
      specialAdCategories: [],
      nameTemplate: '',
      adsetNameTemplate: '',
      budgetMode: 'AD_SET',
      dailyBudget: '100',
      keywords: [],
      racValue: '',
      query: '',
      fallbackUrl: '',
      adProvider: 'FACEBOOK',
      adAccountId: '',
      pageId: '',
      whopConnectionId: '',
      whopPageId: '',
      adSets: [emptyAdSet(1)],
    };
  }
  return {
    name: c.name,
    objective: (c.objective as CampaignForm['objective']) ?? 'OUTCOME_SALES',
    specialAdCategories: (c.specialAdCategories as SpecialAdCategory[]) ?? [],
    nameTemplate: c.nameTemplate ?? '',
    adsetNameTemplate: c.adsetNameTemplate ?? '',
    budgetMode: c.budgetMode,
    dailyBudget: c.dailyBudgetCents ? (c.dailyBudgetCents / 100).toString() : '',
    keywords: c.keywords ?? [],
    racValue: c.racValue ?? '',
    query: c.query ?? '',
    fallbackUrl: c.fallbackUrl ?? '',
    adProvider: c.adProvider ?? 'FACEBOOK',
    adAccountId: c.adAccountId ?? '',
    pageId: c.pageId ?? '',
    whopConnectionId: c.whopConnectionId ?? '',
    whopPageId: c.whopPageId ?? '',
    adSets: c.adSets.map((s) => ({
      key: uuid(),
      name: s.name,
      dailyBudget: s.dailyBudgetCents ? (s.dailyBudgetCents / 100).toString() : '',
      countries: s.countries ?? [],
      excludeCountries: s.excludeCountries ?? [],
      ageMin: s.ageMin,
      ageMax: s.ageMax,
      genders: (s.genders as Gender[]) ?? [],
      languages: s.languages ?? [],
      devicePlatforms: (s.devicePlatforms as DevicePlatform[]) ?? [],
      mobileOs: (s.mobileOs as MobileOs[]) ?? [],
      advantageAudience: s.advantageAudience ?? false,
      placementMode: (s.placementMode as PlacementMode) ?? 'automatic',
      placements: s.placements ?? [],
      optimizationGoal: s.optimizationGoal ?? 'OFFSITE_CONVERSIONS',
      pixelId: s.pixelId ?? undefined,
      pxeEvent: (s.pxeEvent as PxeEvent) ?? 'adclick',
      conversionType: (s.conversionType as ConversionType) ?? 'instant',
      bidStrategy: (s.bidStrategy as BidStrategy) ?? '',
      costCap: s.costCapCents ? (s.costCapCents / 100).toString() : '',
      roasFactor: s.roasFactor ? String(s.roasFactor) : '',
      attributionWindow: (s.attributionWindow as AttributionWindow) ?? '',
      // Display the stored UTC instant in the ad account's timezone it was saved against (so editing
      // shows the same wall-clock the buyer scheduled). Legacy rows w/o a stored tz fall back to local.
      startTime: s.startTime ? utcToZoned(s.startTime, s.timezone ?? '') : '',
      endTime: s.endTime ? utcToZoned(s.endTime, s.timezone ?? '') : '',
      timezone: s.timezone ?? '',
      ads: s.ads.map((a) => ({
        key: uuid(),
        name: a.name,
        headline: a.headline,
        primaryText: a.primaryText,
        description: a.description ?? '',
        cta: a.cta as CtaOption,
        displayLink: a.displayLink ?? '',
        creativeType: a.creativeType,
        uploadId: a.uploadId ?? undefined,
        uploadName: a.uploadId ? 'Attached creative' : undefined,
        fallbackUrl: a.fallbackUrl ?? '',
        beneficiary: a.beneficiary ?? '',
      })),
    })),
  };
}

function toDraft(form: CampaignForm, tz: string): CampaignDraftInput {
  const cbo = form.budgetMode === 'CAMPAIGN';
  const whop = form.adProvider === 'WHOP';
  return {
    name: form.name.trim(),
    objective: form.objective,
    specialAdCategories: form.specialAdCategories,
    nameTemplate: form.nameTemplate.trim() || undefined,
    adsetNameTemplate: form.adsetNameTemplate.trim() || undefined,
    budgetMode: form.budgetMode,
    dailyBudgetCents: cbo ? centsOrUndef(form.dailyBudget) : undefined,
    keywords: form.keywords,
    racValue: form.racValue.trim() || undefined,
    query: form.query.trim() || undefined,
    fallbackUrl: form.fallbackUrl.trim() || undefined,
    adProvider: form.adProvider,
    // A Whop campaign has no Facebook ad account or page (and a Facebook one no Whop business): send only its own.
    adAccountId: whop ? undefined : form.adAccountId || undefined,
    pageId: whop ? undefined : form.pageId || undefined,
    whopConnectionId: whop ? form.whopConnectionId || undefined : undefined,
    whopPageId: whop ? form.whopPageId || undefined : undefined,
    adSets: form.adSets.map((s) => ({
      name: s.name.trim(),
      dailyBudgetCents: cbo ? undefined : centsOrUndef(s.dailyBudget),
      countries: s.countries,
      excludeCountries: s.excludeCountries,
      ageMin: s.ageMin,
      ageMax: s.ageMax,
      genders: s.genders,
      languages: s.languages,
      devicePlatforms: s.devicePlatforms,
      mobileOs: s.mobileOs,
      advantageAudience: s.advantageAudience,
      placementMode: s.placementMode,
      placements: s.placementMode === 'manual' ? s.placements : [],
      optimizationGoal: s.optimizationGoal,
      // Whop owns the pixel, and has no value-bid target or attribution-window setting.
      pixelId: whop ? undefined : s.pixelId || undefined,
      pxeEvent: s.pxeEvent,
      conversionType: s.conversionType,
      bidStrategy: s.bidStrategy || undefined,
      costCapCents: centsOrUndef(s.costCap),
      roasFactor: whop ? undefined : s.roasFactor ? Number(s.roasFactor) : undefined,
      attributionWindow: whop ? undefined : s.attributionWindow || undefined,
      // The picker wall-clock is in the ad account's timezone → convert to the correct UTC instant
      // (DST-aware) for storage + the FB ad-set start_time/end_time. Persist the tz so an edit round-trips.
      startTime: s.startTime ? zonedToUtcIso(s.startTime, tz) : undefined,
      endTime: s.endTime ? zonedToUtcIso(s.endTime, tz) : undefined,
      timezone: tz || s.timezone || undefined,
      ads: s.ads.map((a) => ({
        name: a.name.trim(),
        headline: a.headline.trim(),
        primaryText: a.primaryText.trim(),
        description: a.description.trim() || undefined,
        cta: a.cta,
        displayLink: a.displayLink.trim() || undefined,
        creativeType: a.creativeType,
        uploadId: a.uploadId,
        fallbackUrl: a.fallbackUrl.trim() || undefined,
        beneficiary: a.beneficiary.trim() || undefined,
      })),
    })),
  };
}

/**
 * The smallest daily budget a DRAFT may be saved with, in cents. Facebook's floor is $2.00. The draft schema (the one Save draft
 * runs through on the API) refuses anything under $1.00 for every network, so that is the floor for a Whop draft: a figure below
 * it would pass the wizard and then fail the save with a bare "Validation failed".
 */
const minBudgetCents = (form: CampaignForm): number => (form.adProvider === 'WHOP' ? 100 : 200);
const minBudgetText = (form: CampaignForm): string => (form.adProvider === 'WHOP' ? '$1.00' : '$2.00');
/**
 * The smallest daily budget a campaign may be SUBMITTED / LAUNCHED with. Facebook: the same $2.00. Whop: its own $5.00 floor
 * (it refuses to launch below it, which left five campaigns stuck on 2026-10-01), so the step check says so before the buyer submits.
 */
const launchMinBudgetCents = (form: CampaignForm): number => (form.adProvider === 'WHOP' ? WHOP_MIN_DAILY_BUDGET_CENTS : 200);
const launchMinBudgetText = (form: CampaignForm): string => `$${(launchMinBudgetCents(form) / 100).toFixed(2)}`;
const budgetHint = (form: CampaignForm): string =>
  form.adProvider === 'WHOP' ? `${launchMinBudgetText(form)} daily minimum (Whop refuses to launch below it).` : '$2.00 daily minimum (Facebook).';

/** A Whop campaign with a special ad category cannot narrow its audience's age (Whop refuses to launch it): 18 to 65 only. */
const whopAgeLocked = (form: CampaignForm): boolean => form.adProvider === 'WHOP' && form.specialAdCategories.some((c) => Boolean(WHOP_SPECIAL_CATEGORY[c]));
const WHOP_AGE_RULE_TEXT = `Whop does not let a special ad category campaign narrow the age range: set ${WHOP_SPECIAL_AGE_MIN} to ${WHOP_SPECIAL_AGE_MAX}.`;

/**
 * Mandatory-field errors for ONE wizard step. Surfaced inline (banner) when the buyer clicks Next,
 * so a skipped required field is caught ON that step in context — not only at the final Review step.
 */
function stepErrorsFor(step: number, form: CampaignForm, offers: OfferDraft[]): string[] {
  const e: string[] = [];
  const whop = form.adProvider === 'WHOP';
  if (step === 0) {
    if (!form.name.trim()) e.push('Campaign name is required.');
    if (form.budgetMode === 'CAMPAIGN') {
      const c = centsOrUndef(form.dailyBudget);
      if (c === undefined || c < launchMinBudgetCents(form)) e.push(`Campaign daily budget must be at least ${launchMinBudgetText(form)}.`);
    }
    if (whop) {
      if (!form.whopConnectionId) e.push('Select a Whop business.');
      if (!form.whopPageId) e.push('Select the Facebook page your Whop ads run under.');
    } else {
      if (!form.adAccountId) e.push('Select a Facebook ad account.');
      if (!form.pageId) e.push('Select a Facebook page.');
    }
    if (offers.filter((o) => o.kind === 'PAID' && o.domainId).length === 0) e.push('Add at least one destination website.');
  } else if (step === 1) {
    form.adSets.forEach((s, i) => {
      if (!s.name.trim()) e.push(`Ad set ${i + 1}: name is required.`);
      if (form.budgetMode === 'AD_SET') {
        const c = centsOrUndef(s.dailyBudget);
        if (c === undefined || c < launchMinBudgetCents(form)) e.push(`Ad set ${i + 1}: daily budget must be at least ${launchMinBudgetText(form)}.`);
      }
      if (s.ageMax < s.ageMin) e.push(`Ad set ${i + 1}: max age must be ≥ min age.`);
      if (whopAgeLocked(form) && (s.ageMin !== WHOP_SPECIAL_AGE_MIN || s.ageMax < WHOP_SPECIAL_AGE_MAX)) e.push(`Ad set ${i + 1}: ${WHOP_AGE_RULE_TEXT}`);
      if (s.countries.length === 0) e.push(`Ad set ${i + 1}: select at least one target country.`);
    });
  }
  return e;
}

/** Hard fields the API's draft schema requires on present entities (blocks Save draft). */
function hardErrors(form: CampaignForm): string[] {
  const errs: string[] = [];
  if (!form.name.trim()) errs.push('Campaign name is required.');
  const whop = form.adProvider === 'WHOP';
  const floorNote = whop ? '' : ' (Facebook minimum)';
  if (form.budgetMode === 'CAMPAIGN') {
    const c = centsOrUndef(form.dailyBudget);
    if (c !== undefined && c < minBudgetCents(form)) errs.push(`Campaign daily budget must be at least ${minBudgetText(form)}${floorNote}.`);
  }
  form.adSets.forEach((s, i) => {
    if (!s.name.trim()) errs.push(`Ad set ${i + 1}: name is required.`);
    if (form.budgetMode === 'AD_SET') {
      const c = centsOrUndef(s.dailyBudget);
      if (c !== undefined && c < minBudgetCents(form)) errs.push(`Ad set ${i + 1}: daily budget must be at least ${minBudgetText(form)}${floorNote}.`);
    }
    if (s.ageMax < s.ageMin) errs.push(`Ad set ${i + 1}: max age must be ≥ min age.`);
    // The API's draft schema requires an ad name; without this the buyer only got a bare "Validation failed".
    s.ads.forEach((a, j) => {
      if (!a.name.trim()) errs.push(`Ad ${i + 1}.${j + 1}: name is required.`);
    });
    // Headline + primary text are optional (FB doesn't require them) — no longer blocked here.
  });
  return errs;
}

/** A destination website row (the campaign's "offer"). */
interface OfferDraft {
  domainId: string;
  weightPct: number;
  kind: 'PAID' | 'ORGANIC';
}

/** Submit-blocking issues for the destination websites (mirrors the server gate). */
function offerIssues(offers: OfferDraft[]): string[] {
  const issues: string[] = [];
  const paid = offers.filter((o) => o.kind === 'PAID' && o.domainId);
  if (paid.length === 0) issues.push('Add at least one destination website (where the ads send traffic).');
  else if (!paid.some((o) => o.weightPct > 0)) issues.push('Give at least one destination website a traffic weight above 0%.');
  if (offers.filter((o) => o.kind === 'ORGANIC').length > 1) issues.push('Only one organic (non-ad) destination is allowed.');
  return issues;
}

/**
 * Everything in a Whop campaign that Whop cannot express (an app-promotion objective, a placement it has no name
 * for, a ROAS-goal bid strategy, ...), from the same shared table the server's submit gate uses, so the buyer is
 * told while building instead of after submitting.
 */
function whopProblems(form: CampaignForm): string[] {
  return whopLaunchProblems(
    { name: form.name, objective: form.objective, specialAdCategories: form.specialAdCategories, budgetMode: form.budgetMode, dailyBudgetCents: centsOrUndef(form.dailyBudget) ?? null },
    form.adSets.map((s) => ({
      name: s.name,
      dailyBudgetCents: centsOrUndef(s.dailyBudget) ?? null,
      countries: s.countries,
      excludeCountries: s.excludeCountries,
      ageMin: s.ageMin,
      ageMax: s.ageMax,
      genders: s.genders,
      advantageAudience: s.advantageAudience,
      placementMode: s.placementMode,
      placements: s.placements,
      languages: s.languages,
      devicePlatforms: s.devicePlatforms,
      mobileOs: s.mobileOs,
      bidStrategy: s.bidStrategy || null,
      costCapCents: centsOrUndef(s.costCap) ?? null,
      startTime: null,
      endTime: null,
      pxeEvent: s.pxeEvent,
    })),
  );
}

/** What Whop has no word for among the choices a form carries (objective, categories, placements, bid strategy): the shared table. */
function whopUnsupported(form: CampaignForm): string[] {
  return whopUnsupportedProblems(
    { objective: form.objective, specialAdCategories: form.specialAdCategories },
    form.adSets.map((s) => ({ name: s.name, placementMode: s.placementMode, placements: s.placements, bidStrategy: s.bidStrategy || null })),
  );
}

/**
 * The form after the buyer switches network. What belongs to the OTHER network is cleared: its account, page and pixel, the
 * schedule (wall-clock time in the network's own zone would silently mean another moment), display links, and a call to action
 * Whop has no name for (which becomes Learn more, as the launch does anyway). Choices that merely might not exist on the new
 * network are KEPT: a special ad category is a compliance declaration and a placement or bid strategy shapes delivery, so
 * dropping them silently would send the campaign out different from what was built. They stay visible and removable, and the
 * shared table (`whopUnsupportedProblems`) reports them until the buyer removes them or switches back.
 */
function switchProvider(f: CampaignForm, adProvider: AdProvider): CampaignForm {
  if (f.adProvider === adProvider) return f;
  const whop = adProvider === 'WHOP';
  return {
    ...f,
    adProvider,
    adAccountId: '',
    pageId: '',
    whopConnectionId: '',
    whopPageId: '',
    adSets: f.adSets.map((set) => ({
      ...set,
      pixelId: undefined,
      startTime: '',
      endTime: '',
      ...(whop ? { timezone: '' } : {}),
      ads: set.ads.map((a) => (whop ? { ...a, displayLink: '', cta: WHOP_CTAS.includes(a.cta.toLowerCase()) ? a.cta : ('LEARN_MORE' as const) } : a)),
    })),
  };
}

/** What a switch did, in words: what was cleared, and what the new network cannot run (kept so it can be seen). Null when neither. */
function switchNote(before: CampaignForm, after: CampaignForm): string | null {
  if (before.adProvider === after.adProvider) return null;
  const whop = after.adProvider === 'WHOP';
  const cleared: string[] = [];
  if (whop) {
    if (before.adAccountId || before.pageId) cleared.push('the Facebook ad account and page');
    if (before.adSets.some((s) => s.pixelId)) cleared.push('the pixel');
    if (before.adSets.some((s) => s.ads.some((a) => a.displayLink.trim()))) cleared.push('display links');
    if (before.adSets.some((s, i) => s.ads.some((a, j) => after.adSets[i]?.ads[j]?.cta !== a.cta))) cleared.push('a call to action Whop has no name for (now Learn more)');
  } else if (before.whopConnectionId || before.whopPageId) {
    cleared.push('the Whop business and page');
  }
  if (before.adSets.some((s) => s.startTime || s.endTime)) cleared.push('the start and end times');
  const unsupported = whop ? whopUnsupported(after) : [];
  if (cleared.length === 0 && unsupported.length === 0) return null;
  const parts = [`Switched to ${whop ? 'Whop' : 'Facebook'}.`];
  if (cleared.length) parts.push(`Cleared: ${cleared.join(', ')}.`);
  if (unsupported.length) parts.push(`Whop cannot run part of what you set, so it is kept where you can see it: ${unsupported.join(' ')} Remove it, or switch back to Facebook.`);
  return parts.join(' ');
}

/** Full completeness for submit — computed directly from the form (always specific). */
function formIssues(form: CampaignForm): string[] {
  const issues = [...hardErrors(form)];
  const whop = form.adProvider === 'WHOP';
  if (whop) {
    if (!form.whopConnectionId) issues.push('Select a Whop business.');
    if (!form.whopPageId) issues.push('Select the Facebook page your Whop ads run under.');
    issues.push(...whopProblems(form));
  } else {
    if (!form.adAccountId) issues.push('Select a Facebook ad account.');
    if (!form.pageId) issues.push('Select a Facebook page.');
  }
  if (form.keywords.length === 0) issues.push('Add at least one keyword.');
  if (!form.racValue.trim()) issues.push('Set the Referrer Ad Creative.');
  else issues.push(...racValueIssues(form.racValue, form.name));
  // For a Whop campaign the budget, country and placement rules are said once, by `whopProblems` above (the shared table the
  // server's gate uses), so they are not repeated here in other words.
  if (!whop && form.budgetMode === 'CAMPAIGN' && !centsOrUndef(form.dailyBudget)) issues.push('Set the campaign daily budget.');
  if (form.adSets.length === 0) issues.push('Add at least one ad set.');
  form.adSets.forEach((s, i) => {
    const L = `Ad set ${i + 1}`;
    if (!whop && form.budgetMode === 'AD_SET' && !centsOrUndef(s.dailyBudget)) issues.push(`${L} needs a daily budget.`);
    if (!whop && s.countries.length === 0) issues.push(`${L} needs at least one target country.`);
    // Facebook's performance-goal and pixel rules do not apply to Whop: it owns the pixel and optimizes the money event.
    if (!whop && !isValidPerformanceGoal(form.objective, s.optimizationGoal)) {
      issues.push(`${L}: performance goal isn't valid for the ${form.objective.replace('OUTCOME_', '').toLowerCase()} objective.`);
    }
    if (!whop && goalRequiresPixel(s.optimizationGoal) && !s.pixelId) issues.push(`${L} optimizes for conversions → needs a pixel.`);
    if (!whop && s.placementMode === 'manual' && s.placements.length === 0) issues.push(`${L} needs at least one placement.`);
    if (s.ads.length === 0) issues.push(`${L} needs at least one ad.`);
    s.ads.forEach((a, j) => {
      if (!a.uploadId) issues.push(`Ad ${i + 1}.${j + 1} needs a creative.`);
      // Facebook leaves the copy optional; a Whop ad cannot be created without a headline and primary text.
      if (whop && !a.headline.trim()) issues.push(`Ad ${i + 1}.${j + 1} needs a headline.`);
      if (whop && !a.primaryText.trim()) issues.push(`Ad ${i + 1}.${j + 1} needs primary text.`);
    });
  });
  return [...new Set(issues)];
}

const STEPS = ['Offer', 'Ad sets', 'Review'];

/** `embedded`: shown inside another page that already has the campaign's own header (the read-only view then drops its title). */
export function CampaignWizard({ campaign, embedded = false }: { campaign?: Campaign; embedded?: boolean }) {
  const router = useRouter();
  const readOnly = Boolean(campaign && campaign.status !== 'DRAFT');

  const [form, setForm] = useState<CampaignForm>(() => toForm(campaign));
  // Cloaker buyers never set fallback/display — the launch auto-fills both from the rotated white pool.
  // Hide those fields for them (read the stored mode, then refresh from /me so it's current).
  const [isCloaker, setIsCloaker] = useState<boolean>(() => getStoredUser()?.funnelMode === 'CLOAKER');
  useEffect(() => {
    void auth.me().then((u) => setIsCloaker(u.funnelMode === 'CLOAKER')).catch(() => undefined);
  }, []);
  const [step, setStep] = useState(0);
  const [savedId, setSavedId] = useState<string | null>(campaign?.id ?? null);
  // D28: rc words that make Google hide the keyword block — flagged inline + block submit (the API
  // enforces the same list on submit).
  const [rcBlockedTerms, setRcBlockedTerms] = useState<string[]>([]);
  useEffect(() => {
    void campaignsApi.rcBlockedTerms().then(setRcBlockedTerms).catch(() => setRcBlockedTerms([]));
  }, []);

  const [accounts, setAccounts] = useState<FbAccount[]>([]);
  const [pages, setPages] = useState<FbPage[]>([]);
  const [pixels, setPixels] = useState<FbPixel[]>([]);
  const [fbAssetsLoading, setFbAssetsLoading] = useState(true);
  // Whop Ads (D33): offered only when it is on for the buyer's company; otherwise the wizard is exactly as it was.
  const [whopOn, setWhopOn] = useState(false);
  const [connections, setConnections] = useState<WhopConnection[]>([]);
  // Whether the Whop status and businesses have answered (or failed), so a list that has not arrived yet is never shown as
  // "no business connected", and a failed load is said out loud instead of leaving empty pickers.
  const [whopLoaded, setWhopLoaded] = useState(false);
  const [whopLoadFailed, setWhopLoadFailed] = useState(false);
  // What the last network switch cleared, and what the new network cannot run (kept in view, not dropped).
  const [switchMessage, setSwitchMessage] = useState<string | null>(null);
  // Only the campaign's own buyer sees its business in the lists below (they are the signed-in user's own): for anyone else
  // (a company admin opening the draft), "not in the list" says nothing about the campaign.
  const isOwner = !campaign || campaign.buyerId === getStoredUser()?.id;

  // Destination websites (the campaign's "offers") — where the ads send traffic.
  const [offerDomains, setOfferDomains] = useState<OfferDomainOption[]>([]);
  const [offers, setOffers] = useState<OfferDraft[]>([{ domainId: '', weightPct: 100, kind: 'PAID' }]);

  const [saving, setSaving] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [launching, setLaunching] = useState(false);
  const [uploadingKey, setUploadingKey] = useState<string | null>(null);
  const [bannerError, setBannerError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [serverIssues, setServerIssues] = useState<string[]>([]);

  useEffect(() => {
    let active = true;
    void facebook
      .accounts()
      .then((acc) => active && setAccounts(acc))
      .catch(() => undefined)
      .finally(() => active && setFbAssetsLoading(false));
    return () => {
      active = false;
    };
  }, []);
  // A Whop draft waits for its businesses; a Facebook campaign (the default) never waits on Whop.
  const assetsLoading = fbAssetsLoading || (form.adProvider === 'WHOP' && !whopLoaded);

  useEffect(() => {
    let active = true;
    void whopApi
      .status()
      .then(async (st) => {
        if (!active) return;
        // A super admin is offered Whop by the status call (no company switch on the platform org), but a campaign needs the
        // company's switch on, so the network choice would only end in a refusal at Save: it is not offered to them.
        const on = st.enabled && getStoredUser()?.role !== 'SUPER_ADMIN';
        setWhopOn(on);
        if (on) setConnections(await whopApi.connections());
      })
      .catch(() => active && setWhopLoadFailed(true))
      .finally(() => active && setWhopLoaded(true));
    return () => {
      active = false;
    };
  }, []);

  // A business disconnected since this draft was saved, or a page it no longer has, must not stay "selected" behind a picker
  // that cannot show it (the review would name a business that is gone). Only a loaded, editable Whop form is touched.
  useEffect(() => {
    if (!whopLoaded || !whopOn || whopLoadFailed || readOnly || !isOwner) return;
    setForm((f) => {
      if (f.adProvider !== 'WHOP') return f;
      const conn = connections.find((c) => c.id === f.whopConnectionId);
      if (f.whopConnectionId && !conn) return { ...f, whopConnectionId: '', whopPageId: '' };
      if (f.whopPageId && conn && !conn.pages.some((p) => p.id === f.whopPageId && p.platform === 'facebook')) return { ...f, whopPageId: '' };
      return f;
    });
  }, [whopLoaded, whopOn, whopLoadFailed, readOnly, isOwner, connections]);

  // Destination websites the buyer can route to, + any offers already on the campaign.
  useEffect(() => {
    void campaignsApi.offerDomains().then(setOfferDomains).catch(() => setOfferDomains([]));
    if (campaign?.id) {
      void campaignsApi
        .offers(campaign.id)
        .then((rows) => {
          if (rows.length > 0) setOffers(rows.map((o) => ({ domainId: o.domainId, weightPct: o.weightPct, kind: o.kind })));
        })
        .catch(() => undefined);
    }
  }, [campaign?.id]);

  useEffect(() => {
    if (!form.adAccountId) {
      setPixels([]);
      setPages([]);
      return;
    }
    let active = true;
    void facebook.pixels(form.adAccountId).then((px) => active && setPixels(px)).catch(() => active && setPixels([]));
    void facebook.accountPages(form.adAccountId).then((pg) => active && setPages(pg)).catch(() => active && setPages([]));
    return () => {
      active = false;
    };
  }, [form.adAccountId]);

  const patch = useCallback((p: Partial<CampaignForm>) => setForm((f) => ({ ...f, ...p })), []);
  // Switching network clears what belongs to the other one and KEEPS (visibly, flagged) what the new one cannot run: see `switchProvider`.
  const changeProvider = useCallback(
    (adProvider: AdProvider) => {
      // What a failed submit said about the OTHER network no longer applies.
      setServerIssues([]);
      setSwitchMessage(switchNote(form, switchProvider(form, adProvider)));
      setForm((f) => switchProvider(f, adProvider));
    },
    [form],
  );
  // Changing the objective re-snaps each ad set's performance goal to one valid for it.
  const changeObjective = useCallback((objective: CampaignForm['objective']) => {
    setForm((f) => ({
      ...f,
      objective,
      // This tool optimizes for Conversions only — the goal is always OFFSITE_CONVERSIONS.
      adSets: f.adSets.map((s) => ({ ...s, optimizationGoal: 'OFFSITE_CONVERSIONS' })),
    }));
  }, []);
  const patchAdSet = useCallback(
    (key: string, p: Partial<AdSetForm>) => setForm((f) => ({ ...f, adSets: f.adSets.map((s) => (s.key === key ? { ...s, ...p } : s)) })),
    [],
  );
  const patchAd = useCallback(
    (setKey: string, adKey: string, p: Partial<AdForm>) =>
      setForm((f) => ({
        ...f,
        adSets: f.adSets.map((s) => (s.key === setKey ? { ...s, ads: s.ads.map((a) => (a.key === adKey ? { ...a, ...p } : a)) } : s)),
      })),
    [],
  );

  const issues = useMemo(() => {
    const rcHits = findBlockedRcTerms(form.racValue, rcBlockedTerms);
    // A connection whose key Whop rejected cannot launch anything: say so now rather than after a submit.
    const conn = form.adProvider === 'WHOP' ? connections.find((c) => c.id === form.whopConnectionId) : undefined;
    const why = conn?.lastError?.trim();
    const brokenConnection =
      conn?.status === 'BROKEN'
        ? [`The Whop connection "${conn.label ?? conn.bizId}" needs attention: ${why ? `${why}${/[.!?]$/.test(why) ? '' : '.'}` : 'its key was rejected.'} Open the Whop tab to fix it.`]
        : [];
    // The company's Whop switch was turned off after this draft was made: it cannot be saved or launched on Whop.
    const whopOff = form.adProvider === 'WHOP' && whopLoaded && !whopLoadFailed && !whopOn && isOwner ? ['Whop Ads is switched off for your company: switch this campaign back to Facebook, or ask your admin to turn Whop Ads on.'] : [];
    return [...formIssues(form), ...brokenConnection, ...whopOff, ...offerIssues(offers), ...(rcHits.length ? [rcBlockedMessage(rcHits)] : [])];
  }, [form, connections, offers, rcBlockedTerms, whopLoaded, whopLoadFailed, whopOn, isOwner]);

  async function uploadCreative(setKey: string, ad: AdForm, file: File) {
    setUploadingKey(ad.key);
    setBannerError(null);
    try {
      const result = await uploadsApi.create(file);
      patchAd(setKey, ad.key, {
        uploadId: result.id,
        uploadName: result.filename,
        creativeType: result.kind,
        previewUrl: result.kind === 'IMAGE' ? URL.createObjectURL(file) : undefined,
      });
    } catch (err) {
      setBannerError(err instanceof ApiError ? err.message : 'Upload failed.');
    } finally {
      setUploadingKey(null);
    }
  }

  async function saveDraft(): Promise<Campaign | null> {
    const errs = hardErrors(form);
    if (errs.length) {
      setBannerError(errs[0] ?? 'Fix the highlighted fields.');
      return null;
    }
    setSaving(true);
    setBannerError(null);
    setSuccess(null);
    try {
      // Facebook schedules in the ad account's time zone; Whop has no such setting, so the browser's own zone applies.
      const acctTz = form.adProvider === 'WHOP' ? '' : accounts.find((a) => a.id === form.adAccountId)?.timezone ?? '';
      const draft = toDraft(form, acctTz);
      const saved = savedId ? await campaignsApi.update(savedId, draft) : await campaignsApi.create(draft);
      if (!savedId) {
        setSavedId(saved.id);
        window.history.replaceState({}, '', `/dashboard/campaigns/${saved.id}`);
      }
      // Persist the destination websites (offers) alongside the campaign so submit's
      // "≥1 paid offer" gate is satisfied from the wizard itself.
      const validOffers = offers
        .filter((o) => o.domainId)
        .map((o) => ({ domainId: o.domainId, weightPct: o.kind === 'PAID' ? o.weightPct : 0, kind: o.kind }));
      if (validOffers.length > 0) await campaignsApi.setOffers(saved.id, validOffers);
      return saved;
    } catch (err) {
      setBannerError(err instanceof ApiError ? err.message : 'Could not save the draft.');
      return null;
    } finally {
      setSaving(false);
    }
  }

  async function onSaveDraft() {
    const saved = await saveDraft();
    if (saved) setSuccess('Draft saved.');
  }

  async function onSubmit() {
    const saved = await saveDraft();
    if (!saved) return;
    setSubmitting(true);
    setServerIssues([]);
    try {
      await campaignsApi.submit(saved.id);
      router.push('/dashboard/campaigns');
    } catch (err) {
      if (err instanceof ApiError && err.status === 422 && Array.isArray(err.details)) setServerIssues(err.details as string[]);
      else setBannerError(err instanceof ApiError ? err.message : 'Could not submit.');
    } finally {
      setSubmitting(false);
    }
  }

  async function onTestLaunch() {
    const saved = await saveDraft();
    if (!saved) return;
    setLaunching(true);
    setBannerError(null);
    setServerIssues([]);
    try {
      const res = await campaignsApi.testLaunch(saved.id);
      const ads = res.adSets.reduce((n, s) => n + s.ads.length, 0);
      setSuccess(`Launched to Facebook (PAUSED): campaign ${res.fbCampaignId} · ${res.adSets.length} ad set(s) · ${ads} ad(s).`);
    } catch (err) {
      if (err instanceof ApiError && err.status === 422 && Array.isArray(err.details)) setServerIssues(err.details as string[]);
      else setBannerError(err instanceof ApiError ? err.message : 'Test-launch failed.');
    } finally {
      setLaunching(false);
    }
  }

  return (
    <div className={styles.wrap}>
      {!(readOnly && embedded) && <div className={styles.head}>
        <div>
          <h1 className={`serif ${styles.title}`}>{readOnly ? campaign?.name : campaign ? 'Edit campaign' : 'New campaign'}</h1>
          <p className={styles.subtitle}>
            {readOnly ? 'This campaign has been submitted and is read-only.' : 'Campaign → ad sets (audience, placements, budget, pixel) → ads.'}
          </p>
        </div>
        <Link href="/dashboard/campaigns" className={styles.chipBtn} style={{ alignSelf: 'center' }}>
          Back to campaigns
        </Link>
      </div>}

      {!readOnly && (
        <nav className={styles.steps} aria-label="Campaign steps">
          {STEPS.map((label, i) => (
            <button
              key={label}
              type="button"
              className={`${styles.step} ${i === step ? styles.stepActive : i < step ? styles.stepDone : ''}`}
              aria-current={i === step ? 'step' : undefined}
              onClick={() => setStep(i)}
              onKeyDown={(e: KeyboardEvent<HTMLButtonElement>) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  setStep(i);
                }
              }}
            >
              <span className={styles.stepNum}>{i + 1}</span>
              {label}
            </button>
          ))}
        </nav>
      )}

      {bannerError && (
        <Banner tone="error" role="alert" onDismiss={() => setBannerError(null)}>
          {bannerError}
        </Banner>
      )}
      {success && (
        <Banner tone="success" role="status" onDismiss={() => setSuccess(null)}>
          {success}
        </Banner>
      )}
      {whopLoadFailed && form.adProvider === 'WHOP' && !readOnly && (
        <Banner tone="error" role="alert">
          Could not load your Whop businesses, so the business and page lists are empty. Reload the page to try again.
        </Banner>
      )}
      {switchMessage && !readOnly && (
        <Banner tone="info" role="status" onDismiss={() => setSwitchMessage(null)}>
          {switchMessage}
        </Banner>
      )}

      <Card className={styles.card}>
        {readOnly ? (
          <ReviewStep form={form} accounts={accounts} pages={pages} connections={connections} whopOn={whopOn} offers={offers} issues={[]} campaign={campaign} />
        ) : assetsLoading ? (
          <div className={styles.center}>
            <Spinner />
          </div>
        ) : step === 0 ? (
          <OfferStep
            form={form}
            patch={patch}
            onObjectiveChange={changeObjective}
            onProviderChange={changeProvider}
            whopOn={whopOn}
            whopLoadFailed={whopLoadFailed}
            isOwner={isOwner}
            connections={connections}
            accounts={accounts}
            pages={pages}
            offers={offers}
            setOffers={setOffers}
            offerDomains={offerDomains}
            readOnly={readOnly}
            isCloaker={isCloaker}
            rcBlockedTerms={rcBlockedTerms}
          />
        ) : step === 1 ? (
          <AdSetsStep form={form} pixels={pixels} patchAdSet={patchAdSet} patchAd={patchAd} setForm={setForm} uploadingKey={uploadingKey} uploadCreative={uploadCreative} isCloaker={isCloaker} adAccountTz={form.adProvider === 'WHOP' ? '' : accounts.find((a) => a.id === form.adAccountId)?.timezone ?? ''} />
        ) : (
          <ReviewStep form={form} accounts={accounts} pages={pages} connections={connections} whopOn={whopOn} offers={offers} issues={[...serverIssues, ...issues]} campaign={campaign} />
        )}
      </Card>

      {!readOnly && (
        <div className={styles.footer}>
          <Button variant="ghost" onClick={() => setStep((s) => Math.max(0, s - 1))} disabled={step === 0}>
            Back
          </Button>
          <div className={styles.footerRight}>
            {step < STEPS.length - 1 ? (
              <>
                <Button variant="ghost" onClick={() => void onSaveDraft()} loading={saving}>
                  Save draft
                </Button>
                <Button
                  onClick={() => {
                    const stepErrs = stepErrorsFor(step, form, offers);
                    if (stepErrs.length > 0) {
                      setBannerError(stepErrs.join(' '));
                      return; // block advancing — show the missing fields on THIS step
                    }
                    setBannerError(null);
                    setStep((s) => Math.min(STEPS.length - 1, s + 1));
                  }}
                >
                  Next
                </Button>
              </>
            ) : (
              <>
                {/* Secondary actions are grouped + divider-separated so the lone */}
                {/* primary (Submit) can't be confused with Test-launch. */}
                <div className={styles.secondaryActions}>
                  <Button variant="ghost" onClick={() => void onSaveDraft()} loading={saving}>
                    Save draft
                  </Button>
                  {/* Facebook only: Whop checks a campaign itself when its ads are created, and launches it from the campaign page. */}
                  {form.adProvider === 'FACEBOOK' && (
                    <Button variant="ghost" onClick={() => void onTestLaunch()} loading={launching} disabled={issues.length > 0}>
                      Test-launch (PAUSED)
                    </Button>
                  )}
                </div>
                <Button onClick={() => void onSubmit()} loading={submitting} disabled={issues.length > 0}>
                  Submit for approval
                </Button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ---- Reusable pickers ------------------------------------------------------

function CountryPicker({ selected, onChange, placeholder, ariaLabel, worldwide }: { selected: string[]; onChange: (codes: string[]) => void; placeholder?: string; ariaLabel?: string; worldwide?: boolean }) {
  const [search, setSearch] = useState('');
  const label = ariaLabel ?? placeholder ?? 'Search countries';
  const filtered = COUNTRIES.filter((c) => c.name.toLowerCase().includes(search.toLowerCase()) || c.code.toLowerCase() === search.toLowerCase());
  const allSelected = selected.length === ALL_COUNTRY_CODES.length;
  return (
    <div role="group" aria-label={label}>
      {worldwide && (
        <div className={styles.chips} style={{ marginBottom: '0.5rem' }}>
          <button
            type="button"
            className={`${styles.toggleBtn} ${allSelected ? styles.toggleOn : ''}`}
            aria-pressed={allSelected}
            onClick={() => onChange(allSelected ? [] : ALL_COUNTRY_CODES)}
          >
            {allSelected && <span aria-hidden="true">✓ </span>}🌍 Worldwide (all countries)
          </button>
          {selected.length > 0 && (
            <button type="button" className={styles.toggleBtn} onClick={() => onChange([])}>
              Clear
            </button>
          )}
        </div>
      )}
      {selected.length > 0 && (
        <div className={styles.chips} style={{ marginBottom: '0.5rem' }}>
          {selected.map((code) => (
            <span key={code} className={styles.chip}>
              {countryName(code)}
              <button type="button" className={styles.chipX} aria-label={`Remove ${countryName(code)}`} onClick={() => onChange(toggle(selected, code))}>
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <input className={styles.input} aria-label={label} placeholder={placeholder ?? 'Search countries…'} value={search} onChange={(e) => setSearch(e.target.value)} />
      <div className={styles.countryList}>
        {filtered.map((c) => (
          <label key={c.code} className={styles.countryItem}>
            <input type="checkbox" checked={selected.includes(c.code)} onChange={() => onChange(toggle(selected, c.code))} />
            {c.name}
          </label>
        ))}
        {filtered.length === 0 && <span className={styles.hint}>No match.</span>}
      </div>
    </div>
  );
}

function ChipGroup<T extends string>({
  options,
  selected,
  onToggle,
  allLabel,
  onClear,
  ariaLabel,
}: {
  options: readonly { value: T; label: string }[];
  selected: T[];
  onToggle: (v: T) => void;
  allLabel?: string;
  onClear?: () => void;
  ariaLabel?: string;
}) {
  return (
    <div className={styles.toggle} role="group" aria-label={ariaLabel}>
      {allLabel && (
        <button
          type="button"
          className={`${styles.toggleBtn} ${styles.toggleAllBtn} ${selected.length === 0 ? styles.toggleOn : ''}`}
          aria-pressed={selected.length === 0}
          onClick={() => onClear?.()}
        >
          {selected.length === 0 && (
            <span className={styles.toggleCheck} aria-hidden="true">
              ✓{' '}
            </span>
          )}
          {allLabel}
        </button>
      )}
      {options.map((o) => {
        const on = selected.includes(o.value);
        return (
          <button
            key={o.value}
            type="button"
            className={`${styles.toggleBtn} ${on ? styles.toggleOn : ''}`}
            aria-pressed={on}
            onClick={() => onToggle(o.value)}
          >
            {on && (
              <span className={styles.toggleCheck} aria-hidden="true">
                ✓{' '}
              </span>
            )}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** Required-field marker (visual only; the asterisk is hidden from screen readers). */
function Req() {
  return (
    <span aria-hidden="true" style={{ color: 'var(--red-text)', marginLeft: '0.15rem' }}>
      *
    </span>
  );
}

// ---- Steps -----------------------------------------------------------------

function OfferStep({
  form,
  patch,
  onObjectiveChange,
  onProviderChange,
  whopOn,
  whopLoadFailed,
  isOwner,
  connections,
  accounts,
  pages,
  offers,
  setOffers,
  offerDomains,
  readOnly,
  isCloaker,
  rcBlockedTerms,
}: {
  form: CampaignForm;
  patch: (p: Partial<CampaignForm>) => void;
  onObjectiveChange: (objective: CampaignForm['objective']) => void;
  onProviderChange: (provider: AdProvider) => void;
  /** Whop Ads is on for this buyer's company (D33). */
  whopOn: boolean;
  /** The Whop businesses could not be loaded: an empty list then means "unknown", never "none connected". */
  whopLoadFailed: boolean;
  /** The viewer is the campaign's own buyer (or it is new): only then do the viewer's company switch and business list apply to it. */
  isOwner: boolean;
  connections: WhopConnection[];
  accounts: FbAccount[];
  pages: FbPage[];
  offers: OfferDraft[];
  setOffers: (updater: (o: OfferDraft[]) => OfferDraft[]) => void;
  offerDomains: OfferDomainOption[];
  readOnly: boolean;
  isCloaker: boolean;
  /** D28: rc words that make Google hide the keyword block. */
  rcBlockedTerms: readonly string[];
}) {
  const rcHits = findBlockedRcTerms(form.racValue, rcBlockedTerms);
  const [keywordDraft, setKeywordDraft] = useState('');
  const [keywordNote, setKeywordNote] = useState('');
  const uid = useId();
  const fid = (name: string): string => `${uid}-${name}`;
  const setOfferRow = (i: number, p: Partial<OfferDraft>): void => setOffers((rows) => rows.map((r, idx) => (idx === i ? { ...r, ...p } : r)));
  const addOfferRow = (): void => setOffers((rows) => [...rows, { domainId: '', weightPct: 0, kind: 'PAID' }]);
  const removeOfferRow = (i: number): void => setOffers((rows) => (rows.length > 1 ? rows.filter((_, idx) => idx !== i) : rows));
  const paidWeight = offers.filter((o) => o.kind === 'PAID').reduce((s, o) => s + (o.weightPct || 0), 0);
  // Accepts a pasted/typed list: splits on commas + newlines, trims, dedupes,
  // and notes any entries that were already added.
  function addKeyword() {
    const parts = keywordDraft.split(/[\n,]+/).map((p) => p.trim()).filter(Boolean);
    if (parts.length === 0) {
      setKeywordDraft('');
      setKeywordNote('');
      return;
    }
    const existing = new Set(form.keywords);
    const added: string[] = [];
    const dupes: string[] = [];
    for (const p of parts) {
      if (existing.has(p) || added.includes(p)) {
        if (!dupes.includes(p)) dupes.push(p);
      } else {
        added.push(p);
      }
    }
    if (added.length > 0) patch({ keywords: [...form.keywords, ...added] });
    setKeywordDraft('');
    setKeywordNote(dupes.length > 0 ? `Already added: ${dupes.join(', ')}.` : '');
  }

  const whop = form.adProvider === 'WHOP';
  const connection = connections.find((c) => c.id === form.whopConnectionId);
  // Only a FACEBOOK page can host the ads: the server refuses an Instagram account as "not a Facebook page of that business".
  const whopPages = (connection?.pages ?? []).filter((p) => p.platform === 'facebook');
  return (
    <div>
      {!whop && accounts.length === 0 && (
        <div className={styles.issues} role="status">
          <div className={styles.issuesTitle}>No Facebook ad accounts found</div>
          <div style={{ fontSize: '0.83rem' }}>
            <Link href="/dashboard/facebook">Connect Facebook</Link> first to pick an ad account, page, and pixel.
          </div>
        </div>
      )}
      {whop && !whopLoadFailed && !whopOn && isOwner && (
        <div className={styles.issues} role="alert">
          <div className={styles.issuesTitle}>Whop Ads is switched off for your company</div>
          <div style={{ fontSize: '0.83rem' }}>This campaign is set to Whop, so it can&apos;t be saved or launched. Switch it back to Facebook, or ask your admin to turn Whop Ads on.</div>
        </div>
      )}
      {whop && !whopLoadFailed && whopOn && connections.length === 0 && (
        <div className={styles.issues} role="status">
          <div className={styles.issuesTitle}>No Whop business connected</div>
          <div style={{ fontSize: '0.83rem' }}>
            <Link href="/dashboard/whop">Connect a Whop business</Link> first: you add its ID and an API key, and Whop runs the ads.
          </div>
        </div>
      )}
      <div className={styles.grid}>
        <div className={`${styles.field} ${styles.full}`}>
          <label className={styles.label} htmlFor={fid('name')}>Campaign name<Req /></label>
          <input id={fid('name')} className={styles.input} value={form.name} onChange={(e) => patch({ name: e.target.value })} placeholder="e.g. Medicare Advantage — Q2" />
        </div>
        {(whopOn || whop) && (
          <div className={`${styles.field} ${styles.full}`}>
            <span className={styles.label}>Ad network</span>
            <div className={styles.toggle} role="group" aria-label="Ad network">
              <button type="button" className={`${styles.toggleBtn} ${!whop ? styles.toggleOn : ''}`} aria-pressed={!whop} disabled={readOnly} onClick={() => onProviderChange('FACEBOOK')}>
                {!whop && <span className={styles.toggleCheck} aria-hidden="true">✓ </span>}
                Facebook
              </button>
              <button type="button" className={`${styles.toggleBtn} ${whop ? styles.toggleOn : ''}`} aria-pressed={whop} disabled={readOnly} onClick={() => onProviderChange('WHOP')}>
                {whop && <span className={styles.toggleCheck} aria-hidden="true">✓ </span>}
                Whop
              </button>
            </div>
            <span className={styles.hint}>
              {whop
                ? 'Whop runs the Meta ads for you from its own ad account; you pay Whop. Switching network clears the account, page, pixel and schedule; anything Whop cannot run is kept and flagged so you can decide.'
                : 'Your own Facebook ad account. Switching network clears the account, page, pixel and schedule.'}
            </span>
          </div>
        )}
        <div className={styles.field}>
          <label className={styles.label} htmlFor={fid('objective')}>Objective</label>
          <select id={fid('objective')} className={styles.select} value={form.objective} onChange={(e) => onObjectiveChange(e.target.value as CampaignForm['objective'])}>
            {SELECTABLE_OBJECTIVES.map((o) => (
              <option key={o} value={o}>
                {o.replace('OUTCOME_', '')}
              </option>
            ))}
          </select>
        </div>
        <div className={styles.field}>
          <span className={styles.label}>Budget optimization</span>
          <div className={styles.toggle} role="group" aria-label="Budget optimization">
            <button type="button" className={`${styles.toggleBtn} ${form.budgetMode === 'AD_SET' ? styles.toggleOn : ''}`} aria-pressed={form.budgetMode === 'AD_SET'} onClick={() => patch({ budgetMode: 'AD_SET' })}>
              {form.budgetMode === 'AD_SET' && <span className={styles.toggleCheck} aria-hidden="true">✓ </span>}
              Per ad set (ABO)
            </button>
            <button type="button" className={`${styles.toggleBtn} ${form.budgetMode === 'CAMPAIGN' ? styles.toggleOn : ''}`} aria-pressed={form.budgetMode === 'CAMPAIGN'} onClick={() => patch({ budgetMode: 'CAMPAIGN' })}>
              {form.budgetMode === 'CAMPAIGN' && <span className={styles.toggleCheck} aria-hidden="true">✓ </span>}
              Campaign (CBO)
            </button>
          </div>
          <span className={styles.hint}>
            {form.budgetMode === 'CAMPAIGN'
              ? `CBO (Campaign Budget Optimization): one daily budget for the whole campaign — ${whop ? 'Meta' : 'Facebook'} spreads it across ad sets automatically.`
              : 'ABO (Ad-set Budget Optimization): a separate daily budget you set for each ad set.'}
          </span>
        </div>
        {form.budgetMode === 'CAMPAIGN' && (
          <div className={styles.field}>
            <label className={styles.label} htmlFor={fid('cbo-budget')}>Campaign daily budget (USD)<Req /></label>
            <input id={fid('cbo-budget')} className={styles.input} type="number" min={whop ? '5' : '2'} step={whop ? '0.01' : '1'} value={form.dailyBudget} onChange={(e) => patch({ dailyBudget: e.target.value })} aria-describedby={fid('cbo-budget-hint')} />
            <span id={fid('cbo-budget-hint')} className={styles.hint}>{budgetHint(form)}</span>
          </div>
        )}
        <div className={`${styles.field} ${styles.full}`}>
          <span className={styles.label}>Special ad categories</span>
          <ChipGroup
            ariaLabel="Special ad categories"
            options={SPECIAL_AD_CATEGORIES.filter((c) => !whop || WHOP_SPECIAL_CATEGORY[c] || form.specialAdCategories.includes(c)).map((c) => ({
              value: c,
              label: `${c.replace(/_/g, ' ').toLowerCase()}${whop && !WHOP_SPECIAL_CATEGORY[c] ? ' (not on Whop)' : ''}`,
            }))}
            selected={form.specialAdCategories}
            onToggle={(v) => {
              const next = toggle(form.specialAdCategories, v);
              // On Whop a special category forbids narrowing the age range: put every ad set back to 18-65 instead of letting it fail at launch.
              const lock = whop && next.some((c) => Boolean(WHOP_SPECIAL_CATEGORY[c]));
              patch({ specialAdCategories: next, ...(lock ? { adSets: form.adSets.map((a) => ({ ...a, ageMin: WHOP_SPECIAL_AGE_MIN, ageMax: WHOP_SPECIAL_AGE_MAX })) } : {}) });
            }}
            onClear={() => patch({ specialAdCategories: [] })}
            allLabel="None"
          />
          <span className={styles.hint}>Required by {whop ? 'Meta' : 'Facebook'} for credit / employment / housing / social-issue offers.</span>
          {whop && form.specialAdCategories.some((c) => !WHOP_SPECIAL_CATEGORY[c]) && (
            <span className={styles.hint} role="alert" style={{ color: 'var(--red-text)' }}>
              Whop has no category for {form.specialAdCategories.filter((c) => !WHOP_SPECIAL_CATEGORY[c]).map((c) => `“${c.replace(/_/g, ' ').toLowerCase()}”`).join(', ')}. A campaign cannot go out without a category it needs: deselect it only if it does not apply, or switch this campaign back to Facebook.
            </span>
          )}
        </div>
        {whop ? (
          <>
            <div className={styles.field} role="group" aria-label="Whop business">
              <span className={styles.label}>Whop business<Req /></span>
              <SearchSelect
                value={form.whopConnectionId}
                onChange={(v) => patch({ whopConnectionId: v, whopPageId: '' })}
                disabled={readOnly}
                placeholder="Search your Whop businesses…"
                options={connections.map((c) => ({
                  value: c.id,
                  label: c.label ?? c.bizId,
                  sublabel: `${c.bizId} · ${c.environment === 'SANDBOX' ? 'sandbox' : 'live'}${c.status === 'BROKEN' ? ' · needs attention' : ''}`,
                }))}
                emptyText="No Whop business is connected yet. Connect one on the Whop tab."
              />
            </div>
            <div className={styles.field} role="group" aria-label="Facebook page">
              <span className={styles.label}>Facebook page<Req /></span>
              <SearchSelect
                value={form.whopPageId}
                onChange={(v) => patch({ whopPageId: v })}
                disabled={readOnly || !form.whopConnectionId}
                placeholder={form.whopConnectionId ? 'Search pages…' : 'Pick a Whop business first'}
                options={whopPages.map((p) => ({ value: p.id, label: p.name ?? p.username ?? p.id, sublabel: p.error ? `${p.platform} · ${p.error}` : p.platform }))}
                emptyText="This business has no Facebook page yet. Connect Meta or create a Whop-managed page on the Whop tab."
              />
              <span className={styles.hint}>The page your Whop ads run under.</span>
            </div>
          </>
        ) : (
          <>
            <div className={styles.field} role="group" aria-label="Ad account">
              <span className={styles.label}>Ad account<Req /></span>
              <SearchSelect
                value={form.adAccountId}
                onChange={(v) => patch({ adAccountId: v, pageId: '' })}
                placeholder="Search ad accounts…"
                options={accounts.map((a) => ({ value: a.id, label: a.name, sublabel: `${a.fbAccountId} · ${a.currency}` }))}
              />
            </div>
            <div className={styles.field} role="group" aria-label="Page">
              <span className={styles.label}>Page<Req /></span>
              <SearchSelect
                value={form.pageId}
                onChange={(v) => patch({ pageId: v })}
                disabled={!form.adAccountId}
                placeholder={form.adAccountId ? 'Search pages…' : 'Pick an ad account first'}
                options={pages.map((p) => ({ value: p.id, label: p.name, sublabel: p.fbPageId }))}
                emptyText="No Pages found for this profile. Make sure your Facebook profile/Business manages a Page, then click Re-sync on the Facebook tab."
              />
            </div>
          </>
        )}
        <div className={`${styles.field} ${styles.full}`} role="group" aria-label="Destination websites">
          <span className={styles.label}>Destination website(s)<Req /></span>
          <span className={styles.hint}>Where the ads send traffic — the monetized article site(s). AFS revenue is attributed per site. Add one, or split traffic across several by weight.</span>
          {offerDomains.length === 0 ? (
            <div className={styles.issues} role="status" style={{ marginTop: '0.5rem' }}>
              <div style={{ fontSize: '0.83rem' }}>No websites are available to your company yet. Ask your admin to register (and share) a website under <strong>Domains</strong>; it&apos;ll then appear here.</div>
            </div>
          ) : (
            <div className={styles.offerRows}>
              {offers.map((o, i) => (
                <div key={i} className={styles.offerRow}>
                  <div className={styles.offerDomain} role="group" aria-label={`Destination website ${i + 1}`}>
                    <SearchSelect
                      value={o.domainId}
                      onChange={(v) => setOfferRow(i, { domainId: v })}
                      disabled={readOnly}
                      placeholder="Choose a website…"
                      options={offerDomains.map((d) => ({ value: d.id, label: d.host, sublabel: d.afsLabel ?? undefined }))}
                    />
                  </div>
                  <select className={`${styles.select} ${styles.offerKind}`} value={o.kind} disabled={readOnly} aria-label={`Destination website ${i + 1} type`} onChange={(e) => setOfferRow(i, { kind: e.target.value as OfferDraft['kind'] })}>
                    <option value="PAID">Paid (ad traffic)</option>
                    <option value="ORGANIC">Organic (fallback)</option>
                  </select>
                  <input
                    className={`${styles.input} ${styles.offerWeight}`}
                    type="number"
                    min={0}
                    max={100}
                    value={o.weightPct}
                    disabled={o.kind === 'ORGANIC' || readOnly}
                    onChange={(e) => setOfferRow(i, { weightPct: Math.max(0, Math.min(100, Number(e.target.value) || 0)) })}
                    aria-label={`Destination website ${i + 1} traffic weight %`}
                  />
                  <span className={styles.hint} aria-hidden="true">%</span>
                  {offers.length > 1 && !readOnly && (
                    <button type="button" className={styles.removeBtn} aria-label={`Remove destination website ${i + 1}`} onClick={() => removeOfferRow(i)}>
                      Remove
                    </button>
                  )}
                </div>
              ))}
              {!readOnly && (
                <button type="button" className={styles.addBtn} style={{ alignSelf: 'flex-start' }} onClick={addOfferRow}>
                  + Add another website
                </button>
              )}
              <span className={styles.hint}>Paid weights total {paidWeight}% (traffic is split across paid sites in proportion).</span>
            </div>
          )}
        </div>
        <div className={styles.field}>
          <label className={styles.label} htmlFor={fid('rac')}>Referrer Ad Creative<Req /></label>
          <div className={styles.keywordRow}>
            <input id={fid('rac')} className={styles.input} value={form.racValue} onChange={(e) => patch({ racValue: e.target.value })} placeholder="e.g. Affordable Health Insurance Plans for Seniors" />
            {(() => {
              const firstHeadline = form.adSets[0]?.ads[0]?.headline?.trim() ?? '';
              const canCopy = firstHeadline.length > 0 && firstHeadline !== form.racValue.trim();
              return (
                <button
                  type="button"
                  className={styles.keywordAddBtn}
                  disabled={!canCopy}
                  title={firstHeadline ? `Use "${firstHeadline}"` : 'Add an ad headline on Step 2 first'}
                  onClick={() => patch({ racValue: firstHeadline })}
                >
                  Use first ad headline
                </button>
              );
            })()}
          </div>
          {rcHits.length > 0 && (
            <span className={styles.hintError} role="alert">
              {rcBlockedMessage(rcHits)}
            </span>
          )}
          <span className={styles.hint}>Sent to Google AFS as the referrer ad creative (required for paid traffic). The default for all the campaign's ads — once submitted, you can give each ad its own text (and set the related-search keywords) live in <b>Sent to Google</b> on the campaign page. <b>Should be a real search phrase</b> (like the ad headline itself), never the campaign name — Google returns zero related-search terms when it looks like a brand label.</span>
        </div>
        <div className={`${styles.field} ${styles.full}`}>
          <label className={styles.label} htmlFor={fid('query')}>Landing-page query / angle</label>
          <input id={fid('query')} className={styles.input} value={form.query} onChange={(e) => patch({ query: e.target.value })} placeholder='e.g. "Affordable health insurance plans for seniors"' />
          <span className={styles.hint}>Drives the AI article + AFS terms. Keep it short and specific.</span>
        </div>
        <div className={`${styles.field} ${styles.full}`}>
          <label className={styles.label} htmlFor={fid('keywords')}>Keywords<Req /></label>
          <div className={styles.keywordRow}>
            <input
              id={fid('keywords')}
              className={styles.input}
              value={keywordDraft}
              onChange={(e) => setKeywordDraft(e.target.value)}
              onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  addKeyword();
                }
              }}
              placeholder="Type a keyword, or paste a comma / line-separated list"
              aria-describedby={fid('keywords-hint')}
            />
            <button type="button" className={styles.keywordAddBtn} onClick={addKeyword} disabled={keywordDraft.trim().length === 0}>
              Add
            </button>
          </div>
          <span id={fid('keywords-hint')} className={styles.hint}>
            Press Enter or Add. Paste a comma- or newline-separated list to add many at once.
          </span>
          {keywordNote && (
            <span className={styles.hint} role="status" style={{ color: 'var(--amber)' }}>
              {keywordNote}
            </span>
          )}
          {form.keywords.length > 0 && (
            <div className={styles.chips}>
              {form.keywords.map((k) => (
                <span key={k} className={styles.chip}>
                  {k}
                  <button type="button" className={styles.chipX} aria-label={`Remove ${k}`} onClick={() => patch({ keywords: form.keywords.filter((x) => x !== k) })}>
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>
        <div className={styles.field}>
          <label className={styles.label} htmlFor={fid('name-tpl')}>Campaign name template</label>
          <input id={fid('name-tpl')} className={styles.input} value={form.nameTemplate} onChange={(e) => patch({ nameTemplate: e.target.value })} placeholder="{country} - {query} - {id}" />
        </div>
        <div className={styles.field}>
          <label className={styles.label} htmlFor={fid('adset-tpl')}>Ad set name template</label>
          <input id={fid('adset-tpl')} className={styles.input} value={form.adsetNameTemplate} onChange={(e) => patch({ adsetNameTemplate: e.target.value })} placeholder="{country} - {age} - {id}" />
        </div>
        {!isCloaker && (
          <div className={`${styles.field} ${styles.full}`}>
            <label className={styles.label} htmlFor={fid('fallback')}>Fallback URL (non-ad traffic)</label>
            <input id={fid('fallback')} className={styles.input} value={form.fallbackUrl} onChange={(e) => patch({ fallbackUrl: e.target.value })} placeholder="https://…" />
          </div>
        )}
      </div>
    </div>
  );
}

/** One-line collapsed summary for an ad set: name · countries · daily budget. */
function adSetSummary(set: AdSetForm, cbo: boolean): string {
  const parts = [set.name.trim() || 'Untitled ad set'];
  parts.push(set.countries.length > 0 ? set.countries.join(', ') : 'no countries');
  if (!cbo) {
    const cents = centsOrUndef(set.dailyBudget);
    parts.push(cents ? `${MONEY(cents)}/day` : 'no budget');
  }
  return parts.join(' · ');
}

/** One-line collapsed summary for an ad: name/headline · CTA · creative state. */
function adSummary(ad: AdForm): string {
  const title = ad.name.trim() || ad.headline.trim() || 'Untitled ad';
  return `${title} · ${ad.cta.replace(/_/g, ' ')} · ${ad.uploadId ? 'creative attached' : 'no creative'}`;
}

function AdSetsStep({
  form,
  pixels,
  patchAdSet,
  patchAd,
  setForm,
  uploadingKey,
  uploadCreative,
  isCloaker,
  adAccountTz,
}: {
  form: CampaignForm;
  pixels: FbPixel[];
  patchAdSet: (key: string, p: Partial<AdSetForm>) => void;
  patchAd: (setKey: string, adKey: string, p: Partial<AdForm>) => void;
  setForm: (updater: (f: CampaignForm) => CampaignForm) => void;
  uploadingKey: string | null;
  uploadCreative: (setKey: string, ad: AdForm, file: File) => void;
  isCloaker: boolean;
  /** The selected ad account's IANA timezone — start/end wall-clocks are shown/scheduled in it. */
  adAccountTz: string;
}) {
  const cbo = form.budgetMode === 'CAMPAIGN';
  const whop = form.adProvider === 'WHOP';
  const hasAccount = Boolean(form.adAccountId);
  // Whop has no name for a few placements (e.g. Facebook video feeds, Messenger inbox): offer only what it can target, plus any the
  // ad set already has selected (kept when the buyer switched network, marked, so they can be removed rather than silently lost).
  const placementGroupsFor = (set: AdSetForm): Record<string, typeof PLACEMENT_OPTIONS[number][]> => {
    const groups: Record<string, typeof PLACEMENT_OPTIONS[number][]> = {};
    for (const p of PLACEMENT_OPTIONS) if (!whop || WHOP_PLACEMENT[p.key] || set.placements.includes(p.key)) (groups[p.platform] ??= []).push(p);
    return groups;
  };
  const ctaOptions = useMemo(() => CTA_OPTIONS.filter((c) => !whop || WHOP_CTAS.includes(c.toLowerCase())), [whop]);

  // Collapse state for ad-set and ad cards (keyed by their stable `key`).
  // Default the 2nd+ ad set collapsed to reduce visual load on arrival.
  const [collapsedSets, setCollapsedSets] = useState<Set<string>>(() => new Set(form.adSets.slice(1).map((s) => s.key)));
  const [collapsedAds, setCollapsedAds] = useState<Set<string>>(() => new Set());
  const toggleSet = (key: string) =>
    setCollapsedSets((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const toggleAd = (key: string) =>
    setCollapsedAds((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const addAdSet = () =>
    setForm((f) => {
      const next = emptyAdSet(f.adSets.length + 1);
      // New ad sets open expanded so the buyer can fill them in immediately.
      setCollapsedSets((prev) => {
        const s = new Set(prev);
        s.delete(next.key);
        return s;
      });
      return { ...f, adSets: [...f.adSets, next] };
    });
  const removeAdSet = (key: string) => setForm((f) => ({ ...f, adSets: f.adSets.filter((s) => s.key !== key) }));
  const addAd = (setKey: string) =>
    setForm((f) => ({
      ...f,
      adSets: f.adSets.map((s) => (s.key === setKey ? { ...s, ads: [...s.ads, emptyAd()] } : s)),
    }));
  const removeAd = (setKey: string, adKey: string) =>
    setForm((f) => ({ ...f, adSets: f.adSets.map((s) => (s.key === setKey ? { ...s, ads: s.ads.filter((a) => a.key !== adKey) } : s)) }));

  return (
    <div>
      {form.adSets.map((set, i) => {
        const setOpen = !collapsedSets.has(set.key);
        const setPanelId = `${set.key}-panel`;
        return (
        <div key={set.key} className={styles.adset}>
          <div className={styles.adsetHead}>
            <button
              type="button"
              className={styles.collapseHead}
              aria-expanded={setOpen}
              aria-controls={setPanelId}
              onClick={() => toggleSet(set.key)}
            >
              <span className={`${styles.chevron} ${setOpen ? styles.chevronOpen : ''}`} aria-hidden="true">▶</span>
              <span className={styles.adsetTitle}>Ad set {i + 1}</span>
              {!setOpen && <span className={styles.collapseSummary}>{adSetSummary(set, cbo)}</span>}
            </button>
            {form.adSets.length > 1 && (
              <button type="button" className={styles.removeBtn} aria-label={`Remove ad set ${i + 1}`} onClick={() => removeAdSet(set.key)}>
                Remove ad set
              </button>
            )}
          </div>

          {setOpen && (
          <div id={setPanelId}>
          <div className={styles.grid}>
            <div className={styles.field}>
              <label className={styles.label} htmlFor={`${set.key}-name`}>Name<Req /></label>
              <input id={`${set.key}-name`} className={styles.input} value={set.name} onChange={(e) => patchAdSet(set.key, { name: e.target.value })} />
            </div>
            {!cbo && (
              <div className={styles.field}>
                <label className={styles.label} htmlFor={`${set.key}-budget`}>Daily budget (USD)<Req /></label>
                <input id={`${set.key}-budget`} className={styles.input} type="number" min={whop ? '5' : '2'} step={whop ? '0.01' : '1'} value={set.dailyBudget} onChange={(e) => patchAdSet(set.key, { dailyBudget: e.target.value })} aria-describedby={`${set.key}-budget-hint`} />
                <span id={`${set.key}-budget-hint`} className={styles.hint}>{budgetHint(form)}</span>
              </div>
            )}
          </div>

          {/* Audience */}
          <div className={styles.section}>
            <div className={styles.sectionHead}>
              <h3 className={styles.sectionTitle}>Audience</h3>
            </div>
            <div className={styles.field}>
              <span className={styles.label}>Countries<Req /></span>
              <CountryPicker ariaLabel="Target countries" worldwide selected={set.countries} onChange={(codes) => patchAdSet(set.key, { countries: codes })} />
            </div>
            {/* Collapsed by default — most campaigns don't exclude countries. Expandable on click;
                auto-opens when exclusions already exist (e.g. editing a campaign that had some). */}
            <details className={styles.field} style={{ marginTop: '1rem' }} open={set.excludeCountries.length > 0}>
              <summary className={styles.label} style={{ cursor: 'pointer' }}>
                Exclude countries{set.excludeCountries.length > 0 ? ` (${set.excludeCountries.length})` : ''}
              </summary>
              <div style={{ marginTop: '0.5rem' }}>
                <CountryPicker ariaLabel="Exclude countries" selected={set.excludeCountries} onChange={(codes) => patchAdSet(set.key, { excludeCountries: codes })} placeholder="Search countries to exclude…" />
              </div>
            </details>
            <div className={styles.grid} style={{ marginTop: '1rem' }}>
              <div className={styles.field}>
                <label className={styles.label} htmlFor={`${set.key}-agemin`}>Age min</label>
                <input id={`${set.key}-agemin`} className={styles.input} type="number" min={AGE_BOUND_MIN} max={AGE_BOUND_MAX} value={set.ageMin} onChange={(e) => patchAdSet(set.key, { ageMin: Number(e.target.value) })} />
              </div>
              <div className={styles.field}>
                <label className={styles.label} htmlFor={`${set.key}-agemax`}>Age max</label>
                <input id={`${set.key}-agemax`} className={styles.input} type="number" min={AGE_BOUND_MIN} max={AGE_BOUND_MAX} value={set.ageMax} onChange={(e) => patchAdSet(set.key, { ageMax: Number(e.target.value) })} />
              </div>
              {whopAgeLocked(form) && (
                <div className={`${styles.field} ${styles.full}`}>
                  <span className={styles.hint} role={set.ageMin !== WHOP_SPECIAL_AGE_MIN || set.ageMax < WHOP_SPECIAL_AGE_MAX ? 'alert' : undefined} style={set.ageMin !== WHOP_SPECIAL_AGE_MIN || set.ageMax < WHOP_SPECIAL_AGE_MAX ? { color: 'var(--red-text)' } : undefined}>
                    {WHOP_AGE_RULE_TEXT}
                  </span>
                </div>
              )}
              <div className={styles.field}>
                <span className={styles.label}>Gender</span>
                <ChipGroup ariaLabel="Gender" options={GENDERS.map((g) => ({ value: g, label: g[0]!.toUpperCase() + g.slice(1) }))} selected={set.genders} onToggle={(g) => patchAdSet(set.key, { genders: toggle(set.genders, g) })} onClear={() => patchAdSet(set.key, { genders: [] })} allLabel="All" />
              </div>
              <div className={styles.field}>
                <span className={styles.label}>Devices</span>
                <ChipGroup ariaLabel="Devices" options={DEVICE_PLATFORMS.map((d) => ({ value: d, label: d[0]!.toUpperCase() + d.slice(1) }))} selected={set.devicePlatforms} onToggle={(d) => patchAdSet(set.key, { devicePlatforms: toggle(set.devicePlatforms, d) })} onClear={() => patchAdSet(set.key, { devicePlatforms: [] })} allLabel="All" />
              </div>
              <div className={styles.field}>
                <span className={styles.label}>Mobile OS</span>
                <ChipGroup ariaLabel="Mobile OS" options={MOBILE_OS.map((o) => ({ value: o, label: o === 'ios' ? 'iOS' : 'Android' }))} selected={set.mobileOs} onToggle={(o) => patchAdSet(set.key, { mobileOs: toggle(set.mobileOs, o) })} onClear={() => patchAdSet(set.key, { mobileOs: [] })} allLabel="All" />
              </div>
              <div className={styles.field}>
                <span className={styles.label}>Advantage+ audience</span>
                <div className={styles.toggle}>
                  <button type="button" className={`${styles.toggleBtn} ${set.advantageAudience ? styles.toggleOn : ''}`} aria-pressed={set.advantageAudience} aria-label="Advantage+ audience" onClick={() => patchAdSet(set.key, { advantageAudience: !set.advantageAudience })}>
                    {set.advantageAudience && <span className={styles.toggleCheck} aria-hidden="true">✓ </span>}
                    {set.advantageAudience ? 'On' : 'Off'}
                  </button>
                </div>
              </div>
            </div>
          </div>

          {/* Placements */}
          <div className={styles.section}>
            <div className={styles.sectionHead}>
              <h3 className={styles.sectionTitle}>Placements</h3>
            </div>
            <div className={styles.toggle} role="group" aria-label="Placement mode">
              <button type="button" className={`${styles.toggleBtn} ${set.placementMode === 'automatic' ? styles.toggleOn : ''}`} aria-pressed={set.placementMode === 'automatic'} onClick={() => patchAdSet(set.key, { placementMode: 'automatic' })}>
                {set.placementMode === 'automatic' && <span className={styles.toggleCheck} aria-hidden="true">✓ </span>}
                Automatic
              </button>
              <button type="button" className={`${styles.toggleBtn} ${set.placementMode === 'manual' ? styles.toggleOn : ''}`} aria-pressed={set.placementMode === 'manual'} onClick={() => patchAdSet(set.key, { placementMode: 'manual' })}>
                {set.placementMode === 'manual' && <span className={styles.toggleCheck} aria-hidden="true">✓ </span>}
                Manual
              </button>
            </div>
            {set.placementMode === 'manual' &&
              Object.entries(placementGroupsFor(set)).map(([platform, opts]) => (
                <div key={platform} style={{ marginTop: '0.7rem' }}>
                  <span className={styles.metaLabel}>{platform}</span>
                  <div className={styles.toggle} role="group" aria-label={`${platform} placements`} style={{ marginTop: '0.3rem' }}>
                    {opts.map((o) => {
                      const on = set.placements.includes(o.key);
                      return (
                        <button key={o.key} type="button" className={`${styles.toggleBtn} ${on ? styles.toggleOn : ''}`} aria-pressed={on} onClick={() => patchAdSet(set.key, { placements: toggle(set.placements, o.key) })}>
                          {on && <span className={styles.toggleCheck} aria-hidden="true">✓ </span>}
                          {o.label}
                          {whop && !WHOP_PLACEMENT[o.key] ? ' (not on Whop)' : ''}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            {whop && set.placementMode === 'manual' && set.placements.some((k) => !WHOP_PLACEMENT[k]) && (
              <span className={styles.hint} role="alert" style={{ color: 'var(--red-text)', display: 'block', marginTop: '0.5rem' }}>
                Whop cannot target the placements marked “not on Whop”. Deselect them, or switch this campaign back to Facebook.
              </span>
            )}
          </div>

          {/* Conversion tracking */}
          <div className={styles.section}>
            <div className={styles.sectionHead}>
              <h3 className={styles.sectionTitle}>Conversion tracking</h3>
            </div>
            <div className={styles.grid}>
              <div className={styles.field}>
                <span className={styles.label}>Performance goal</span>
                <div className={styles.staticField} aria-label="Performance goal: Conversions">
                  Conversions
                </div>
                <span className={styles.hint}>
                  {whop
                    ? 'Conversion location: Website. Optimized for the monetized ad click (Whop “Submit application” event).'
                    : 'Conversion location: Website. Optimized for the monetized ad click (Facebook “Search” event) — a pixel is required.'}
                </span>
              </div>
              {!whop && (
                <div className={styles.field}>
                  <label className={styles.label} htmlFor={`${set.key}-pixel`}>
                    Pixel
                    <Req />
                  </label>
                  <select id={`${set.key}-pixel`} className={styles.select} value={set.pixelId ?? ''} onChange={(e) => patchAdSet(set.key, { pixelId: e.target.value || undefined })} disabled={!hasAccount}>
                    <option value="">{hasAccount ? 'Select a pixel…' : 'Pick an ad account first'}</option>
                    {pixels.map((px) => (
                      <option key={px.id} value={px.id}>
                        {px.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>
            {whop ? (
              <p className={styles.hint}>
                There is no pixel to pick: Whop owns it, and our funnel reports each step to Whop for you — <strong>View content</strong> (article
                view) → <strong>Add to cart</strong> (search results) → <strong>Submit application</strong> (monetized ad click). Whop optimizes delivery
                toward the deepest one — the ad click.
              </p>
            ) : (
              <p className={styles.hint}>
                The conversion funnel fires automatically: <strong>ViewContent</strong> (article view) →{' '}
                <strong>AddToCart</strong> (search results) → <strong>Search</strong> (monetized ad click). Facebook optimizes
                delivery toward the deepest one — the ad click.
              </p>
            )}
          </div>

          {/* Optimization & schedule */}
          <div className={styles.section}>
            <div className={styles.sectionHead}>
              <h3 className={styles.sectionTitle}>Optimization & schedule</h3>
            </div>
            <div className={styles.grid}>
              <div className={styles.field}>
                <label className={styles.label} htmlFor={`${set.key}-bid`}>Bid strategy</label>
                <select id={`${set.key}-bid`} className={styles.select} value={set.bidStrategy} onChange={(e) => patchAdSet(set.key, { bidStrategy: e.target.value as BidStrategy | '' })}>
                  <option value="">Highest volume (default)</option>
                  {BID_STRATEGIES.filter((b) => !whop || b !== 'LOWEST_COST_WITH_MIN_ROAS' || set.bidStrategy === b).map((b) => (
                    <option key={b} value={b}>
                      {b.replace(/_/g, ' ').toLowerCase()}
                      {whop && b === 'LOWEST_COST_WITH_MIN_ROAS' ? ' (not on Whop)' : ''}
                    </option>
                  ))}
                </select>
                {whop && set.bidStrategy === 'LOWEST_COST_WITH_MIN_ROAS' && (
                  <span className={styles.hint} role="alert" style={{ color: 'var(--red-text)' }}>
                    Whop has no ROAS-goal bid strategy. Pick another, or switch this campaign back to Facebook.
                  </span>
                )}
              </div>
              <div className={styles.field}>
                <label className={styles.label} htmlFor={`${set.key}-costcap`}>Cost cap (USD, optional)</label>
                <input id={`${set.key}-costcap`} className={styles.input} type="number" min="0" step="0.01" value={set.costCap} onChange={(e) => patchAdSet(set.key, { costCap: e.target.value })} />
              </div>
              {!whop && (
                <>
                  <div className={styles.field}>
                    <label className={styles.label} htmlFor={`${set.key}-roas`}>Min. return target (optional)</label>
                    <input id={`${set.key}-roas`} className={styles.input} type="number" min="0" step="0.1" value={set.roasFactor} onChange={(e) => patchAdSet(set.key, { roasFactor: e.target.value })} aria-describedby={`${set.key}-roas-hint`} />
                    <span id={`${set.key}-roas-hint`} className={styles.hint}>Facebook value-bid target, as a multiple of spend (e.g. 2 = aim for $2 back per $1). A bidding goal — not the ROI metric.</span>
                  </div>
                  <div className={styles.field}>
                    <label className={styles.label} htmlFor={`${set.key}-attr`}>Attribution window</label>
                    <select id={`${set.key}-attr`} className={styles.select} value={set.attributionWindow} onChange={(e) => patchAdSet(set.key, { attributionWindow: e.target.value as AttributionWindow | '' })}>
                      <option value="">Default</option>
                      {ATTRIBUTION_WINDOWS.map((w) => (
                        <option key={w} value={w}>
                          {w.replace(/_/g, ' ')}
                        </option>
                      ))}
                    </select>
                  </div>
                </>
              )}
              <div className={styles.field}>
                <label className={styles.label}>Start (optional)</label>
                <DateTimePicker
                  value={set.startTime}
                  onChange={(v) => patchAdSet(set.key, { startTime: v })}
                  timezone={adAccountTz}
                  ariaLabel="Ad set start date & time"
                  placeholder="Starts immediately"
                />
              </div>
              <div className={styles.field}>
                <label className={styles.label}>End (optional)</label>
                <DateTimePicker
                  value={set.endTime}
                  onChange={(v) => patchAdSet(set.key, { endTime: v })}
                  min={set.startTime || undefined}
                  timezone={adAccountTz}
                  ariaLabel="Ad set end date & time"
                  placeholder="Runs until paused"
                />
              </div>
            </div>
          </div>

          {/* Ads */}
          <div className={styles.section}>
            <div className={styles.sectionHead}>
              <h3 className={styles.sectionTitle}>Ads</h3>
              <span className={styles.count} aria-label={`${set.ads.length} ad${set.ads.length === 1 ? '' : 's'}`}>{set.ads.length}</span>
            </div>
            {set.ads.map((ad, j) => {
              const adOpen = !collapsedAds.has(ad.key);
              const adPanelId = `${ad.key}-panel`;
              return (
              <div key={ad.key} className={styles.ad}>
                <div className={styles.adHead}>
                  <button
                    type="button"
                    className={styles.collapseHead}
                    aria-expanded={adOpen}
                    aria-controls={adPanelId}
                    onClick={() => toggleAd(ad.key)}
                  >
                    <span className={`${styles.chevron} ${adOpen ? styles.chevronOpen : ''}`} aria-hidden="true">▶</span>
                    <span className={styles.adLabel}>
                      AD {i + 1}.{j + 1}
                    </span>
                    {!adOpen && <span className={styles.collapseSummary}>{adSummary(ad)}</span>}
                  </button>
                  {set.ads.length > 1 && (
                    <button type="button" className={styles.removeBtn} aria-label={`Remove ad ${i + 1}.${j + 1}`} onClick={() => removeAd(set.key, ad.key)}>
                      Remove
                    </button>
                  )}
                </div>
                {adOpen && (
                <div id={adPanelId} className={styles.grid}>
                  <div className={styles.field}>
                    <label className={styles.label} htmlFor={`${ad.key}-name`}>Ad name<Req /></label>
                    <input id={`${ad.key}-name`} className={styles.input} value={ad.name} onChange={(e) => patchAd(set.key, ad.key, { name: e.target.value })} />
                  </div>
                  <div className={styles.field}>
                    <label className={styles.label} htmlFor={`${ad.key}-headline`}>Headline</label>
                    <input id={`${ad.key}-headline`} className={styles.input} value={ad.headline} onChange={(e) => patchAd(set.key, ad.key, { headline: e.target.value })} />
                  </div>
                  <div className={`${styles.field} ${styles.full}`}>
                    <label className={styles.label} htmlFor={`${ad.key}-primary`}>Primary text</label>
                    <textarea id={`${ad.key}-primary`} className={styles.textarea} value={ad.primaryText} onChange={(e) => patchAd(set.key, ad.key, { primaryText: e.target.value })} />
                  </div>
                  <div className={styles.field}>
                    <label className={styles.label} htmlFor={`${ad.key}-cta`}>Call to action</label>
                    <select id={`${ad.key}-cta`} className={styles.select} value={ad.cta} onChange={(e) => patchAd(set.key, ad.key, { cta: e.target.value as CtaOption })}>
                      {ctaOptions.map((c) => (
                        <option key={c} value={c}>
                          {c.replace(/_/g, ' ')}
                        </option>
                      ))}
                    </select>
                  </div>
                  {!isCloaker && !whop && (
                    <div className={styles.field}>
                      <label className={styles.label} htmlFor={`${ad.key}-displaylink`}>Display link</label>
                      <input
                        id={`${ad.key}-displaylink`}
                        className={styles.input}
                        value={ad.displayLink}
                        onChange={(e) => patchAd(set.key, ad.key, { displayLink: e.target.value })}
                        placeholder="yourbrand.com (optional)"
                      />
                      <span className={styles.hint}>The visible URL shown in the ad. Should plausibly match where people land; ignored on Instagram. Leave blank to use the destination domain.</span>
                    </div>
                  )}
                  <div className={`${styles.field} ${styles.full}`}>
                    <span className={styles.label}>Creative<Req /></span>
                    <div className={styles.creative}>
                      {ad.previewUrl && <img className={styles.thumb} src={ad.previewUrl} alt="creative preview" />}
                      <label className={styles.chipBtn} style={{ cursor: 'pointer' }}>
                        {uploadingKey === ad.key ? 'Uploading…' : ad.uploadId ? 'Replace' : 'Upload image / video'}
                        <input
                          type="file"
                          accept="image/*,video/mp4,video/quicktime"
                          aria-label={`Upload creative for ad ${i + 1}.${j + 1}`}
                          hidden
                          onChange={(e: ChangeEvent<HTMLInputElement>) => {
                            const file = e.target.files?.[0];
                            if (file) uploadCreative(set.key, ad, file);
                          }}
                        />
                      </label>
                      {ad.uploadName && <span className={styles.creativeMeta}>{ad.uploadName}</span>}
                    </div>
                  </div>
                </div>
                )}
              </div>
              );
            })}
            <div style={{ marginTop: '0.75rem' }}>
              <button type="button" className={styles.addBtn} onClick={() => addAd(set.key)}>
                + Add ad
              </button>
            </div>
          </div>
          </div>
          )}
        </div>
        );
      })}

      <button type="button" className={styles.addBtn} onClick={addAdSet}>
        + Add ad set
      </button>
    </div>
  );
}

function ReviewStep({ form, accounts, pages, connections, whopOn, offers, issues, campaign }: { form: CampaignForm; accounts: FbAccount[]; pages: FbPage[]; connections: WhopConnection[]; whopOn: boolean; offers: OfferDraft[]; issues: string[]; campaign?: Campaign }) {
  const whop = form.adProvider === 'WHOP';
  // For a saved campaign, prefer the server-resolved labels (`campaign.adAccount` / `.page`) —
  // an admin reviewing another user's campaign won't have that user's FB assets in their own
  // `accounts` / `pages` lists, so the local lookup returns undefined and the row renders "—"
  // with a spurious "not selected" warning. The server sends the resolved name for both roles.
  // The saved labels describe the SAVED choice only: after the buyer picks another account or page (or switches network and back),
  // the live lists name what is selected now, never the old one.
  const savedAccount = campaign && (campaign.adAccountId ?? '') === form.adAccountId ? campaign.adAccount : null;
  const savedFbPage = campaign && (campaign.pageId ?? '') === form.pageId ? campaign.page : null;
  const accountName = savedAccount?.name ?? accounts.find((a) => a.id === form.adAccountId)?.name;
  const pageName = savedFbPage?.name ?? pages.find((p) => p.id === form.pageId)?.name;
  const accountSelected = Boolean(form.adAccountId) && (Boolean(savedAccount) || accounts.some((a) => a.id === form.adAccountId));
  const pageSelected = Boolean(form.pageId) && (Boolean(savedFbPage) || pages.some((p) => p.id === form.pageId));
  const totalAds = form.adSets.reduce((n, s) => n + s.ads.length, 0);
  const budget = form.budgetMode === 'CAMPAIGN' ? centsOrUndef(form.dailyBudget) ?? 0 : form.adSets.reduce((n, s) => n + (centsOrUndef(s.dailyBudget) ?? 0), 0);

  // Whop (D33): the business and page are the connected business's, labelled server-side so a reviewer sees them too. The saved
  // labels describe the SAVED choice only: once the buyer picks another business or page, the live lists name it instead.
  const connection = connections.find((c) => c.id === form.whopConnectionId);
  const savedBusiness = campaign && campaign.whopConnectionId === form.whopConnectionId ? campaign.whopBusiness : null;
  const savedPage = campaign && campaign.whopPageId === form.whopPageId ? campaign.whopPage : null;
  const businessName = connection?.label ?? connection?.bizId ?? savedBusiness?.label ?? savedBusiness?.bizId;
  const whopPageName = connection?.pages.find((p) => p.id === form.whopPageId)?.name ?? savedPage?.name ?? savedPage?.whopId;
  const businessSelected = Boolean(form.whopConnectionId) && (Boolean(savedBusiness) || Boolean(connection));
  const whopPageSelected = Boolean(form.whopPageId);

  // Pre-launch readiness — the things the ad network checks at launch, surfaced up front.
  const checks: { label: string; ok: boolean }[] = whop
    ? [
        { label: `Daily budget set (have ${MONEY(budget)})`, ok: budget >= launchMinBudgetCents(form) },
        { label: 'Whop business selected', ok: businessSelected },
        // Only when the business is one the viewer can see (an admin reviewing a buyer's campaign cannot, and is told nothing wrong).
        ...(connection ? [{ label: 'Whop connection working', ok: connection.status !== 'BROKEN' }] : []),
        { label: 'Facebook page selected', ok: whopPageSelected },
        { label: 'At least one destination website', ok: offers.some((o) => o.kind === 'PAID' && o.domainId) },
        { label: 'Whop can run it as built (objective, categories, placements, bids, countries)', ok: whopProblems(form).length === 0 },
        { label: 'Every ad has a creative, a headline and primary text', ok: form.adSets.every((s) => s.ads.length > 0 && s.ads.every((a) => Boolean(a.uploadId) && a.headline.trim() !== '' && a.primaryText.trim() !== '')) },
      ]
    : [
        { label: `Daily budget ≥ $2.00 (have ${MONEY(budget)})`, ok: budget >= 200 },
        { label: 'Facebook ad account selected', ok: accountSelected },
        { label: 'Facebook page selected', ok: pageSelected },
        { label: 'At least one destination website', ok: offers.some((o) => o.kind === 'PAID' && o.domainId) },
        { label: `Performance goals valid for the ${form.objective.replace('OUTCOME_', '').toLowerCase()} objective`, ok: form.adSets.every((s) => isValidPerformanceGoal(form.objective, s.optimizationGoal)) },
        { label: 'Pixel assigned where the goal needs conversions', ok: form.adSets.every((s) => !goalRequiresPixel(s.optimizationGoal) || Boolean(s.pixelId)) },
        { label: 'Every ad has a creative', ok: form.adSets.every((s) => s.ads.length > 0 && s.ads.every((a) => Boolean(a.uploadId))) },
      ];

  return (
    <div>
      {issues.length > 0 && (
        <div className={styles.issues} role="alert">
          <div className={styles.issuesTitle}>Before you can submit:</div>
          <ul className={styles.issuesList}>
            {issues.map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
        </div>
      )}
      <div className={styles.summary} style={{ marginBottom: '1rem' }}>
        <div className={styles.summaryRow} style={{ borderBottom: '1px solid var(--border)' }}>
          <span className={styles.summaryKey}>Pre-launch checks</span>
          <span className={styles.summaryVal}>{checks.filter((c) => c.ok).length}/{checks.length} ready</span>
        </div>
        {checks.map((c) => (
          <div key={c.label} className={styles.summaryRow}>
            <span className={styles.summaryKey} style={{ color: c.ok ? 'var(--green)' : 'var(--red-text)' }}>
              <span aria-hidden="true">{c.ok ? '✓' : '⚠'}</span> <span className="srOnly">{c.ok ? 'Ready: ' : 'Not ready: '}</span>{c.label}
            </span>
            <span />
          </div>
        ))}
      </div>
      <div className={styles.summary}>
        <div className={styles.summaryRow}>
          <span className={styles.summaryKey}>Campaign</span>
          <span className={styles.summaryVal}>{form.name || '—'}</span>
        </div>
        {(whopOn || whop) && (
          <div className={styles.summaryRow}>
            <span className={styles.summaryKey}>Ad network</span>
            <span className={styles.summaryVal}>{whop ? 'Whop' : 'Facebook'}</span>
          </div>
        )}
        <div className={styles.summaryRow}>
          <span className={styles.summaryKey}>Objective · budget</span>
          <span className={styles.summaryVal}>
            {form.objective.replace('OUTCOME_', '')} · {form.budgetMode === 'CAMPAIGN' ? 'CBO' : 'ABO'}
            <InfoTip>
              {form.budgetMode === 'CAMPAIGN'
                ? `CBO — one daily budget for the whole campaign; ${whop ? 'Meta' : 'Facebook'} splits it across ad sets.`
                : 'ABO — a separate daily budget for each ad set.'}
            </InfoTip>
          </span>
        </div>
        {form.specialAdCategories.length > 0 && (
          <div className={styles.summaryRow}>
            <span className={styles.summaryKey}>Special ad categories</span>
            <span className={styles.summaryVal}>{form.specialAdCategories.join(', ').toLowerCase()}</span>
          </div>
        )}
        <div className={styles.summaryRow}>
          <span className={styles.summaryKey}>{whop ? 'Whop business / Page' : 'Ad account / Page'}</span>
          <span className={styles.summaryVal}>
            {whop ? `${businessName ?? '—'} · ${whopPageName ?? '—'}` : `${accountName ?? '—'} · ${pageName ?? '—'}`}
          </span>
        </div>
        <div className={styles.summaryRow}>
          <span className={styles.summaryKey}>Keywords</span>
          <span className={styles.summaryVal}>{form.keywords.join(', ') || '—'}</span>
        </div>
        <div className={styles.summaryRow}>
          <span className={styles.summaryKey}>Structure</span>
          <span className={styles.summaryVal}>
            {form.adSets.length} ad set{form.adSets.length === 1 ? '' : 's'} · {totalAds} ad{totalAds === 1 ? '' : 's'}
          </span>
        </div>
        <div className={styles.summaryRow}>
          <span className={styles.summaryKey}>Total daily budget</span>
          <span className={styles.summaryVal}>{MONEY(budget)}</span>
        </div>
        {form.adSets.map((s, i) => (
          <div key={s.key} className={styles.summaryRow}>
            <span className={styles.summaryKey}>Ad set {i + 1}</span>
            <span className={styles.summaryVal}>
              {s.countries.length > 0 ? s.countries.join(', ') : 'no countries'} · {s.ageMin}–{s.ageMax} · {s.genders.length === 0 ? 'all' : s.genders.join('/')} ·{' '}
              {s.placementMode === 'manual' ? `${s.placements.length} placements` : 'auto placements'}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
