'use client';

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode, type SVGProps } from 'react';
import type { CSSProperties } from 'react';
import {
  THEME_MEDIA_QUERY,
  THEME_STORAGE_KEY,
  normalizeThemePreference,
  resolveTheme,
  type ResolvedTheme,
  type ThemePreference,
} from './theme';

interface ThemeContextValue {
  preference: ThemePreference;
  resolvedTheme: ResolvedTheme;
  setPreference: (next: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

const dockStyle: CSSProperties = {
  position: 'fixed',
  top: '1rem',
  right: '1rem',
  zIndex: 100,
  display: 'flex',
  justifyContent: 'flex-end',
};

const controlShellStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: '2px',
  padding: '3px',
  borderRadius: '9999px',
  border: '1px solid var(--color-line-strong)',
  background: 'var(--color-panel)',
  boxShadow: 'var(--shadow-soft)',
  backdropFilter: 'blur(18px)',
};

const srOnlyStyle: CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: 'hidden',
  clip: 'rect(0, 0, 0, 0)',
  whiteSpace: 'nowrap',
  border: 0,
};

function readInitialPreference(): ThemePreference {
  if (typeof document === 'undefined') {
    return 'system';
  }

  return normalizeThemePreference(document.documentElement.dataset.themePreference);
}

function readInitialResolvedTheme(): ResolvedTheme {
  if (typeof document === 'undefined') {
    return 'light';
  }

  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

function applyTheme(preference: ThemePreference): ResolvedTheme {
  const prefersDark = window.matchMedia(THEME_MEDIA_QUERY).matches;
  const resolved = resolveTheme(preference, prefersDark);

  document.documentElement.dataset.theme = resolved;
  document.documentElement.dataset.themePreference = preference;
  document.documentElement.style.colorScheme = resolved;

  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // Ignore storage failures so the theme still applies for the current session.
  }

  return resolved;
}

export function AppThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>(readInitialPreference);
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>(readInitialResolvedTheme);

  useEffect(() => {
    setResolvedTheme(applyTheme(preference));

    const mediaQuery = window.matchMedia(THEME_MEDIA_QUERY);
    const handleChange = () => {
      if (preference === 'system') {
        setResolvedTheme(applyTheme('system'));
      }
    };

    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, [preference]);

  const value = useMemo(
    () => ({
      preference,
      resolvedTheme,
      setPreference: setPreferenceState,
    }),
    [preference, resolvedTheme],
  );

  return (
    <ThemeContext.Provider value={value}>
      {children}
      <div style={dockStyle}>
        <ThemeSwitcher />
      </div>
    </ThemeContext.Provider>
  );
}

function ThemeSwitcher() {
  const { preference, setPreference } = useTheme();

  const options: ReadonlyArray<{ value: ThemePreference; label: string; Icon: (props: SVGProps<SVGSVGElement>) => ReactNode }> = [
    { value: 'light', label: 'Light theme', Icon: SunIcon },
    { value: 'system', label: 'System theme', Icon: MonitorIcon },
    { value: 'dark', label: 'Dark theme', Icon: MoonIcon },
  ];

  return (
    <div role="group" aria-label="Color theme" style={controlShellStyle}>
      {options.map(({ value, label, Icon }) => {
        const active = value === preference;

        return (
          <button
            key={value}
            type="button"
            onClick={() => setPreference(value)}
            aria-pressed={active}
            aria-label={label}
            title={label}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 28,
              height: 28,
              borderRadius: '9999px',
              border: 'none',
              background: active ? 'var(--color-accent-soft)' : 'transparent',
              color: active ? 'var(--color-accent-strong)' : 'var(--color-text-soft)',
              cursor: 'pointer',
              padding: 0,
              transition: 'background-color 160ms ease, color 160ms ease',
            }}
          >
            <Icon aria-hidden="true" width={16} height={16} />
            <span style={srOnlyStyle}>{label}</span>
          </button>
        );
      })}
    </div>
  );
}

function SunIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
    </svg>
  );
}

function MoonIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79Z" />
    </svg>
  );
}

function MonitorIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <path d="M8 20h8M12 16v4" />
    </svg>
  );
}

export function useTheme() {
  const value = useContext(ThemeContext);

  if (!value) {
    throw new Error('useTheme must be used inside AppThemeProvider.');
  }

  return value;
}
