'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { auth, getAccessToken, getStoredUser } from '@/lib/api';
import { type SessionUser } from '@/lib/types';

type AuthState = 'loading' | 'authed' | 'anon';

interface AuthContextValue {
  user: SessionUser | null;
  state: AuthState;
  login: (email: string, password: string) => Promise<SessionUser>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [state, setState] = useState<AuthState>('loading');

  useEffect(() => {
    let active = true;
    void (async () => {
      if (!getAccessToken()) {
        if (active) setState('anon');
        return;
      }
      const stored = getStoredUser();
      if (stored && active) setUser(stored); // optimistic paint
      try {
        const me = await auth.me();
        if (!active) return;
        setUser(me);
        setState('authed');
      } catch {
        if (!active) return;
        setUser(null);
        setState('anon');
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const u = await auth.login(email, password);
    setUser(u);
    setState('authed');
    return u;
  }, []);

  const logout = useCallback(async () => {
    await auth.logout();
    setUser(null);
    setState('anon');
  }, []);

  const value = useMemo(() => ({ user, state, login, logout }), [user, state, login, logout]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within <AuthProvider>');
  return ctx;
}
