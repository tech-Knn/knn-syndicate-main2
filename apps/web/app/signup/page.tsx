'use client';

import { type FormEvent, useState } from 'react';
import Link from 'next/link';
import { Button, Card, TextField } from '@/components/ui';
import { ApiError, auth } from '@/lib/api';
import styles from '../login/login.module.css';

export default function SignupPage() {
  const [form, setForm] = useState({ name: '', email: '', password: '', companySlug: '' });
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await auth.signup({
        name: form.name.trim(),
        email: form.email.trim(),
        password: form.password,
        companySlug: form.companySlug.trim().toLowerCase(),
      });
      setDone(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create your account — check the company code and try again.');
      setSubmitting(false);
    }
  }

  if (done) {
    return (
      <main className={styles.wrap}>
        <Card className={styles.card}>
          <div className={styles.head}>
            <span className="eyebrow">KNN Syndicate</span>
            <h1 className={`serif ${styles.title}`}>Request sent</h1>
            <p className={styles.subtitle}>
              Your media-buyer account is pending approval by your company admin. You can sign in once they approve you.
            </p>
          </div>
          <p className={styles.foot}>
            <Link href="/login">Back to sign in</Link>
          </p>
        </Card>
      </main>
    );
  }

  return (
    <main className={styles.wrap}>
      <Card className={styles.card}>
        <div className={styles.head}>
          <span className="eyebrow">KNN Syndicate</span>
          <h1 className={`serif ${styles.title}`}>Join your company</h1>
          <p className={styles.subtitle}>Create a media-buyer account. A company admin approves you before you can sign in.</p>
        </div>

        <form className={styles.form} onSubmit={onSubmit} noValidate>
          {error && <div className={styles.error}>{error}</div>}
          <TextField id="name" label="Your name" placeholder="Jordan Doe" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
          <TextField id="email" label="Email" type="email" autoComplete="email" placeholder="you@company.com" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required />
          <TextField id="password" label="Password" type="password" autoComplete="new-password" placeholder="8+ characters" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required />
          <TextField id="companySlug" label="Company code" placeholder="your-company" value={form.companySlug} onChange={(e) => setForm({ ...form, companySlug: e.target.value })} required />
          <Button type="submit" block loading={submitting}>
            {submitting ? 'Creating…' : 'Create account'}
          </Button>
        </form>

        <p className={styles.foot}>
          Already have access? <Link href="/login">Sign in</Link>
        </p>
      </Card>
    </main>
  );
}
