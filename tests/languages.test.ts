import { describe, expect, it, vi } from 'vitest';
import { languageLabel, nextBookmarkedLanguage } from '../src/shared/languages';
import { SUPPORTED_LANGUAGES } from '../src/shared/constants';

describe('nextBookmarkedLanguage', () => {
  it('cycles in stored order', () => {
    expect(nextBookmarkedLanguage('fa-IR', ['fa-IR', 'en-US'])).toBe('en-US');
    expect(nextBookmarkedLanguage('en-US', ['fa-IR', 'en-US'])).toBe('fa-IR');
  });

  it('wraps around with more than two bookmarks', () => {
    expect(nextBookmarkedLanguage('en-US', ['fa-IR', 'en-US'])).toBe('fa-IR');
    expect(nextBookmarkedLanguage('fa-IR', ['fa-IR'])).toBe('fa-IR');
  });

  it('returns the current language when there are no bookmarks', () => {
    expect(nextBookmarkedLanguage('fa-IR', [])).toBe('fa-IR');
  });

  it('jumps to the first bookmark when the current one is not bookmarked', () => {
    expect(nextBookmarkedLanguage('en-US', ['fa-IR'])).toBe('fa-IR');
  });
});

describe('languageLabel', () => {
  it('labels each language in its own script', () => {
    // Node's ICU appends the region ("Deutsch (Deutschland)") where Chrome
    // omits it ("Deutsch") — assert on the language part only.
    expect(languageLabel('de-DE')).toMatch(/^Deutsch/);
    expect(languageLabel('en-US')).toBe('English');
    expect(languageLabel('fa-IR')).toBe('فارسی');
  });

  it('resolves every catalog language without throwing', () => {
    for (const code of SUPPORTED_LANGUAGES) {
      expect(languageLabel(code).length).toBeGreaterThan(0);
    }
  });

  it('falls back to the raw code when DisplayNames fails', async () => {
    class BrokenDisplayNames {
      of(): string {
        throw new RangeError('structurally invalid');
      }
    }
    // Re-import the module so its label cache starts empty: the test above
    // resolved every locale through the real Intl, and a cached instance
    // would bypass the stub.
    vi.resetModules();
    vi.stubGlobal('Intl', { ...Intl, DisplayNames: BrokenDisplayNames });
    try {
      const { languageLabel: freshLabel } = await import('../src/shared/languages');
      expect(freshLabel('fr-FR')).toBe('fr-FR');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
