'use client';

import { type ChangeEvent, type KeyboardEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  AGE_BOUND_MAX,
  AGE_BOUND_MIN,
  ATTRIBUTION_WINDOWS,
  BID_STRATEGIES,
  CAMPAIGN_OBJECTIVES,
  CONVERSION_TYPES,
  COUNTRIES,
  CTA_OPTIONS,
  DEVICE_PLATFORMS,
  GENDERS,
  LANGUAGES,
  MOBILE_OS,
  PLACEMENT_OPTIONS,
  PXE_EVENTS,
  SPECIAL_AD_CATEGORIES,
  type AttributionWindow,
  type BidStrategy,
  type CampaignDraftInput,
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
} from '@knn/shared';
import { ApiError, campaigns as campaignsApi, facebook, uploads as uploadsApi } from '@/lib/api';
import { type Campaign, type FbAccount, type FbPage, type FbPixel, type OfferDomainOption } from '@/lib/types';
import { Button, Card, SearchSelect, Spinner } from './ui';
import styles from './campaign-wizard.module.css';

interface AdForm {
  key: string;
  name: string;
  headline: string;
  primaryText: string;
  description: string;
  cta: CtaOption;
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
  objective: (typeof CAMPAIGN_OBJECTIVES)[number];
  specialAdCategories: SpecialAdCategory[];
  nameTemplate: string;
  adsetNameTemplate: string;
  budgetMode: 'AD_SET' | 'CAMPAIGN';
  dailyBudget: string;
  keywords: string[];
  racValue: string;
  query: string;
  fallbackUrl: string;
  adAccountId: string;
  pageId: string;
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
  return { key: uuid(), name: '', headline: '', primaryText: '', description: '', cta: 'LEARN_MORE', creativeType: 'IMAGE', fallbackUrl: '', beneficiary: '' };
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
    pxeEvent: 'search',
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
      adAccountId: '',
      pageId: '',
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
    adAccountId: c.adAccountId ?? '',
    pageId: c.pageId ?? '',
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
      pixelId: s.pixelId ?? undefined,
      pxeEvent: (s.pxeEvent as PxeEvent) ?? 'search',
      conversionType: (s.conversionType as ConversionType) ?? 'instant',
      bidStrategy: (s.bidStrategy as BidStrategy) ?? '',
      costCap: s.costCapCents ? (s.costCapCents / 100).toString() : '',
      roasFactor: s.roasFactor ? String(s.roasFactor) : '',
      attributionWindow: (s.attributionWindow as AttributionWindow) ?? '',
      startTime: s.startTime ? s.startTime.slice(0, 16) : '',
      endTime: s.endTime ? s.endTime.slice(0, 16) : '',
      timezone: s.timezone ?? '',
      ads: s.ads.map((a) => ({
        key: uuid(),
        name: a.name,
        headline: a.headline,
        primaryText: a.primaryText,
        description: a.description ?? '',
        cta: a.cta as CtaOption,
        creativeType: a.creativeType,
        uploadId: a.uploadId ?? undefined,
        uploadName: a.uploadId ? 'Attached creative' : undefined,
        fallbackUrl: a.fallbackUrl ?? '',
        beneficiary: a.beneficiary ?? '',
      })),
    })),
  };
}

function toDraft(form: CampaignForm): CampaignDraftInput {
  const cbo = form.budgetMode === 'CAMPAIGN';
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
    adAccountId: form.adAccountId || undefined,
    pageId: form.pageId || undefined,
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
      pixelId: s.pixelId || undefined,
      pxeEvent: s.pxeEvent,
      conversionType: s.conversionType,
      bidStrategy: s.bidStrategy || undefined,
      costCapCents: centsOrUndef(s.costCap),
      roasFactor: s.roasFactor ? Number(s.roasFactor) : undefined,
      attributionWindow: s.attributionWindow || undefined,
      startTime: s.startTime ? new Date(s.startTime).toISOString() : undefined,
      endTime: s.endTime ? new Date(s.endTime).toISOString() : undefined,
      timezone: s.timezone || undefined,
      ads: s.ads.map((a) => ({
        name: a.name.trim(),
        headline: a.headline.trim(),
        primaryText: a.primaryText.trim(),
        description: a.description.trim() || undefined,
        cta: a.cta,
        creativeType: a.creativeType,
        uploadId: a.uploadId,
        fallbackUrl: a.fallbackUrl.trim() || undefined,
        beneficiary: a.beneficiary.trim() || undefined,
      })),
    })),
  };
}

/** Hard fields the API's draft schema requires on present entities (blocks Save draft). */
function hardErrors(form: CampaignForm): string[] {
  const errs: string[] = [];
  if (!form.name.trim()) errs.push('Campaign name is required.');
  if (form.budgetMode === 'CAMPAIGN') {
    const c = centsOrUndef(form.dailyBudget);
    if (c !== undefined && c < 100) errs.push('Campaign daily budget must be at least $1.00.');
  }
  form.adSets.forEach((s, i) => {
    if (!s.name.trim()) errs.push(`Ad set ${i + 1}: name is required.`);
    if (form.budgetMode === 'AD_SET') {
      const c = centsOrUndef(s.dailyBudget);
      if (c !== undefined && c < 100) errs.push(`Ad set ${i + 1}: daily budget must be at least $1.00.`);
    }
    if (s.ageMax < s.ageMin) errs.push(`Ad set ${i + 1}: max age must be ≥ min age.`);
    s.ads.forEach((a, j) => {
      if (!a.headline.trim()) errs.push(`Ad ${i + 1}.${j + 1}: headline is required.`);
      if (!a.primaryText.trim()) errs.push(`Ad ${i + 1}.${j + 1}: primary text is required.`);
    });
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

/** Full completeness for submit — computed directly from the form (always specific). */
function formIssues(form: CampaignForm): string[] {
  const issues = [...hardErrors(form)];
  if (!form.adAccountId) issues.push('Select a Facebook ad account.');
  if (!form.pageId) issues.push('Select a Facebook page.');
  if (form.keywords.length === 0) issues.push('Add at least one keyword.');
  if (!form.racValue.trim()) issues.push('Set the RAC (Related Ad Category) value.');
  if (form.budgetMode === 'CAMPAIGN' && !centsOrUndef(form.dailyBudget)) issues.push('Set the campaign daily budget.');
  if (form.adSets.length === 0) issues.push('Add at least one ad set.');
  form.adSets.forEach((s, i) => {
    const L = `Ad set ${i + 1}`;
    if (form.budgetMode === 'AD_SET' && !centsOrUndef(s.dailyBudget)) issues.push(`${L} needs a daily budget.`);
    if (s.countries.length === 0) issues.push(`${L} needs at least one target country.`);
    if (!s.pixelId) issues.push(`${L} needs a pixel.`);
    if (s.placementMode === 'manual' && s.placements.length === 0) issues.push(`${L} needs at least one placement.`);
    if (s.ads.length === 0) issues.push(`${L} needs at least one ad.`);
    s.ads.forEach((a, j) => {
      if (!a.uploadId) issues.push(`Ad ${i + 1}.${j + 1} needs a creative.`);
    });
  });
  return [...new Set(issues)];
}

const STEPS = ['Offer', 'Ad sets', 'Review'];

export function CampaignWizard({ campaign }: { campaign?: Campaign }) {
  const router = useRouter();
  const readOnly = Boolean(campaign && campaign.status !== 'DRAFT');

  const [form, setForm] = useState<CampaignForm>(() => toForm(campaign));
  const [step, setStep] = useState(0);
  const [savedId, setSavedId] = useState<string | null>(campaign?.id ?? null);

  const [accounts, setAccounts] = useState<FbAccount[]>([]);
  const [pages, setPages] = useState<FbPage[]>([]);
  const [pixels, setPixels] = useState<FbPixel[]>([]);
  const [assetsLoading, setAssetsLoading] = useState(true);

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
      .finally(() => active && setAssetsLoading(false));
    return () => {
      active = false;
    };
  }, []);

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

  const issues = useMemo(() => [...formIssues(form), ...offerIssues(offers)], [form, offers]);

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
      const draft = toDraft(form);
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
      <div className={styles.head}>
        <div>
          <h1 className={`serif ${styles.title}`}>{readOnly ? campaign?.name : campaign ? 'Edit campaign' : 'New campaign'}</h1>
          <p className={styles.subtitle}>
            {readOnly ? 'This campaign has been submitted and is read-only.' : 'Campaign → ad sets (audience, placements, budget, pixel) → ads.'}
          </p>
        </div>
        <Link href="/dashboard/campaigns" className={styles.removeBtn} style={{ alignSelf: 'center' }}>
          Back to campaigns
        </Link>
      </div>

      {!readOnly && (
        <div className={styles.steps}>
          {STEPS.map((label, i) => (
            <div key={label} className={`${styles.step} ${i === step ? styles.stepActive : i < step ? styles.stepDone : ''}`} onClick={() => setStep(i)} role="button">
              <span className={styles.stepNum}>{i + 1}</span>
              {label}
            </div>
          ))}
        </div>
      )}

      {bannerError && <div className={styles.error}>{bannerError}</div>}
      {success && <div className={styles.banner}>{success}</div>}

      <Card className={styles.card}>
        {readOnly ? (
          <ReviewStep form={form} accounts={accounts} pages={pages} issues={[]} />
        ) : assetsLoading ? (
          <div className={styles.center}>
            <Spinner />
          </div>
        ) : step === 0 ? (
          <OfferStep
            form={form}
            patch={patch}
            accounts={accounts}
            pages={pages}
            offers={offers}
            setOffers={setOffers}
            offerDomains={offerDomains}
            readOnly={readOnly}
          />
        ) : step === 1 ? (
          <AdSetsStep form={form} pixels={pixels} patchAdSet={patchAdSet} patchAd={patchAd} setForm={setForm} uploadingKey={uploadingKey} uploadCreative={uploadCreative} />
        ) : (
          <ReviewStep form={form} accounts={accounts} pages={pages} issues={[...serverIssues, ...issues]} />
        )}
      </Card>

      {!readOnly && (
        <div className={styles.footer}>
          <Button variant="ghost" onClick={() => setStep((s) => Math.max(0, s - 1))} disabled={step === 0}>
            Back
          </Button>
          <div className={styles.footerRight}>
            <Button variant="ghost" onClick={() => void onSaveDraft()} loading={saving}>
              Save draft
            </Button>
            {step < STEPS.length - 1 ? (
              <Button onClick={() => setStep((s) => Math.min(STEPS.length - 1, s + 1))}>Next</Button>
            ) : (
              <>
                <Button variant="ghost" onClick={() => void onTestLaunch()} loading={launching} disabled={issues.length > 0}>
                  Test-launch (PAUSED)
                </Button>
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

function CountryPicker({ selected, onChange, placeholder }: { selected: string[]; onChange: (codes: string[]) => void; placeholder?: string }) {
  const [search, setSearch] = useState('');
  const filtered = COUNTRIES.filter((c) => c.name.toLowerCase().includes(search.toLowerCase()) || c.code.toLowerCase() === search.toLowerCase());
  return (
    <div>
      {selected.length > 0 && (
        <div className={styles.chips} style={{ marginBottom: '0.5rem' }}>
          {selected.map((code) => (
            <span key={code} className={styles.chip}>
              {countryName(code)}
              <button className={styles.chipX} onClick={() => onChange(toggle(selected, code))}>
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <input className={styles.input} placeholder={placeholder ?? 'Search countries…'} value={search} onChange={(e) => setSearch(e.target.value)} />
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

function ChipGroup<T extends string>({ options, selected, onToggle, allLabel }: { options: readonly { value: T; label: string }[]; selected: T[]; onToggle: (v: T) => void; allLabel?: string }) {
  return (
    <div className={styles.toggle}>
      {allLabel && (
        <span className={`${styles.toggleBtn} ${selected.length === 0 ? styles.toggleOn : ''}`} style={{ opacity: 0.85 }}>
          {allLabel}
        </span>
      )}
      {options.map((o) => (
        <button key={o.value} className={`${styles.toggleBtn} ${selected.includes(o.value) ? styles.toggleOn : ''}`} onClick={() => onToggle(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ---- Steps -----------------------------------------------------------------

function OfferStep({
  form,
  patch,
  accounts,
  pages,
  offers,
  setOffers,
  offerDomains,
  readOnly,
}: {
  form: CampaignForm;
  patch: (p: Partial<CampaignForm>) => void;
  accounts: FbAccount[];
  pages: FbPage[];
  offers: OfferDraft[];
  setOffers: (updater: (o: OfferDraft[]) => OfferDraft[]) => void;
  offerDomains: OfferDomainOption[];
  readOnly: boolean;
}) {
  const [keywordDraft, setKeywordDraft] = useState('');
  const setOfferRow = (i: number, p: Partial<OfferDraft>): void => setOffers((rows) => rows.map((r, idx) => (idx === i ? { ...r, ...p } : r)));
  const addOfferRow = (): void => setOffers((rows) => [...rows, { domainId: '', weightPct: 0, kind: 'PAID' }]);
  const removeOfferRow = (i: number): void => setOffers((rows) => (rows.length > 1 ? rows.filter((_, idx) => idx !== i) : rows));
  const paidWeight = offers.filter((o) => o.kind === 'PAID').reduce((s, o) => s + (o.weightPct || 0), 0);
  function addKeyword() {
    const k = keywordDraft.trim();
    if (k && !form.keywords.includes(k)) patch({ keywords: [...form.keywords, k] });
    setKeywordDraft('');
  }

  return (
    <div>
      {accounts.length === 0 && (
        <div className={styles.issues}>
          <div className={styles.issuesTitle}>No Facebook ad accounts found</div>
          <div style={{ fontSize: '0.83rem' }}>
            <Link href="/dashboard/facebook">Connect Facebook</Link> first to pick an ad account, page, and pixel.
          </div>
        </div>
      )}
      <div className={styles.grid}>
        <div className={`${styles.field} ${styles.full}`}>
          <label className={styles.label}>Campaign name</label>
          <input className={styles.input} value={form.name} onChange={(e) => patch({ name: e.target.value })} placeholder="e.g. Medicare Advantage — Q2" />
        </div>
        <div className={styles.field}>
          <label className={styles.label}>Objective</label>
          <select className={styles.select} value={form.objective} onChange={(e) => patch({ objective: e.target.value as CampaignForm['objective'] })}>
            {CAMPAIGN_OBJECTIVES.map((o) => (
              <option key={o} value={o}>
                {o.replace('OUTCOME_', '')}
              </option>
            ))}
          </select>
        </div>
        <div className={styles.field}>
          <label className={styles.label}>Budget optimization</label>
          <div className={styles.toggle}>
            <button className={`${styles.toggleBtn} ${form.budgetMode === 'AD_SET' ? styles.toggleOn : ''}`} onClick={() => patch({ budgetMode: 'AD_SET' })}>
              Per ad set (ABO)
            </button>
            <button className={`${styles.toggleBtn} ${form.budgetMode === 'CAMPAIGN' ? styles.toggleOn : ''}`} onClick={() => patch({ budgetMode: 'CAMPAIGN' })}>
              Campaign (CBO)
            </button>
          </div>
        </div>
        {form.budgetMode === 'CAMPAIGN' && (
          <div className={styles.field}>
            <label className={styles.label}>Campaign daily budget (USD)</label>
            <input className={styles.input} type="number" min="1" step="1" value={form.dailyBudget} onChange={(e) => patch({ dailyBudget: e.target.value })} />
          </div>
        )}
        <div className={`${styles.field} ${styles.full}`}>
          <label className={styles.label}>Special ad categories</label>
          <ChipGroup
            options={SPECIAL_AD_CATEGORIES.map((c) => ({ value: c, label: c.replace(/_/g, ' ').toLowerCase() }))}
            selected={form.specialAdCategories}
            onToggle={(v) => patch({ specialAdCategories: toggle(form.specialAdCategories, v) })}
            allLabel="None"
          />
          <span className={styles.hint}>Required by Facebook for credit / employment / housing / social-issue offers.</span>
        </div>
        <div className={styles.field}>
          <label className={styles.label}>Ad account</label>
          <SearchSelect
            value={form.adAccountId}
            onChange={(v) => patch({ adAccountId: v, pageId: '' })}
            placeholder="Search ad accounts…"
            options={accounts.map((a) => ({ value: a.id, label: a.name, sublabel: `${a.fbAccountId} · ${a.currency}` }))}
          />
        </div>
        <div className={styles.field}>
          <label className={styles.label}>Page</label>
          <SearchSelect
            value={form.pageId}
            onChange={(v) => patch({ pageId: v })}
            disabled={!form.adAccountId}
            placeholder={form.adAccountId ? 'Search pages…' : 'Pick an ad account first'}
            options={pages.map((p) => ({ value: p.id, label: p.name, sublabel: p.fbPageId }))}
            emptyText="No Pages found for this profile. Make sure your Facebook profile/Business manages a Page, then click Re-sync on the Facebook tab."
          />
        </div>
        <div className={`${styles.field} ${styles.full}`}>
          <label className={styles.label}>Destination website(s)</label>
          <span className={styles.hint}>Where the ads send traffic — the monetized article site(s). AFS revenue is attributed per site. Add one, or split traffic across several by weight.</span>
          {offerDomains.length === 0 ? (
            <div className={styles.issues} style={{ marginTop: '0.5rem' }}>
              <div style={{ fontSize: '0.83rem' }}>No websites are available to your company yet. Ask your admin to register (and share) a website under <strong>Domains</strong>; it&apos;ll then appear here.</div>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginTop: '0.4rem' }}>
              {offers.map((o, i) => (
                <div key={i} style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
                  <div style={{ flex: 2, minWidth: '14rem' }}>
                    <SearchSelect
                      value={o.domainId}
                      onChange={(v) => setOfferRow(i, { domainId: v })}
                      disabled={readOnly}
                      placeholder="Choose a website…"
                      options={offerDomains.map((d) => ({ value: d.id, label: d.host, sublabel: d.afsLabel ?? undefined }))}
                    />
                  </div>
                  <select className={styles.select} style={{ flex: 1, minWidth: '9rem' }} value={o.kind} disabled={readOnly} onChange={(e) => setOfferRow(i, { kind: e.target.value as OfferDraft['kind'] })}>
                    <option value="PAID">Paid (ad traffic)</option>
                    <option value="ORGANIC">Organic (fallback)</option>
                  </select>
                  <input
                    className={styles.input}
                    style={{ width: '6rem' }}
                    type="number"
                    min={0}
                    max={100}
                    value={o.weightPct}
                    disabled={o.kind === 'ORGANIC' || readOnly}
                    onChange={(e) => setOfferRow(i, { weightPct: Math.max(0, Math.min(100, Number(e.target.value) || 0)) })}
                    aria-label="Traffic weight %"
                  />
                  <span className={styles.hint}>%</span>
                  {offers.length > 1 && !readOnly && (
                    <button type="button" className={styles.removeBtn} onClick={() => removeOfferRow(i)}>
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
          <label className={styles.label}>RAC (Related Ad Category)</label>
          <input className={styles.input} value={form.racValue} onChange={(e) => patch({ racValue: e.target.value })} placeholder="e.g. health insurance" />
        </div>
        <div className={`${styles.field} ${styles.full}`}>
          <label className={styles.label}>Landing-page query / angle</label>
          <input className={styles.input} value={form.query} onChange={(e) => patch({ query: e.target.value })} placeholder='e.g. "Affordable health insurance plans for seniors"' />
          <span className={styles.hint}>Drives the AI article + AFS terms. Keep it short and specific.</span>
        </div>
        <div className={`${styles.field} ${styles.full}`}>
          <label className={styles.label}>Keywords</label>
          <input
            className={styles.input}
            value={keywordDraft}
            onChange={(e) => setKeywordDraft(e.target.value)}
            onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                addKeyword();
              }
            }}
            placeholder="Type a keyword and press Enter"
          />
          {form.keywords.length > 0 && (
            <div className={styles.chips}>
              {form.keywords.map((k) => (
                <span key={k} className={styles.chip}>
                  {k}
                  <button className={styles.chipX} onClick={() => patch({ keywords: form.keywords.filter((x) => x !== k) })}>
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>
        <div className={styles.field}>
          <label className={styles.label}>Campaign name template</label>
          <input className={styles.input} value={form.nameTemplate} onChange={(e) => patch({ nameTemplate: e.target.value })} placeholder="{country} - {query} - {id}" />
        </div>
        <div className={styles.field}>
          <label className={styles.label}>Ad set name template</label>
          <input className={styles.input} value={form.adsetNameTemplate} onChange={(e) => patch({ adsetNameTemplate: e.target.value })} placeholder="{country} - {age} - {id}" />
        </div>
        <div className={`${styles.field} ${styles.full}`}>
          <label className={styles.label}>Fallback URL (non-ad traffic)</label>
          <input className={styles.input} value={form.fallbackUrl} onChange={(e) => patch({ fallbackUrl: e.target.value })} placeholder="https://…" />
        </div>
      </div>
    </div>
  );
}

function AdSetsStep({
  form,
  pixels,
  patchAdSet,
  patchAd,
  setForm,
  uploadingKey,
  uploadCreative,
}: {
  form: CampaignForm;
  pixels: FbPixel[];
  patchAdSet: (key: string, p: Partial<AdSetForm>) => void;
  patchAd: (setKey: string, adKey: string, p: Partial<AdForm>) => void;
  setForm: (updater: (f: CampaignForm) => CampaignForm) => void;
  uploadingKey: string | null;
  uploadCreative: (setKey: string, ad: AdForm, file: File) => void;
}) {
  const cbo = form.budgetMode === 'CAMPAIGN';
  const hasAccount = Boolean(form.adAccountId);
  const placementsByPlatform = useMemo(() => {
    const groups: Record<string, typeof PLACEMENT_OPTIONS[number][]> = {};
    for (const p of PLACEMENT_OPTIONS) (groups[p.platform] ??= []).push(p);
    return groups;
  }, []);

  const addAdSet = () => setForm((f) => ({ ...f, adSets: [...f.adSets, emptyAdSet(f.adSets.length + 1)] }));
  const removeAdSet = (key: string) => setForm((f) => ({ ...f, adSets: f.adSets.filter((s) => s.key !== key) }));
  const addAd = (setKey: string) => setForm((f) => ({ ...f, adSets: f.adSets.map((s) => (s.key === setKey ? { ...s, ads: [...s.ads, emptyAd()] } : s)) }));
  const removeAd = (setKey: string, adKey: string) =>
    setForm((f) => ({ ...f, adSets: f.adSets.map((s) => (s.key === setKey ? { ...s, ads: s.ads.filter((a) => a.key !== adKey) } : s)) }));

  return (
    <div>
      {form.adSets.map((set, i) => (
        <div key={set.key} className={styles.adset}>
          <div className={styles.adsetHead}>
            <span className={styles.adsetTitle}>Ad set {i + 1}</span>
            {form.adSets.length > 1 && (
              <button className={styles.removeBtn} onClick={() => removeAdSet(set.key)}>
                Remove ad set
              </button>
            )}
          </div>

          <div className={styles.grid}>
            <div className={styles.field}>
              <label className={styles.label}>Name</label>
              <input className={styles.input} value={set.name} onChange={(e) => patchAdSet(set.key, { name: e.target.value })} />
            </div>
            {!cbo && (
              <div className={styles.field}>
                <label className={styles.label}>Daily budget (USD)</label>
                <input className={styles.input} type="number" min="1" step="1" value={set.dailyBudget} onChange={(e) => patchAdSet(set.key, { dailyBudget: e.target.value })} />
              </div>
            )}
          </div>

          {/* Audience */}
          <div className={styles.section}>
            <div className={styles.sectionHead}>
              <h3 className={styles.sectionTitle}>Audience</h3>
            </div>
            <div className={styles.field}>
              <label className={styles.label}>Countries</label>
              <CountryPicker selected={set.countries} onChange={(codes) => patchAdSet(set.key, { countries: codes })} />
            </div>
            <div className={styles.field} style={{ marginTop: '1rem' }}>
              <label className={styles.label}>Exclude countries</label>
              <CountryPicker selected={set.excludeCountries} onChange={(codes) => patchAdSet(set.key, { excludeCountries: codes })} placeholder="Search countries to exclude…" />
            </div>
            <div className={styles.grid} style={{ marginTop: '1rem' }}>
              <div className={styles.field}>
                <label className={styles.label}>Age min</label>
                <input className={styles.input} type="number" min={AGE_BOUND_MIN} max={AGE_BOUND_MAX} value={set.ageMin} onChange={(e) => patchAdSet(set.key, { ageMin: Number(e.target.value) })} />
              </div>
              <div className={styles.field}>
                <label className={styles.label}>Age max</label>
                <input className={styles.input} type="number" min={AGE_BOUND_MIN} max={AGE_BOUND_MAX} value={set.ageMax} onChange={(e) => patchAdSet(set.key, { ageMax: Number(e.target.value) })} />
              </div>
              <div className={styles.field}>
                <label className={styles.label}>Gender</label>
                <ChipGroup options={GENDERS.map((g) => ({ value: g, label: g[0]!.toUpperCase() + g.slice(1) }))} selected={set.genders} onToggle={(g) => patchAdSet(set.key, { genders: toggle(set.genders, g) })} allLabel="All" />
              </div>
              <div className={styles.field}>
                <label className={styles.label}>Devices</label>
                <ChipGroup options={DEVICE_PLATFORMS.map((d) => ({ value: d, label: d[0]!.toUpperCase() + d.slice(1) }))} selected={set.devicePlatforms} onToggle={(d) => patchAdSet(set.key, { devicePlatforms: toggle(set.devicePlatforms, d) })} allLabel="All" />
              </div>
              <div className={styles.field}>
                <label className={styles.label}>Mobile OS</label>
                <ChipGroup options={MOBILE_OS.map((o) => ({ value: o, label: o === 'ios' ? 'iOS' : 'Android' }))} selected={set.mobileOs} onToggle={(o) => patchAdSet(set.key, { mobileOs: toggle(set.mobileOs, o) })} allLabel="All" />
              </div>
              <div className={styles.field}>
                <label className={styles.label}>Advantage+ audience</label>
                <div className={styles.toggle}>
                  <button className={`${styles.toggleBtn} ${set.advantageAudience ? styles.toggleOn : ''}`} onClick={() => patchAdSet(set.key, { advantageAudience: !set.advantageAudience })}>
                    {set.advantageAudience ? 'On' : 'Off'}
                  </button>
                </div>
              </div>
              <div className={`${styles.field} ${styles.full}`}>
                <label className={styles.label}>Languages</label>
                <ChipGroup options={LANGUAGES.map((l) => ({ value: l.code, label: l.name }))} selected={set.languages} onToggle={(c) => patchAdSet(set.key, { languages: toggle(set.languages, c) })} allLabel="All" />
              </div>
            </div>
          </div>

          {/* Placements */}
          <div className={styles.section}>
            <div className={styles.sectionHead}>
              <h3 className={styles.sectionTitle}>Placements</h3>
            </div>
            <div className={styles.toggle}>
              <button className={`${styles.toggleBtn} ${set.placementMode === 'automatic' ? styles.toggleOn : ''}`} onClick={() => patchAdSet(set.key, { placementMode: 'automatic' })}>
                Automatic
              </button>
              <button className={`${styles.toggleBtn} ${set.placementMode === 'manual' ? styles.toggleOn : ''}`} onClick={() => patchAdSet(set.key, { placementMode: 'manual' })}>
                Manual
              </button>
            </div>
            {set.placementMode === 'manual' &&
              Object.entries(placementsByPlatform).map(([platform, opts]) => (
                <div key={platform} style={{ marginTop: '0.7rem' }}>
                  <span className={styles.metaLabel}>{platform}</span>
                  <div className={styles.toggle} style={{ marginTop: '0.3rem' }}>
                    {opts.map((o) => (
                      <button key={o.key} className={`${styles.toggleBtn} ${set.placements.includes(o.key) ? styles.toggleOn : ''}`} onClick={() => patchAdSet(set.key, { placements: toggle(set.placements, o.key) })}>
                        {o.label}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
          </div>

          {/* Conversion tracking */}
          <div className={styles.section}>
            <div className={styles.sectionHead}>
              <h3 className={styles.sectionTitle}>Conversion tracking</h3>
            </div>
            <div className={styles.grid}>
              <div className={styles.field}>
                <label className={styles.label}>Pixel</label>
                <select className={styles.select} value={set.pixelId ?? ''} onChange={(e) => patchAdSet(set.key, { pixelId: e.target.value || undefined })} disabled={!hasAccount}>
                  <option value="">{hasAccount ? 'Select a pixel…' : 'Pick an ad account first'}</option>
                  {pixels.map((px) => (
                    <option key={px.id} value={px.id}>
                      {px.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className={styles.field}>
                <label className={styles.label}>Conversion event (pxe)</label>
                <select className={styles.select} value={set.pxeEvent} onChange={(e) => patchAdSet(set.key, { pxeEvent: e.target.value as PxeEvent })}>
                  {PXE_EVENTS.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
              </div>
              <div className={styles.field}>
                <label className={styles.label}>Conversion reporting</label>
                <div className={styles.toggle}>
                  {CONVERSION_TYPES.map((c) => (
                    <button key={c} className={`${styles.toggleBtn} ${set.conversionType === c ? styles.toggleOn : ''}`} onClick={() => patchAdSet(set.key, { conversionType: c })}>
                      {c[0]!.toUpperCase() + c.slice(1)}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>

          {/* Optimization & schedule */}
          <div className={styles.section}>
            <div className={styles.sectionHead}>
              <h3 className={styles.sectionTitle}>Optimization & schedule</h3>
            </div>
            <div className={styles.grid}>
              <div className={styles.field}>
                <label className={styles.label}>Bid strategy</label>
                <select className={styles.select} value={set.bidStrategy} onChange={(e) => patchAdSet(set.key, { bidStrategy: e.target.value as BidStrategy | '' })}>
                  <option value="">Highest volume (default)</option>
                  {BID_STRATEGIES.map((b) => (
                    <option key={b} value={b}>
                      {b.replace(/_/g, ' ').toLowerCase()}
                    </option>
                  ))}
                </select>
              </div>
              <div className={styles.field}>
                <label className={styles.label}>Cost cap (USD, optional)</label>
                <input className={styles.input} type="number" min="0" step="0.01" value={set.costCap} onChange={(e) => patchAdSet(set.key, { costCap: e.target.value })} />
              </div>
              <div className={styles.field}>
                <label className={styles.label}>ROAS factor (optional)</label>
                <input className={styles.input} type="number" min="0" step="0.1" value={set.roasFactor} onChange={(e) => patchAdSet(set.key, { roasFactor: e.target.value })} />
              </div>
              <div className={styles.field}>
                <label className={styles.label}>Attribution window</label>
                <select className={styles.select} value={set.attributionWindow} onChange={(e) => patchAdSet(set.key, { attributionWindow: e.target.value as AttributionWindow | '' })}>
                  <option value="">Default</option>
                  {ATTRIBUTION_WINDOWS.map((w) => (
                    <option key={w} value={w}>
                      {w.replace(/_/g, ' ')}
                    </option>
                  ))}
                </select>
              </div>
              <div className={styles.field}>
                <label className={styles.label}>Start (optional)</label>
                <input className={styles.input} type="datetime-local" value={set.startTime} onChange={(e) => patchAdSet(set.key, { startTime: e.target.value })} />
              </div>
              <div className={styles.field}>
                <label className={styles.label}>End (optional)</label>
                <input className={styles.input} type="datetime-local" value={set.endTime} onChange={(e) => patchAdSet(set.key, { endTime: e.target.value })} />
              </div>
            </div>
          </div>

          {/* Ads */}
          <div className={styles.section}>
            <div className={styles.sectionHead}>
              <h3 className={styles.sectionTitle}>Ads</h3>
              <span className={styles.count}>{set.ads.length}</span>
            </div>
            {set.ads.map((ad, j) => (
              <div key={ad.key} className={styles.ad}>
                <div className={styles.adHead}>
                  <span className={styles.adLabel}>
                    AD {i + 1}.{j + 1}
                  </span>
                  {set.ads.length > 1 && (
                    <button className={styles.removeBtn} onClick={() => removeAd(set.key, ad.key)}>
                      Remove
                    </button>
                  )}
                </div>
                <div className={styles.grid}>
                  <div className={styles.field}>
                    <label className={styles.label}>Ad name</label>
                    <input className={styles.input} value={ad.name} onChange={(e) => patchAd(set.key, ad.key, { name: e.target.value })} />
                  </div>
                  <div className={styles.field}>
                    <label className={styles.label}>Headline</label>
                    <input className={styles.input} value={ad.headline} onChange={(e) => patchAd(set.key, ad.key, { headline: e.target.value })} />
                  </div>
                  <div className={`${styles.field} ${styles.full}`}>
                    <label className={styles.label}>Primary text</label>
                    <textarea className={styles.textarea} value={ad.primaryText} onChange={(e) => patchAd(set.key, ad.key, { primaryText: e.target.value })} />
                  </div>
                  <div className={styles.field}>
                    <label className={styles.label}>Call to action</label>
                    <select className={styles.select} value={ad.cta} onChange={(e) => patchAd(set.key, ad.key, { cta: e.target.value as CtaOption })}>
                      {CTA_OPTIONS.map((c) => (
                        <option key={c} value={c}>
                          {c.replace(/_/g, ' ')}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className={`${styles.field} ${styles.full}`}>
                    <label className={styles.label}>Creative</label>
                    <div className={styles.creative}>
                      {ad.previewUrl && <img className={styles.thumb} src={ad.previewUrl} alt="creative preview" />}
                      <label className={styles.removeBtn} style={{ cursor: 'pointer' }}>
                        {uploadingKey === ad.key ? 'Uploading…' : ad.uploadId ? 'Replace' : 'Upload image / video'}
                        <input
                          type="file"
                          accept="image/*,video/mp4,video/quicktime"
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
              </div>
            ))}
            <div style={{ marginTop: '0.75rem' }}>
              <button className={styles.addBtn} onClick={() => addAd(set.key)}>
                + Add ad
              </button>
            </div>
          </div>
        </div>
      ))}

      <button className={styles.addBtn} onClick={addAdSet}>
        + Add ad set
      </button>
    </div>
  );
}

function ReviewStep({ form, accounts, pages, issues }: { form: CampaignForm; accounts: FbAccount[]; pages: FbPage[]; issues: string[] }) {
  const account = accounts.find((a) => a.id === form.adAccountId);
  const page = pages.find((p) => p.id === form.pageId);
  const totalAds = form.adSets.reduce((n, s) => n + s.ads.length, 0);
  const budget = form.budgetMode === 'CAMPAIGN' ? centsOrUndef(form.dailyBudget) ?? 0 : form.adSets.reduce((n, s) => n + (centsOrUndef(s.dailyBudget) ?? 0), 0);

  return (
    <div>
      {issues.length > 0 && (
        <div className={styles.issues}>
          <div className={styles.issuesTitle}>Before you can submit:</div>
          <ul className={styles.issuesList}>
            {issues.map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
        </div>
      )}
      <div className={styles.summary}>
        <div className={styles.summaryRow}>
          <span className={styles.summaryKey}>Campaign</span>
          <span className={styles.summaryVal}>{form.name || '—'}</span>
        </div>
        <div className={styles.summaryRow}>
          <span className={styles.summaryKey}>Objective · budget</span>
          <span className={styles.summaryVal}>
            {form.objective.replace('OUTCOME_', '')} · {form.budgetMode === 'CAMPAIGN' ? 'CBO' : 'ABO'}
          </span>
        </div>
        {form.specialAdCategories.length > 0 && (
          <div className={styles.summaryRow}>
            <span className={styles.summaryKey}>Special ad categories</span>
            <span className={styles.summaryVal}>{form.specialAdCategories.join(', ').toLowerCase()}</span>
          </div>
        )}
        <div className={styles.summaryRow}>
          <span className={styles.summaryKey}>Ad account / Page</span>
          <span className={styles.summaryVal}>
            {account?.name ?? '—'} · {page?.name ?? '—'}
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
