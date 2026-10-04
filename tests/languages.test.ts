import { describe, expect, it } from 'vitest';
import { nextBookmarkedLanguage } from '../src/shared/languages';

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
