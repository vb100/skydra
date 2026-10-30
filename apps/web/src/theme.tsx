import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

type Theme = 'light' | 'dark';
const KEY = 'skydra-theme';

/** Light unless the user chose dark; the choice is remembered in this browser only. */
export function storedTheme(): Theme {
  try {
    return localStorage.getItem(KEY) === 'dark' ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
}

export function ThemeToggle() {
  const { t } = useTranslation();
  const [theme, setTheme] = useState<Theme>(storedTheme);

  useEffect(() => {
    applyTheme(theme);
    try {
      localStorage.setItem(KEY, theme);
    } catch {
      // Storage may be unavailable (private mode); the theme still applies for this page.
    }
  }, [theme]);

  const next = theme === 'dark' ? 'light' : 'dark';
  return (
    <button
      type="button"
      className="ghost small theme-toggle"
      onClick={() => setTheme(next)}
      aria-label={t(`theme.${next}`)}
      title={t(`theme.${next}`)}
    >
      {theme === 'dark' ? '☀' : '☾'}
    </button>
  );
}
