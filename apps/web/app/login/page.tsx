'use client';

import { type FormEvent, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Card, TextField } from '@/components/ui';
import { ApiError } from '@/lib/api';
import { useAuth } from '../providers';
import styles from './login.module.css';

export default function LoginPage() {
  const router = useRouter();
  const { state, login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (state === 'authed') router.replace('/dashboard');
  }, [state, router]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await login(email.trim(), password);
      router.replace('/dashboard');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Try again.');
      setSubmitting(false);
    }
  }

  return (
    <main className={styles.wrap}>
      <Card className={styles.card}>
        <div className={styles.head}>
          <span className="eyebrow">KNN Syndicate</span>
          <h1 className={`serif ${styles.title}`}>Welcome back</h1>
          <p className={styles.subtitle}>Sign in to the arbitrage console.</p>
        </div>

        <form className={styles.form} onSubmit={onSubmit} noValidate>
          {error && <div className={styles.error}>{error}</div>}
          <TextField
            id="email"
            label="Email"
            type="email"
            autoComplete="email"
            placeholder="you@company.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
          <TextField
            id="password"
            label="Password"
            type="password"
            autoComplete="current-password"
            placeholder="••••••••"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
          <Button type="submit" block loading={submitting}>
            {submitting ? 'Signing in…' : 'Sign in'}
          </Button>
        </form>

        <p className={styles.foot}>Access is provisioned by your company admin.</p>
      </Card>
    </main>
  );
}
