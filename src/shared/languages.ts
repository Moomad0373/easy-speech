import { SUPPORTED_LANGUAGES } from './constants';
import type { Language } from './types';

/**
 * Hand-written labels for the default languages — "English" reads better than
 * DisplayNames' "American English", and the Persian label matches the one the
 * UI has always shown. Every other catalog language is labelled at runtime.
 */
const HAND_LABELS: Partial<Record<Language, string>> = {
  'fa-IR': 'فارسی',
  'en-US': 'English',
};

const displayNamesCache = new Map<string, Intl.DisplayNames>();

function displayNamesFor(locale: string): Intl.DisplayNames | null {
  let instance = displayNamesCache.get(locale);
  if (instance) return instance;
  try {
    instance = new Intl.DisplayNames([locale], { type: 'language' });
  } catch {
    return null;
  }
  displayNamesCache.set(locale, instance);
  return instance;
}

/**
 * Native label for any catalog language: each language is shown in its own
 * script (de-DE → "Deutsch", he-IL → "עברית"), with the raw code as fallback
 * so a never-thrown label is always available to the UI.
 */
export function languageLabel(language: Language): string {
  const hand = HAND_LABELS[language];
  if (hand) return hand;
  return displayNamesFor(language)?.of(language) ?? language;
}

export interface LanguageOption {
  code: Language;
  label: string;
}

let sortedOptions: LanguageOption[] | null = null;

/**
 * The full catalog as display options, sorted by label so a long dropdown is
 * predictable. Computed once and reused by the popup and the options page.
 */
export function sortedLanguageOptions(): readonly LanguageOption[] {
  if (sortedOptions) return sortedOptions;
  const collator = new Intl.Collator();
  sortedOptions = SUPPORTED_LANGUAGES.map((code) => ({ code, label: languageLabel(code) })).sort(
    (a, b) => collator.compare(a.label, b.label) || a.code.localeCompare(b.code)
  );
  return sortedOptions;
}

/**
 * Next bookmarked language in rotation (spec §42). Bookmarks are cycled in
 * stored order; a selection outside the bookmarks jumps to the first
 * bookmark, and an empty bookmark list is a no-op.
 */
export function nextBookmarkedLanguage(current: Language, bookmarks: readonly Language[]): Language {
  if (bookmarks.length === 0) return current;
  const index = bookmarks.indexOf(current);
  if (index === -1) return bookmarks[0]!;
  return bookmarks[(index + 1) % bookmarks.length]!;
}
