'use client';

import { type FormEvent, useState } from 'react';
import Link from 'next/link';
import { Banner, Button, Card, TextField } from '@/components/ui';
import { ApiError, auth } from '@/lib/api';
import styles from '../login/login.module.css';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type FieldErrors = Partial<Record<'name' | 'email' | 'password' | 'companySlug', string>>;

export default function SignupPage() {
  const [form, setForm] = useState({ name: '', email: '', password: '', companySlug: '' });
  const [showPassword, setShowPassword] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  function update(key: keyof typeof form, value: string) {
    setForm((f) => ({ ...f, [key]: value }));
    if (fieldErrors[key]) setFieldErrors((e) => ({ ...e, [key]: undefined }));
  }

  function validate() {
    const next: FieldErrors = {};
    if (!form.name.trim()) next.name = 'Your name is required.';
    const trimmedEmail = form.email.trim();
    if (!trimmedEmail) next.email = 'Email is required.';
    else if (!EMAIL_RE.test(trimmedEmail)) next.email = 'Enter a valid email address.';
    if (!form.password) next.password = 'Password is required.';
    else if (form.password.length < 8) next.password = 'Use at least 8 characters.';
    if (!form.companySlug.trim()) next.companySlug = 'Company code is required.';
    setFieldErrors(next);
    return Object.keys(next).length === 0;
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!validate()) return;
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
      setError(
        err instanceof ApiError
          ? err.message
          : 'Could not create your account — check the company code and try again.',
      );
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
          {error && (
            <Banner tone="error" title="Couldn’t create account">
              {error}
            </Banner>
          )}
          <TextField
            id="name"
            label="Your name"
            autoComplete="name"
            autoFocus
            requiredMark
            placeholder="Jordan Doe"
            value={form.name}
            error={fieldErrors.name}
            onChange={(e) => update('name', e.target.value)}
            required
          />
          <TextField
            id="email"
            label="Email"
            type="email"
            inputMode="email"
            autoComplete="email"
            requiredMark
            placeholder="you@company.com"
            value={form.email}
            error={fieldErrors.email}
            onChange={(e) => update('email', e.target.value)}
            required
          />
          <TextField
            id="password"
            label="Password"
            type={showPassword ? 'text' : 'password'}
            autoComplete="new-password"
            requiredMark
            placeholder="8+ characters"
            hint="At least 8 characters."
            value={form.password}
            error={fieldErrors.password}
            onChange={(e) => update('password', e.target.value)}
            required
            minLength={8}
            trailing={
              <button
                type="button"
                className={styles.reveal}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
                aria-pressed={showPassword}
                onClick={() => setShowPassword((s) => !s)}
              >
                {showPassword ? 'Hide' : 'Show'}
              </button>
            }
          />
          <TextField
            id="companySlug"
            label="Company code"
            autoComplete="organization"
            requiredMark
            placeholder="your-company"
            hint="The code your company admin gave you (e.g. acme-media)."
            value={form.companySlug}
            error={fieldErrors.companySlug}
            onChange={(e) => update('companySlug', e.target.value)}
            required
          />
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
