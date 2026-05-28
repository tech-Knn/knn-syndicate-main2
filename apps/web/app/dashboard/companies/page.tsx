'use client';

import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { type CompanyRollup, addBusinessDays, currentBusinessDay, formatUsd } from '@knn/shared';
import { Badge, Button, Card, Segmented, Skeleton } from '@/components/ui';
import { admin, stats } from '@/lib/api';
import { type AuditRow, type OrgRow, type PublicUser } from '@/lib/types';
import { useAuth } from '../../providers';
import styles from '../admin.module.css';

const blank = { name: '', slug: '', adminName: '', adminEmail: '', adminPassword: '' };

const RANGE_DAYS: Record<string, number> = { '7': 7, '30': 30, '90': 90 };
function rangeFor(days: number): { from: string; to: string } {
  const to = currentBusinessDay();
  return { from: addBusinessDays(to, -(days - 1)), to };
}

const ROLE_LABEL: Record<string, string> = { SUPER_ADMIN: 'Platform', COMPANY_ADMIN: 'Admin', MEDIA_BUYER: 'Buyer' };
const STATUS_TONE: Record<string, 'neutral' | 'success' | 'warning' | 'danger'> = {
  ACTIVE: 'success',
  PENDING: 'warning',
  SUSPENDED: 'neutral',
  REJECTED: 'danger',
};

// Human-readable labels for the activity log.
const ACTION_LABEL: Record<string, string> = {
  'org.created': 'Company created',
  'org.user.added': 'User added',
  'user.deleted': 'User removed',
  'user.approve': 'User approved',
  'user.reject': 'User rejected',
  'user.suspend': 'User suspended',
  'user.reactivate': 'User reactivated',
  'org.auto_approve.enabled': 'Auto-approve on',
  'org.auto_approve.disabled': 'Auto-approve off',
  'org.auto_launch.enabled': 'Auto-launch on',
  'org.auto_launch.disabled': 'Auto-launch off',
};
function actionLabel(a: string): string {
  return ACTION_LABEL[a] ?? a.replace(/[._]/g, ' ');
}
function auditDetail(e: AuditRow): string {
  const d = (e.details ?? {}) as Record<string, unknown>;
  const email = typeof d.email === 'string' ? d.email : null;
  const role = typeof d.role === 'string' ? d.role : null;
  if (email && role) return `${email} (${ROLE_LABEL[role] ?? role})`;
  if (email) return email;
  if (typeof d.slug === 'string') return String(d.slug);
  return '';
}
function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.round(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return new Date(iso).toLocaleDateString();
}

export default function CompaniesPage() {
  const { user } = useAuth();
  const router = useRouter();
  const [orgs, setOrgs] = useState<OrgRow[] | null>(null);
  const [form, setForm] = useState(blank);
  const [creating, setCreating] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // Expandable per-company member lists.
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [membersByOrg, setMembersByOrg] = useState<Record<string, PublicUser[] | null>>({});

  // Revenue by company + cut editing.
  const [rangeKey, setRangeKey] = useState('30');
  const [revenue, setRevenue] = useState<CompanyRollup[] | null>(null);
  const [cuts, setCuts] = useState<Record<string, string>>({});
  const [cutState, setCutState] = useState<Record<string, 'saving' | 'saved' | undefined>>({});

  // Activity log.
  const [audit, setAudit] = useState<AuditRow[] | null>(null);

  useEffect(() => {
    if (user && user.role !== 'SUPER_ADMIN') router.replace('/dashboard');
  }, [user, router]);

  const load = useCallback(() => {
    void admin.organizations().then(setOrgs).catch(() => setOrgs([]));
  }, []);
  useEffect(() => load(), [load]);

  const loadAudit = useCallback(() => {
    void admin.audit({ limit: 60 }).then(setAudit).catch(() => setAudit([]));
  }, []);
  useEffect(() => loadAudit(), [loadAudit]);

  const loadRevenue = useCallback((key: string) => {
    setRevenue(null);
    void stats
      .byCompany(rangeFor(RANGE_DAYS[key] ?? 30))
      .then((rows) => {
        setRevenue(rows);
        setCuts(Object.fromEntries(rows.map((c) => [c.orgId, String(Math.round(c.defaultRevenueCutPct * 100))])));
      })
      .catch(() => setRevenue([]));
  }, []);
  useEffect(() => loadRevenue(rangeKey), [rangeKey, loadRevenue]);

  // Auto-derive a slug from the company name as the user types (still editable).
  const onName = (name: string): void =>
    setForm((f) => ({
      ...f,
      name,
      slug: f.slug === '' || f.slug === slugify(f.name) ? slugify(name) : f.slug,
    }));

  const create = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    setCreating(true);
    setNote(null);
    try {
      await admin.createOrganization({
        name: form.name.trim(),
        slug: form.slug.trim(),
        adminName: form.adminName.trim(),
        adminEmail: form.adminEmail.trim(),
        adminPassword: form.adminPassword,
      });
      setNote(`Company “${form.name.trim()}” created. Its admin (${form.adminEmail.trim()}) can sign in now; buyers sign up with slug “${form.slug.trim()}”.`);
      setForm(blank);
      load();
      loadAudit();
    } catch (err) {
      setNote(err instanceof Error ? err.message : 'Could not create company');
    } finally {
      setCreating(false);
    }
  };

  const toggle = async (o: OrgRow, key: 'autoApprove' | 'autoLaunch'): Promise<void> => {
    setBusy(o.id + key);
    try {
      if (key === 'autoApprove') await admin.setAutoApprove(o.id, !o.autoApprove);
      else await admin.setAutoLaunch(o.id, !o.autoLaunch);
      load();
      loadAudit();
    } catch (err) {
      setNote(err instanceof Error ? err.message : 'Could not update');
    } finally {
      setBusy(null);
    }
  };

  const loadMembers = useCallback((orgId: string) => {
    setMembersByOrg((m) => ({ ...m, [orgId]: m[orgId] ?? null }));
    void admin
      .orgUsers(orgId)
      .then((u) => setMembersByOrg((m) => ({ ...m, [orgId]: u })))
      .catch(() => setMembersByOrg((m) => ({ ...m, [orgId]: [] })));
  }, []);

  const toggleExpand = (orgId: string): void => {
    setExpanded((e) => {
      const next = { ...e, [orgId]: !e[orgId] };
      if (next[orgId] && membersByOrg[orgId] === undefined) loadMembers(orgId);
      return next;
    });
  };

  const removeMember = async (orgId: string, m: PublicUser): Promise<void> => {
    if (!window.confirm(`Permanently delete ${m.name} (${m.email})? This frees their email to re-use.`)) return;
    setBusy(m.id);
    try {
      await admin.deleteUser(m.id);
      loadMembers(orgId);
      load();
      loadAudit();
    } finally {
      setBusy(null);
    }
  };

  const saveCut = async (orgId: string): Promise<void> => {
    const pct = Number(cuts[orgId]);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) return;
    setCutState((s) => ({ ...s, [orgId]: 'saving' }));
    try {
      await admin.setRevenueCut(orgId, pct / 100);
      setCutState((s) => ({ ...s, [orgId]: 'saved' }));
      setTimeout(() => setCutState((s) => ({ ...s, [orgId]: undefined })), 2000);
    } catch {
      setCutState((s) => ({ ...s, [orgId]: undefined }));
    }
  };

  // Add an admin/buyer to an existing company.
  const [addTo, setAddTo] = useState<OrgRow | null>(null);
  const [userForm, setUserForm] = useState({ name: '', email: '', password: '', role: 'COMPANY_ADMIN' as 'COMPANY_ADMIN' | 'MEDIA_BUYER' });
  const [addingUser, setAddingUser] = useState(false);

  const openAddUser = (o: OrgRow): void => {
    setAddTo(o);
    setUserForm({ name: '', email: '', password: '', role: 'COMPANY_ADMIN' });
    setNote(null);
  };

  const addUser = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (!addTo) return;
    setAddingUser(true);
    setNote(null);
    try {
      await admin.addOrgUser(addTo.id, { name: userForm.name.trim(), email: userForm.email.trim(), password: userForm.password, role: userForm.role });
      setNote(`Added ${userForm.role === 'COMPANY_ADMIN' ? 'admin' : 'buyer'} ${userForm.email.trim()} to ${addTo.name} (active — they can sign in now).`);
      const orgId = addTo.id;
      setAddTo(null);
      load();
      loadAudit();
      if (expanded[orgId]) loadMembers(orgId);
    } catch (err) {
      setNote(err instanceof Error ? err.message : 'Could not add the user');
    } finally {
      setAddingUser(false);
    }
  };

  const canCreate = form.name.trim() && /^[a-z0-9-]+$/.test(form.slug.trim()) && form.adminName.trim() && form.adminEmail.trim() && form.adminPassword.length >= 8;

  return (
    <div className={styles.page}>
      <div className={styles.head}>
        <div>
          <span className="eyebrow">Platform</span>
          <h1 className={`serif ${styles.title}`}>Companies</h1>
          <p className={styles.sub}>Create client companies, manage their members &amp; revenue cut, and review platform activity.</p>
        </div>
      </div>

      {note && <Card className={styles.section}>{note}</Card>}

      {/* Create company */}
      <Card className={styles.section}>
        <div className={styles.sectionHead}>
          <span className={styles.sectionTitle}>Add a company</span>
          <span className={styles.subtle}>Creates the org + its first admin (active). Share the admin login with them.</span>
        </div>
        <form className={styles.domainForm} onSubmit={(e) => void create(e)}>
          <input className={styles.rangeInput} placeholder="Company name" value={form.name} onChange={(e) => onName(e.target.value)} />
          <input className={styles.rangeInput} placeholder="slug (lowercase-hyphens)" value={form.slug} onChange={(e) => setForm({ ...form, slug: e.target.value })} />
          <input className={styles.rangeInput} placeholder="admin name" value={form.adminName} onChange={(e) => setForm({ ...form, adminName: e.target.value })} />
          <input className={styles.rangeInput} type="email" placeholder="admin email" value={form.adminEmail} onChange={(e) => setForm({ ...form, adminEmail: e.target.value })} />
          <input className={styles.rangeInput} type="password" placeholder="admin password (8+)" value={form.adminPassword} onChange={(e) => setForm({ ...form, adminPassword: e.target.value })} />
          <Button type="submit" loading={creating} disabled={!canCreate}>
            Create company
          </Button>
        </form>
      </Card>

      {/* Companies list */}
      <Card className={styles.section}>
        <div className={styles.sectionHead}>
          <span className={styles.sectionTitle}>Registered companies</span>
        </div>
        {!orgs ? (
          <div className={styles.rowsSkel}>
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className={styles.rowSkel} />
            ))}
          </div>
        ) : orgs.length === 0 ? (
          <p className={styles.empty}>No companies yet. Add one above.</p>
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th className={styles.thLeft}>Company</th>
                  <th className={styles.thLeft}>Signup slug</th>
                  <th>Admins</th>
                  <th>Buyers</th>
                  <th>Pending</th>
                  <th className={styles.thLeft}>Approval</th>
                  <th className={styles.thLeft}>Launch</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {orgs.map((o) => (
                  <FragmentRow key={o.id}>
                    <tr>
                      <td>
                        <button type="button" className={styles.actionBtn} onClick={() => toggleExpand(o.id)} aria-expanded={!!expanded[o.id]}>
                          {expanded[o.id] ? '▾' : '▸'} {o.name}
                        </button>
                        <div className={styles.subtle}>{o.isPlatform ? 'platform (KNN staff)' : o.status.toLowerCase()}</div>
                      </td>
                      <td className="mono">{o.slug}</td>
                      <td className={styles.num}>{o.adminCount}</td>
                      <td className={styles.num}>{o.buyerCount}</td>
                      <td className={styles.num}>{o.pendingCount > 0 ? <Badge tone="warning">{o.pendingCount}</Badge> : '—'}</td>
                      <td>
                        <button type="button" className={styles.actionBtn} disabled={busy === o.id + 'autoApprove'} onClick={() => void toggle(o, 'autoApprove')}>
                          {o.autoApprove ? 'Auto-approve' : 'Manual review'}
                        </button>
                      </td>
                      <td>
                        <button type="button" className={styles.actionBtn} disabled={busy === o.id + 'autoLaunch'} onClick={() => void toggle(o, 'autoLaunch')}>
                          {o.autoLaunch ? 'Auto-launch' : 'Manual launch'}
                        </button>
                      </td>
                      <td>
                        <div className={styles.actions}>
                          {o.isPlatform ? (
                            <span className={styles.subtle}>—</span>
                          ) : (
                            <button type="button" className={styles.actionBtn} onClick={() => openAddUser(o)}>
                              Add user
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                    {expanded[o.id] && (
                      <tr>
                        <td colSpan={8}>
                          {membersByOrg[o.id] == null ? (
                            <Skeleton className={styles.rowSkel} />
                          ) : membersByOrg[o.id]!.length === 0 ? (
                            <p className={styles.empty}>No members yet.</p>
                          ) : (
                            <table className={styles.table}>
                              <thead>
                                <tr>
                                  <th className={styles.thLeft}>Member</th>
                                  <th className={styles.thLeft}>Email</th>
                                  <th className={styles.thLeft}>Role</th>
                                  <th className={styles.thLeft}>Status</th>
                                  <th></th>
                                </tr>
                              </thead>
                              <tbody>
                                {membersByOrg[o.id]!.map((m) => (
                                  <tr key={m.id}>
                                    <td className={styles.name}>{m.name}</td>
                                    <td className="mono">{m.email}</td>
                                    <td className={styles.subtle}>{ROLE_LABEL[m.role] ?? m.role}</td>
                                    <td>
                                      <Badge tone={STATUS_TONE[m.status] ?? 'neutral'}>{m.status.toLowerCase()}</Badge>
                                    </td>
                                    <td>
                                      <button
                                        type="button"
                                        className={`${styles.actionBtn} ${styles.actionDanger}`}
                                        disabled={busy === m.id}
                                        onClick={() => void removeMember(o.id, m)}
                                      >
                                        Remove
                                      </button>
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          )}
                        </td>
                      </tr>
                    )}
                  </FragmentRow>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className={styles.fieldHint}>
          Click a company to see its members (emails, roles, status). A buyer joins at <strong>/signup</strong> with the company&apos;s{' '}
          <strong>signup slug</strong>; the admin (or super-admin) approves them on the <strong>Team</strong> page. Use <strong>Add user</strong> to
          create an admin/buyer directly — active immediately.
        </p>
      </Card>

      {/* Revenue by company + cut */}
      <Card className={styles.section}>
        <div className={styles.sectionHead}>
          <span className={styles.sectionTitle}>Revenue by company</span>
          <Segmented
            options={[
              { label: '7D', value: '7' },
              { label: '30D', value: '30' },
              { label: '90D', value: '90' },
            ]}
            value={rangeKey}
            onChange={setRangeKey}
          />
        </div>
        {!revenue ? (
          <div className={styles.rowsSkel}>
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className={styles.rowSkel} />
            ))}
          </div>
        ) : revenue.length === 0 ? (
          <p className={styles.empty}>No companies yet.</p>
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th className={styles.thLeft}>Company</th>
                  <th>Buyers</th>
                  <th>Campaigns</th>
                  <th>Spend</th>
                  <th>Revenue</th>
                  <th>Margin</th>
                  <th className={styles.thLeft}>Platform cut %</th>
                </tr>
              </thead>
              <tbody>
                {revenue.map((c) => (
                  <tr key={c.orgId}>
                    <td className={styles.name}>{c.name}</td>
                    <td className={styles.num}>{c.buyerCount}</td>
                    <td className={styles.num}>{c.campaignCount}</td>
                    <td className={styles.num}>{formatUsd(c.spendUsd)}</td>
                    <td className={styles.num}>{formatUsd(c.revenueUsd)}</td>
                    <td className={styles.num}>{formatUsd(c.marginUsd)}</td>
                    <td>
                      <div className={styles.actions}>
                        <input
                          className={styles.cutInput}
                          inputMode="numeric"
                          value={cuts[c.orgId] ?? ''}
                          onChange={(e) => setCuts((prev) => ({ ...prev, [c.orgId]: e.target.value.replace(/[^0-9]/g, '') }))}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') void saveCut(c.orgId);
                          }}
                          aria-label={`Platform revenue cut for ${c.name}`}
                        />
                        <button type="button" className={styles.actionBtn} disabled={cutState[c.orgId] === 'saving'} onClick={() => void saveCut(c.orgId)}>
                          {cutState[c.orgId] === 'saving' ? 'Saving…' : 'Save'}
                        </button>
                        {cutState[c.orgId] === 'saved' && <span className={styles.savedNote}>Saved ✓</span>}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className={styles.fieldHint}>
          The <strong>platform cut</strong> is the share of each company&apos;s AFS revenue KNN keeps; the rest is the company&apos;s margin. Set it, then{' '}
          <strong>Save</strong>.
        </p>
      </Card>

      {/* Activity log */}
      <Card className={styles.section}>
        <div className={styles.sectionHead}>
          <span className={styles.sectionTitle}>Recent activity</span>
          <button type="button" className={styles.actionBtn} onClick={() => loadAudit()}>
            Refresh
          </button>
        </div>
        {!audit ? (
          <Skeleton className={styles.rowSkel} />
        ) : audit.length === 0 ? (
          <p className={styles.empty}>No activity yet.</p>
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th className={styles.thLeft}>When</th>
                  <th className={styles.thLeft}>Action</th>
                  <th className={styles.thLeft}>Detail</th>
                  <th className={styles.thLeft}>Company</th>
                  <th className={styles.thLeft}>By</th>
                </tr>
              </thead>
              <tbody>
                {audit.map((e) => (
                  <tr key={e.id}>
                    <td className={styles.subtle}>{timeAgo(e.createdAt)}</td>
                    <td className={styles.name}>{actionLabel(e.action)}</td>
                    <td className="mono">{auditDetail(e) || '—'}</td>
                    <td className={styles.subtle}>{e.orgName ?? '—'}</td>
                    <td className={styles.subtle}>{e.actorEmail ?? 'system'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Add a user (admin/buyer) to a company */}
      {addTo && (
        <Card className={styles.section}>
          <div className={styles.sectionHead}>
            <span className={styles.sectionTitle}>Add a user — {addTo.name}</span>
            <button type="button" className={styles.actionBtn} onClick={() => setAddTo(null)}>
              Close
            </button>
          </div>
          <form className={styles.domainForm} onSubmit={(e) => void addUser(e)}>
            <select className={styles.select} value={userForm.role} onChange={(e) => setUserForm({ ...userForm, role: e.target.value as 'COMPANY_ADMIN' | 'MEDIA_BUYER' })}>
              <option value="COMPANY_ADMIN">Company admin</option>
              <option value="MEDIA_BUYER">Media buyer</option>
            </select>
            <input className={styles.rangeInput} placeholder="name" value={userForm.name} onChange={(e) => setUserForm({ ...userForm, name: e.target.value })} />
            <input className={styles.rangeInput} type="email" placeholder="email" value={userForm.email} onChange={(e) => setUserForm({ ...userForm, email: e.target.value })} />
            <input className={styles.rangeInput} type="password" placeholder="password (8+)" value={userForm.password} onChange={(e) => setUserForm({ ...userForm, password: e.target.value })} />
            <Button type="submit" loading={addingUser} disabled={!userForm.name.trim() || !userForm.email.trim() || userForm.password.length < 8}>
              Add user
            </Button>
          </form>
        </Card>
      )}
    </div>
  );
}

// A keyed fragment so each company can render its row + an expandable detail row.
function FragmentRow({ children }: { children: React.ReactNode }): React.ReactNode {
  return <>{children}</>;
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
