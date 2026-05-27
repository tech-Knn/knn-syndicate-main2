'use client';

import { type ChangeEvent, type KeyboardEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  AGE_BOUND_MAX,
  AGE_BOUND_MIN,
  CAMPAIGN_OBJECTIVES,
  COUNTRIES,
  CTA_OPTIONS,
  GENDERS,
  PLACEMENT_PLATFORMS,
  PXE_EVENTS,
  type CampaignDraftInput,
  type CreativeType,
  type CtaOption,
  type Gender,
  type PlacementMode,
  type PlacementPlatform,
  type PxeEvent,
  campaignDraftSchema,
  campaignSubmitIssues,
  countryName,
} from '@knn/shared';
import { ApiError, campaigns as campaignsApi, facebook, uploads as uploadsApi } from '@/lib/api';
import { type Campaign, type FbAccount, type FbPage, type FbPixel } from '@/lib/types';
import { Button, Card, Spinner } from './ui';
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
  ageMin: number;
  ageMax: number;
  genders: Gender[];
  placementMode: PlacementMode;
  placements: PlacementPlatform[];
  pixelId?: string;
  pxeEvent: PxeEvent;
  ads: AdForm[];
}

interface CampaignForm {
  name: string;
  objective: (typeof CAMPAIGN_OBJECTIVES)[number];
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

function emptyAd(): AdForm {
  return {
    key: uuid(),
    name: '',
    headline: '',
    primaryText: '',
    description: '',
    cta: 'LEARN_MORE',
    creativeType: 'IMAGE',
    fallbackUrl: '',
    beneficiary: '',
  };
}

function emptyAdSet(n: number): AdSetForm {
  return {
    key: uuid(),
    name: `Ad set ${n}`,
    dailyBudget: '50',
    countries: [],
    ageMin: 18,
    ageMax: AGE_BOUND_MAX,
    genders: [],
    placementMode: 'automatic',
    placements: [],
    pxeEvent: 'search',
    ads: [emptyAd()],
  };
}

function toForm(c?: Campaign): CampaignForm {
  if (!c) {
    return {
      name: '',
      objective: 'OUTCOME_SALES',
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
      ageMin: s.ageMin,
      ageMax: s.ageMax,
      genders: (s.genders as Gender[]) ?? [],
      placementMode: (s.placementMode as PlacementMode) ?? 'automatic',
      placements: (s.placements as PlacementPlatform[]) ?? [],
      pixelId: s.pixelId ?? undefined,
      pxeEvent: (s.pxeEvent as PxeEvent) ?? 'search',
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
      ageMin: s.ageMin,
      ageMax: s.ageMax,
      genders: s.genders,
      placementMode: s.placementMode,
      placements: s.placementMode === 'manual' ? s.placements : [],
      pixelId: s.pixelId || undefined,
      pxeEvent: s.pxeEvent,
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

/** Hard fields the API's draft schema needs on present entities (clear messages, no raw 400s). */
function localErrors(form: CampaignForm): string[] {
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

  const [saving, setSaving] = useState(false);
  const [submitting, setSubmitting] = useState(false);
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
    (key: string, p: Partial<AdSetForm>) =>
      setForm((f) => ({ ...f, adSets: f.adSets.map((s) => (s.key === key ? { ...s, ...p } : s)) })),
    [],
  );
  const patchAd = useCallback(
    (setKey: string, adKey: string, p: Partial<AdForm>) =>
      setForm((f) => ({
        ...f,
        adSets: f.adSets.map((s) =>
          s.key === setKey ? { ...s, ads: s.ads.map((a) => (a.key === adKey ? { ...a, ...p } : a)) } : s,
        ),
      })),
    [],
  );

  const clientIssues = useMemo(() => {
    const parsed = campaignDraftSchema.safeParse(toDraft(form));
    if (!parsed.success) return ['Some fields still need fixing (see earlier steps).'];
    return campaignSubmitIssues(parsed.data);
  }, [form]);

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
    const errs = localErrors(form);
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
      if (err instanceof ApiError && err.status === 422 && Array.isArray(err.details)) {
        setServerIssues(err.details as string[]);
      } else {
        setBannerError(err instanceof ApiError ? err.message : 'Could not submit.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className={styles.wrap}>
      <div className={styles.head}>
        <div>
          <h1 className={`serif ${styles.title}`}>
            {readOnly ? campaign?.name : campaign ? 'Edit campaign' : 'New campaign'}
          </h1>
          <p className={styles.subtitle}>
            {readOnly
              ? 'This campaign has been submitted and is read-only.'
              : 'Campaign → ad sets (audience, budget, pixel) → ads (creatives).'}
          </p>
        </div>
        <Link href="/dashboard/campaigns" className={styles.removeBtn} style={{ alignSelf: 'center' }}>
          Back to campaigns
        </Link>
      </div>

      {!readOnly && (
        <div className={styles.steps}>
          {STEPS.map((label, i) => (
            <div
              key={label}
              className={`${styles.step} ${i === step ? styles.stepActive : i < step ? styles.stepDone : ''}`}
              onClick={() => setStep(i)}
              role="button"
            >
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
          <OfferStep form={form} patch={patch} accounts={accounts} pages={pages} />
        ) : step === 1 ? (
          <AdSetsStep
            form={form}
            pixels={pixels}
            patchAdSet={patchAdSet}
            patchAd={patchAd}
            setForm={setForm}
            uploadingKey={uploadingKey}
            uploadCreative={uploadCreative}
          />
        ) : (
          <ReviewStep form={form} accounts={accounts} pages={pages} issues={[...serverIssues, ...clientIssues]} />
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
              <Button onClick={() => void onSubmit()} loading={submitting} disabled={clientIssues.length > 0}>
                Submit for approval
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ---- Country picker --------------------------------------------------------

function CountryPicker({ selected, onChange }: { selected: string[]; onChange: (codes: string[]) => void }) {
  const [search, setSearch] = useState('');
  const filtered = COUNTRIES.filter(
    (c) =>
      c.name.toLowerCase().includes(search.toLowerCase()) ||
      c.code.toLowerCase() === search.toLowerCase(),
  );
  const toggle = (code: string) =>
    onChange(selected.includes(code) ? selected.filter((x) => x !== code) : [...selected, code]);

  return (
    <div>
      {selected.length > 0 && (
        <div className={styles.chips} style={{ marginBottom: '0.5rem' }}>
          {selected.map((code) => (
            <span key={code} className={styles.chip}>
              {countryName(code)}
              <button className={styles.chipX} onClick={() => toggle(code)}>
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <input
        className={styles.input}
        placeholder="Search countries…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      <div className={styles.countryList}>
        {filtered.map((c) => (
          <label key={c.code} className={styles.countryItem}>
            <input type="checkbox" checked={selected.includes(c.code)} onChange={() => toggle(c.code)} />
            {c.name}
          </label>
        ))}
        {filtered.length === 0 && <span className={styles.hint}>No match.</span>}
      </div>
    </div>
  );
}

// ---- Steps -----------------------------------------------------------------

function OfferStep({
  form,
  patch,
  accounts,
  pages,
}: {
  form: CampaignForm;
  patch: (p: Partial<CampaignForm>) => void;
  accounts: FbAccount[];
  pages: FbPage[];
}) {
  const [keywordDraft, setKeywordDraft] = useState('');
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
            <button
              className={`${styles.toggleBtn} ${form.budgetMode === 'AD_SET' ? styles.toggleOn : ''}`}
              onClick={() => patch({ budgetMode: 'AD_SET' })}
            >
              Per ad set (ABO)
            </button>
            <button
              className={`${styles.toggleBtn} ${form.budgetMode === 'CAMPAIGN' ? styles.toggleOn : ''}`}
              onClick={() => patch({ budgetMode: 'CAMPAIGN' })}
            >
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
        <div className={styles.field}>
          <label className={styles.label}>Ad account</label>
          <select className={styles.select} value={form.adAccountId} onChange={(e) => patch({ adAccountId: e.target.value, pageId: '' })}>
            <option value="">Select an ad account…</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} ({a.currency})
              </option>
            ))}
          </select>
        </div>
        <div className={styles.field}>
          <label className={styles.label}>Page</label>
          <select className={styles.select} value={form.pageId} onChange={(e) => patch({ pageId: e.target.value })} disabled={!form.adAccountId}>
            <option value="">{form.adAccountId ? 'Select a page…' : 'Pick an ad account first'}</option>
            {pages.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
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

  const addAdSet = () => setForm((f) => ({ ...f, adSets: [...f.adSets, emptyAdSet(f.adSets.length + 1)] }));
  const removeAdSet = (key: string) => setForm((f) => ({ ...f, adSets: f.adSets.filter((s) => s.key !== key) }));
  const addAd = (setKey: string) =>
    setForm((f) => ({ ...f, adSets: f.adSets.map((s) => (s.key === setKey ? { ...s, ads: [...s.ads, emptyAd()] } : s)) }));
  const removeAd = (setKey: string, adKey: string) =>
    setForm((f) => ({
      ...f,
      adSets: f.adSets.map((s) => (s.key === setKey ? { ...s, ads: s.ads.filter((a) => a.key !== adKey) } : s)),
    }));

  return (
    <div>
      {form.adSets.map((set, i) => {
        const toggleGender = (g: Gender) =>
          patchAdSet(set.key, {
            genders: set.genders.includes(g) ? set.genders.filter((x) => x !== g) : [...set.genders, g],
          });
        const togglePlacement = (p: PlacementPlatform) =>
          patchAdSet(set.key, {
            placements: set.placements.includes(p) ? set.placements.filter((x) => x !== p) : [...set.placements, p],
          });
        return (
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
              <div className={styles.grid} style={{ marginTop: '1rem' }}>
                <div className={styles.field}>
                  <label className={styles.label}>Age min</label>
                  <input className={styles.input} type="number" min={AGE_BOUND_MIN} max={AGE_BOUND_MAX} value={set.ageMin} onChange={(e) => patchAdSet(set.key, { ageMin: Number(e.target.value) })} />
                </div>
                <div className={styles.field}>
                  <label className={styles.label}>Age max</label>
                  <input className={styles.input} type="number" min={AGE_BOUND_MIN} max={AGE_BOUND_MAX} value={set.ageMax} onChange={(e) => patchAdSet(set.key, { ageMax: Number(e.target.value) })} />
                </div>
                <div className={`${styles.field} ${styles.full}`}>
                  <label className={styles.label}>Gender</label>
                  <div className={styles.toggle}>
                    <button className={`${styles.toggleBtn} ${set.genders.length === 0 ? styles.toggleOn : ''}`} onClick={() => patchAdSet(set.key, { genders: [] })}>
                      All
                    </button>
                    {GENDERS.map((g) => (
                      <button key={g} className={`${styles.toggleBtn} ${set.genders.includes(g) ? styles.toggleOn : ''}`} onClick={() => toggleGender(g)}>
                        {g[0]?.toUpperCase()}
                        {g.slice(1)}
                      </button>
                    ))}
                  </div>
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
              {set.placementMode === 'manual' && (
                <div className={styles.chips} style={{ marginTop: '0.6rem' }}>
                  {PLACEMENT_PLATFORMS.map((p) => (
                    <button key={p} className={`${styles.toggleBtn} ${set.placements.includes(p) ? styles.toggleOn : ''}`} onClick={() => togglePlacement(p)}>
                      {p.replace(/_/g, ' ')}
                    </button>
                  ))}
                </div>
              )}
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
        );
      })}

      <button className={styles.addBtn} onClick={addAdSet}>
        + Add ad set
      </button>
    </div>
  );
}

function ReviewStep({
  form,
  accounts,
  pages,
  issues,
}: {
  form: CampaignForm;
  accounts: FbAccount[];
  pages: FbPage[];
  issues: string[];
}) {
  const account = accounts.find((a) => a.id === form.adAccountId);
  const page = pages.find((p) => p.id === form.pageId);
  const totalAds = form.adSets.reduce((n, s) => n + s.ads.length, 0);
  const budget =
    form.budgetMode === 'CAMPAIGN'
      ? centsOrUndef(form.dailyBudget) ?? 0
      : form.adSets.reduce((n, s) => n + (centsOrUndef(s.dailyBudget) ?? 0), 0);

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
            <span className={styles.summaryKey}>Ad set {i + 1} targeting</span>
            <span className={styles.summaryVal}>
              {s.countries.length > 0 ? s.countries.join(', ') : 'no countries'} · {s.ageMin}–{s.ageMax} ·{' '}
              {s.genders.length === 0 ? 'all' : s.genders.join('/')}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
