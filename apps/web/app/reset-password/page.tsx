'use client';

import { type FormEvent, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { BrandMark } from '@/components/brand';
import { Banner, Button, Card, TextField } from '@/components/ui';
import { ApiError, auth } from '@/lib/api';
import styles from '../login/login.module.css';

/**
 * Where a user lands from the single-use link their admin sent them (D37). The token is in the URL fragment (`#token`): it is
 * read once on load and then removed from the address bar, so it never reaches a server log, a Referer header or the browser history.
 */
export default function ResetPasswordPage() {
  const [token, setToken] = useState<string | null | undefined>(undefined); // undefined = not read yet, null = none
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<{ password?: string; confirm?: string }>({});
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const doneHeadingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    const t = window.location.hash.replace(/^#/, '').trim();
    setToken(t || null);
    if (t) window.history.replaceState(null, '', window.location.pathname);
  }, []);

  useEffect(() => {
    if (done) doneHeadingRef.current?.focus();
  }, [done]);

  function validate(): boolean {
    const next: { password?: string; confirm?: string } = {};
    if (password.length < 8) next.password = 'Use at least 8 characters.';
    if (confirm !== password) next.confirm = 'The two passwords don’t match.';
    setFieldErrors(next);
    return Object.keys(next).length === 0;
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!token || !validate()) return;
    setSubmitting(true);
    try {
      await auth.resetPassword(token, password);
      setDone(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Try again.');
      setSubmitting(false);
    }
  }

  const head = (title: string, subtitle: string, ref?: React.Ref<HTMLHeadingElement>) => (
    <div className={styles.head}>
      <span className={styles.brandBadge} aria-hidden>
        <BrandMark size={46} />
      </span>
      <span className="eyebrow">KNN Syndicate</span>
      <h1 ref={ref} tabIndex={-1} className={`serif ${styles.title}`}>
        {title}
      </h1>
      <p className={styles.subtitle}>{subtitle}</p>
    </div>
  );

  if (token === undefined) return <main className={styles.wrap} aria-busy="true" />;

  if (done) {
    return (
      <main className={styles.wrap}>
        <Card className={styles.card}>
          {head('Password updated', 'You can sign in with your new password now. Any device that was signed in has been signed out.', doneHeadingRef)}
          <Link href="/login">
            <Button block>Go to sign in</Button>
          </Link>
        </Card>
      </main>
    );
  }

  if (token === null) {
    return (
      <main className={styles.wrap}>
        <Card className={styles.card}>
          {head('Reset link needed', 'Open the full link your admin sent you. If it doesn’t work, ask them for a new one.')}
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
        {head('Choose a new password', 'This link works once. Pick a password you don’t use anywhere else.')}
        <form className={styles.form} onSubmit={onSubmit} noValidate>
          {error && (
            <Banner tone="error" title="Couldn’t change the password">
              {error}
            </Banner>
          )}
          <TextField
            id="password"
            label="New password"
            type={showPassword ? 'text' : 'password'}
            autoComplete="new-password"
            autoFocus
            requiredMark
            placeholder="8+ characters"
            hint="At least 8 characters."
            value={password}
            error={fieldErrors.password}
            onChange={(e) => {
              setPassword(e.target.value);
              if (fieldErrors.password) setFieldErrors((f) => ({ ...f, password: undefined }));
            }}
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
            id="confirm"
            label="Repeat the new password"
            type={showPassword ? 'text' : 'password'}
            autoComplete="new-password"
            requiredMark
            value={confirm}
            error={fieldErrors.confirm}
            onChange={(e) => {
              setConfirm(e.target.value);
              if (fieldErrors.confirm) setFieldErrors((f) => ({ ...f, confirm: undefined }));
            }}
            required
          />
          <Button type="submit" block loading={submitting}>
            {submitting ? 'Saving…' : 'Set new password'}
          </Button>
        </form>
        <p className={styles.foot}>
          <Link href="/login">Back to sign in</Link>
        </p>
      </Card>
    </main>
  );
}
