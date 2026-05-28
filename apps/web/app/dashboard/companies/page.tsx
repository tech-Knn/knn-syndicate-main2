'use client';

import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Badge, Button, Card, Skeleton } from '@/components/ui';
import { admin } from '@/lib/api';
import { type OrgRow } from '@/lib/types';
import { useAuth } from '../../providers';
import styles from '../admin.module.css';

const blank = { name: '', slug: '', adminName: '', adminEmail: '', adminPassword: '' };

export default function CompaniesPage() {
  const { user } = useAuth();
  const router = useRouter();
  const [orgs, setOrgs] = useState<OrgRow[] | null>(null);
  const [form, setForm] = useState(blank);
  const [creating, setCreating] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (user && user.role !== 'SUPER_ADMIN') router.replace('/dashboard');
  }, [user, router]);

  const load = useCallback(() => {
    void admin.organizations().then(setOrgs).catch(() => setOrgs([]));
  }, []);
  useEffect(() => load(), [load]);

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
    } catch (err) {
      setNote(err instanceof Error ? err.message : 'Could not update');
    } finally {
      setBusy(null);
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
      setAddTo(null);
      load();
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
          <p className={styles.sub}>Create client companies and manage their approval / launch modes. Buyers sign up with a company&apos;s slug.</p>
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
                  <tr key={o.id}>
                    <td>
                      <div className={styles.name}>{o.name}</div>
                      <div className={styles.subtle}>{o.status.toLowerCase()}</div>
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
                        <button type="button" className={styles.actionBtn} onClick={() => openAddUser(o)}>
                          Add user
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className={styles.fieldHint}>
          A buyer joins a company at <strong>/signup</strong> using its <strong>signup slug</strong>; the company admin (or super-admin) approves
          them on the <strong>Team</strong> page. &ldquo;Approval&rdquo; / &ldquo;Launch&rdquo; toggle whether campaigns auto-approve / auto-launch.
          Use <strong>Add user</strong> to create an admin (or buyer) for a company directly — they&apos;re active immediately, no approval needed.
        </p>
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

function slugify(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
