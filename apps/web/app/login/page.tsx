'use client';

import { type FormEvent, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { BrandMark } from '@/components/brand';
import { Banner, Button, Card, Spinner, TextField } from '@/components/ui';
import { ApiError } from '@/lib/api';
import { useAuth } from '../providers';
import styles from './login.module.css';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function LoginPage() {
  const router = useRouter();
  const { state, login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<{ email?: string; password?: string }>({});
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (state === 'authed') router.replace('/dashboard');
  }, [state, router]);

  function validate() {
    const next: { email?: string; password?: string } = {};
    const trimmedEmail = email.trim();
    if (!trimmedEmail) next.email = 'Email is required.';
    else if (!EMAIL_RE.test(trimmedEmail)) next.email = 'Enter a valid email address.';
    if (!password) next.password = 'Password is required.';
    setFieldErrors(next);
    return Object.keys(next).length === 0;
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!validate()) return;
    setSubmitting(true);
    try {
      await login(email.trim(), password);
      router.replace('/dashboard');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Try again.');
      setSubmitting(false);
      // Return focus to the password field and select it so the user can retype immediately.
      const pwd = document.getElementById('password') as HTMLInputElement | null;
      pwd?.focus();
      pwd?.select();
    }
  }

  if (state === 'loading' || state === 'authed') {
    return (
      <main className={styles.wrap}>
        <div className={styles.loading} role="status" aria-label="Loading">
          <Spinner />
        </div>
      </main>
    );
  }

  return (
    <main className={styles.wrap}>
      <Card className={styles.card}>
        <div className={styles.head}>
          <span className={styles.brandBadge} aria-hidden>
            <BrandMark size={46} />
          </span>
          <span className="eyebrow">KNN Syndicate</span>
          <h1 className={`serif ${styles.title}`}>Welcome back</h1>
          <p className={styles.subtitle}>Sign in to the arbitrage console.</p>
        </div>

        <form className={styles.form} onSubmit={onSubmit} noValidate>
          {error && (
            <Banner tone="error" title="Couldn’t sign in">
              {error}
            </Banner>
          )}
          <TextField
            id="email"
            label="Email"
            type="email"
            inputMode="email"
            autoComplete="username"
            autoFocus
            requiredMark
            placeholder="you@company.com"
            value={email}
            error={fieldErrors.email}
            onChange={(e) => {
              setEmail(e.target.value);
              if (fieldErrors.email) setFieldErrors((f) => ({ ...f, email: undefined }));
            }}
            required
          />
          <TextField
            id="password"
            label="Password"
            type={showPassword ? 'text' : 'password'}
            autoComplete="current-password"
            requiredMark
            placeholder="••••••••"
            value={password}
            error={fieldErrors.password}
            onChange={(e) => {
              setPassword(e.target.value);
              if (fieldErrors.password) setFieldErrors((f) => ({ ...f, password: undefined }));
            }}
            required
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
          <Button type="submit" block loading={submitting}>
            {submitting ? 'Signing in…' : 'Sign in'}
          </Button>
        </form>

        <p className={styles.foot}>
          New media buyer? <Link href="/signup">Create an account</Link>.
        </p>
        <p className={styles.hintLine}>Forgot password? Contact your administrator.</p>
        <p className={styles.fine}>
          By signing in you agree to the Terms of Service and Privacy Policy.
        </p>
      </Card>
    </main>
  );
}
