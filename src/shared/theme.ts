import type { ThemePreference } from './storage';

/** Applies the theme preference to the current document (popup/options). */
export function applyTheme(theme: ThemePreference): void {
  if (theme === 'system') {
    delete document.documentElement.dataset.theme;
  } else {
    document.documentElement.dataset.theme = theme;
  }
}
