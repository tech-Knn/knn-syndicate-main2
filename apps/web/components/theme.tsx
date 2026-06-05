'use client';

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';

/**
 * Theme system — light/dark via a single `data-theme` attribute on <html> (the token layer in
 * globals.css keys off it). The default is the OS preference; an explicit choice persists in
 * localStorage and wins thereafter. The flash-of-wrong-theme is prevented by THEME_INIT_SCRIPT,
 * which runs in <head> BEFORE first paint (so the attribute is already correct when CSS applies);
 * this provider just mirrors that into React state for the toggle.
 */

export type Theme = 'light' | 'dark';
const STORAGE_KEY = 'knn.theme';

/** Inline, dependency-free — injected in <head> so it sets the theme before the first paint. */
export const THEME_INIT_SCRIPT = `(function(){try{var s=localStorage.getItem('${STORAGE_KEY}');var t=(s==='light'||s==='dark')?s:(window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light');var e=document.documentElement;e.setAttribute('data-theme',t);e.style.colorScheme=t;}catch(_){document.documentElement.setAttribute('data-theme','light');}})();`;

interface ThemeContextValue {
  theme: Theme;
  setTheme: (t: Theme) => void;
  toggle: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function apply(t: Theme): void {
  const e = document.documentElement;
  e.setAttribute('data-theme', t);
  e.style.colorScheme = t;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  // SSR + first client render must agree; the real value is read from the DOM (set by the init
  // script) in the effect below. 'light' matches `:root`'s default.
  const [theme, setThemeState] = useState<Theme>('light');

  useEffect(() => {
    const current = (document.documentElement.getAttribute('data-theme') as Theme | null) ?? 'light';
    setThemeState(current);
    // Follow the OS only while the user hasn't made an explicit choice.
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => {
      if (localStorage.getItem(STORAGE_KEY)) return;
      const sys: Theme = mq.matches ? 'dark' : 'light';
      apply(sys);
      setThemeState(sys);
    };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const setTheme = useCallback((t: Theme) => {
    apply(t);
    try {
      localStorage.setItem(STORAGE_KEY, t);
    } catch {
      /* private mode — theme still applies for the session */
    }
    setThemeState(t);
  }, []);

  const toggle = useCallback(() => {
    const next: Theme =
      (document.documentElement.getAttribute('data-theme') as Theme | null) === 'dark' ? 'light' : 'dark';
    setTheme(next);
  }, [setTheme]);

  return <ThemeContext.Provider value={{ theme, setTheme, toggle }}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within <ThemeProvider>');
  return ctx;
}

function SunIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
    </svg>
  );
}

/**
 * Theme toggle button. Renders a stable placeholder until mounted so SSR and the first client
 * render match (the icon depends on the resolved theme, which is only known on the client).
 */
export function ThemeToggle({ className }: { className?: string }) {
  const { theme, toggle } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const next = theme === 'dark' ? 'light' : 'dark';
  return (
    <button
      type="button"
      className={className}
      onClick={toggle}
      aria-label={mounted ? `Switch to ${next} theme` : 'Toggle theme'}
      title={mounted ? `Switch to ${next} theme` : 'Toggle theme'}
    >
      {mounted ? (theme === 'dark' ? <SunIcon /> : <MoonIcon />) : <span style={{ width: 16, height: 16, display: 'inline-block' }} aria-hidden />}
    </button>
  );
}
