import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_PREFS,
  loadPrefs,
  mergeSetOptions,
  sanitizeCustomCommands,
  sanitizeLanguageBookmarks,
  type Prefs,
} from '../src/shared/storage';
import { DEFAULT_LANGUAGE_SHORTCUT, type ShortcutSpec } from '../src/shared/shortcut';

function stubStorage(stored: unknown): void {
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: vi.fn(async () => ({ prefs: stored })),
        set: vi.fn(async () => {}),
      },
    },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('mergeSetOptions', () => {
  const stored: Prefs = {
    ...DEFAULT_PREFS,
    selectedLanguage: 'en-US',
    theme: 'dark',
    autoRestart: true,
    customCommands: [{ phrase: 'eye packet', replacement: 'iPacket' }],
  };

  it('applies provided fields and preserves everything else from storage', () => {
    const merged = mergeSetOptions(stored, { autoRestart: false, numbersAsDigits: true });
    expect(merged.autoRestart).toBe(false);
    expect(merged.numbersAsDigits).toBe(true);
    // Regression: fields NOT in the payload keep their stored values instead
    // of reverting to a caller's stale snapshot.
    expect(merged.theme).toBe('dark');
    expect(merged.selectedLanguage).toBe('en-US');
    expect(merged.customCommands).toEqual([{ phrase: 'eye packet', replacement: 'iPacket' }]);
  });

  it('accepts the full broadcast payload without clobbering anything', () => {
    const merged = mergeSetOptions(stored, {
      showStatusIndicator: true,
      autoRestart: false,
      voiceCommands: false,
      numbersAsDigits: true,
      selectedLanguage: 'fa-IR',
      preferredRecognitionMode: 'cloud',
      theme: 'light',
      bookmarkedLanguages: ['fa-IR'],
      languageSwitchShortcut: { code: 'KeyJ', key: 'j', ctrl: true, alt: false, shift: false, meta: false },
      customCommands: [],
    });
    expect(merged).toEqual({
      ...stored,
      showStatusIndicator: true,
      autoRestart: false,
      voiceCommands: false,
      numbersAsDigits: true,
      selectedLanguage: 'fa-IR',
      preferredRecognitionMode: 'cloud',
      theme: 'light',
      bookmarkedLanguages: ['fa-IR'],
      languageSwitchShortcut: { code: 'KeyJ', key: 'j', ctrl: true, alt: false, shift: false, meta: false },
      customCommands: [],
    });
  });

  it('sanitizes the transcription provider and Gemini model', () => {
    const merged = mergeSetOptions(stored, {
      dictationProvider: 'gemini' as Prefs['dictationProvider'],
      geminiModel: 'custom-model',
    });
    expect(merged.dictationProvider).toBe('gemini');
    expect(merged.geminiModel).toBe('custom-model');
    expect(mergeSetOptions(stored, { dictationProvider: 'bad' as never, geminiModel: 'bad model' }).geminiModel)
      .toBe(DEFAULT_PREFS.geminiModel);
  });

  it('sanitizes bookmarked languages and custom commands', () => {
    const merged = mergeSetOptions(stored, {
      bookmarkedLanguages: ['en-US', 'junk', 'en-US', 5],
      customCommands: [{ phrase: ' ok ', replacement: 'z' }, 'junk'],
    });
    expect(merged.bookmarkedLanguages).toEqual(['en-US']);
    expect(merged.customCommands).toEqual([{ phrase: 'ok', replacement: 'z' }]);
  });

  it('ignores invalid field types instead of corrupting prefs', () => {
    const merged = mergeSetOptions(stored, {
      theme: 'blue' as unknown as Prefs['theme'],
      selectedLanguage: 'qq-XX' as unknown as Prefs['selectedLanguage'],
      autoRestart: 'yes' as unknown as boolean,
      voiceCommands: undefined,
    });
    expect(merged.theme).toBe('dark');
    expect(merged.selectedLanguage).toBe('en-US');
    expect(merged.autoRestart).toBe(true);
    expect(merged.voiceCommands).toBe(stored.voiceCommands);
  });

  it('applies the language-switch shortcut and keeps it when absent', () => {
    const next: ShortcutSpec | null = { code: 'KeyJ', key: 'j', ctrl: true, alt: false, shift: false, meta: false };
    expect(mergeSetOptions(stored, { languageSwitchShortcut: next }).languageSwitchShortcut).toEqual(next);
    // Absent → keeps stored; undefined shortcut value → sanitized to null (disabled).
    expect(mergeSetOptions(stored, {}).languageSwitchShortcut).toEqual(stored.languageSwitchShortcut);
    expect(
      mergeSetOptions(stored, { languageSwitchShortcut: 'junk' as unknown as ShortcutSpec }).languageSwitchShortcut
    ).toBeNull();
  });

  it('allows null to disable the custom switcher', () => {
    expect(mergeSetOptions(stored, { languageSwitchShortcut: null }).languageSwitchShortcut).toBeNull();
  });

  it('applies the Voice Transcribing settings and sanitizes the vocabulary', () => {
    const merged = mergeSetOptions(stored, {
      transcriptionLanguage: 'auto',
      transcriptionMode: 'smart',
      transcriptionVocabulary: [' Kubernetes ', 'BigQuery', 'kubernetes', '', 42],
    });
    expect(merged.transcriptionLanguage).toBe('auto');
    expect(merged.transcriptionMode).toBe('smart');
    expect(merged.transcriptionVocabulary).toEqual(['Kubernetes', 'BigQuery']);
  });

  it('ignores a Voice Transcribing value it does not recognize', () => {
    const withSettings: Prefs = {
      ...stored,
      transcriptionLanguage: 'en-US',
      transcriptionMode: 'smart',
      transcriptionVocabulary: ['Kubernetes'],
    };
    const merged = mergeSetOptions(withSettings, {
      transcriptionLanguage: 'qq-XX' as unknown as Prefs['transcriptionLanguage'],
      transcriptionMode: 'verbose' as unknown as Prefs['transcriptionMode'],
      transcriptionVocabulary: 'Kubernetes' as unknown as string[],
    });
    expect(merged.transcriptionLanguage).toBe('en-US');
    expect(merged.transcriptionMode).toBe('smart');
    // A non-array clears the list rather than persisting a string.
    expect(merged.transcriptionVocabulary).toEqual([]);
  });

  it('returns stored prefs untouched for an empty payload', () => {
    expect(mergeSetOptions(stored, {})).toEqual(stored);
  });
});

describe('sanitizeCustomCommands', () => {
  it('keeps valid commands and drops malformed entries', () => {
    const sanitized = sanitizeCustomCommands([
      { phrase: ' eye packet ', replacement: 'iPacket' },
      null,
      'junk',
      { phrase: '' },
      { phrase: 42, replacement: 'x' },
      { replacement: 'no phrase' },
      { phrase: 'silent', replacement: 7 }, // non-string replacement → dropped? no: coerced to ''
    ]);
    expect(sanitized).toEqual([
      { phrase: 'eye packet', replacement: 'iPacket' },
      { phrase: 'silent', replacement: '' },
    ]);
  });

  it('allows an empty replacement (mutes the phrase)', () => {
    expect(sanitizeCustomCommands([{ phrase: 'سکوت', replacement: '' }])).toEqual([
      { phrase: 'سکوت', replacement: '' },
    ]);
  });

  it('returns an empty list for non-array input', () => {
    expect(sanitizeCustomCommands(undefined)).toEqual([]);
    expect(sanitizeCustomCommands('nope')).toEqual([]);
    expect(sanitizeCustomCommands({})).toEqual([]);
  });
});

describe('sanitizeLanguageBookmarks', () => {
  it('keeps supported languages in order and drops junk/duplicates', () => {
    expect(sanitizeLanguageBookmarks(['en-US', 'junk', 'fa-IR', 'en-US', 5, null])).toEqual([
      'en-US',
      'fa-IR',
    ]);
  });

  it('returns an empty list for non-array input', () => {
    expect(sanitizeLanguageBookmarks(undefined)).toEqual([]);
    expect(sanitizeLanguageBookmarks('fa-IR')).toEqual([]);
  });
});

describe('loadPrefs — custom commands', () => {
  it('falls back to defaults when nothing is stored', async () => {
    stubStorage(undefined);
    await expect(loadPrefs()).resolves.toEqual({ ...DEFAULT_PREFS });
  });

  it('falls back to defaults when storage throws', async () => {
    vi.stubGlobal('chrome', {
      storage: {
        local: {
          get: vi.fn(async () => {
            throw new Error('context invalidated');
          }),
          set: vi.fn(async () => {}),
        },
      },
    });
    await expect(loadPrefs()).resolves.toEqual({ ...DEFAULT_PREFS });
  });

  it('sanitizes stored custom commands', async () => {
    stubStorage({
      ...DEFAULT_PREFS,
      customCommands: [{ phrase: ' ok ', replacement: 'x' }, 'junk', { phrase: '' }],
    });
    const prefs = await loadPrefs();
    expect(prefs.customCommands).toEqual([{ phrase: 'ok', replacement: 'x' }]);
  });
});

describe('loadPrefs — language switch shortcut', () => {
  it('defaults to the Alt+Shift+L combo when nothing is stored', async () => {
    stubStorage(undefined);
    const prefs = await loadPrefs();
    expect(prefs.languageSwitchShortcut).toEqual(DEFAULT_LANGUAGE_SHORTCUT);
    expect(DEFAULT_LANGUAGE_SHORTCUT).toEqual({
      code: 'KeyL',
      key: 'l',
      ctrl: false,
      alt: true,
      shift: true,
      meta: false,
    });
  });

  it('sanitizes a stored shortcut and keeps a valid custom combo', async () => {
    stubStorage({
      ...DEFAULT_PREFS,
      languageSwitchShortcut: { code: 'KeyJ', key: 'j', ctrl: true, alt: false, shift: false, meta: false },
    });
    expect((await loadPrefs()).languageSwitchShortcut).toEqual({
      code: 'KeyJ',
      key: 'j',
      ctrl: true,
      alt: false,
      shift: false,
      meta: false,
    });

    stubStorage({ ...DEFAULT_PREFS, languageSwitchShortcut: { code: 'KeyL' } });
    expect((await loadPrefs()).languageSwitchShortcut).toEqual(DEFAULT_LANGUAGE_SHORTCUT);

    stubStorage({ ...DEFAULT_PREFS, languageSwitchShortcut: null });
    expect((await loadPrefs()).languageSwitchShortcut).toBeNull();
  });
});

describe('loadPrefs — Voice Transcribing settings', () => {
  it('starts new users in the documented defaults', async () => {
    // Regression risk: a user upgrading from a build without these fields must
    // still get verbatim transcription and no vocabulary rather than undefined.
    stubStorage({ ...DEFAULT_PREFS, transcriptionLanguage: undefined });
    const prefs = await loadPrefs();
    expect(prefs.transcriptionLanguage).toBe(DEFAULT_PREFS.transcriptionLanguage);
    expect(prefs.transcriptionMode).toBe('verbatim');
    expect(prefs.transcriptionVocabulary).toEqual([]);
  });

  it('keeps saved values and sanitizes a corrupt vocabulary', async () => {
    stubStorage({
      ...DEFAULT_PREFS,
      transcriptionLanguage: 'auto',
      transcriptionMode: 'smart',
      transcriptionVocabulary: ['Kubernetes', ' kubernetes ', '', 7],
    });
    const prefs = await loadPrefs();
    expect(prefs.transcriptionLanguage).toBe('auto');
    expect(prefs.transcriptionMode).toBe('smart');
    expect(prefs.transcriptionVocabulary).toEqual(['Kubernetes']);
  });

  it('repairs a saved language or mode it does not recognize', async () => {
    stubStorage({
      ...DEFAULT_PREFS,
      transcriptionLanguage: 'qq-XX',
      transcriptionMode: 'chatty',
    });
    const prefs = await loadPrefs();
    expect(prefs.transcriptionLanguage).toBe(DEFAULT_PREFS.transcriptionLanguage);
    expect(prefs.transcriptionMode).toBe(DEFAULT_PREFS.transcriptionMode);
  });
});

describe('loadPrefs — Gemini model migration', () => {
  it('upgrades prefs saved while the legacy default model was current', async () => {
    stubStorage({ ...DEFAULT_PREFS, geminiModel: 'gemini-3.5-flash-lite' });
    expect((await loadPrefs()).geminiModel).toBe('gemini-3.5-transcribe');
  });

  it('keeps a model the user chose deliberately', async () => {
    stubStorage({ ...DEFAULT_PREFS, geminiModel: 'gemini-2.5-pro' });
    expect((await loadPrefs()).geminiModel).toBe('gemini-2.5-pro');
  });
});

describe('loadPrefs — recognition-mode migration', () => {
  it('carries the legacy preferredEnglishMode value over', async () => {
    const legacy: Record<string, unknown> = { ...DEFAULT_PREFS, preferredEnglishMode: 'cloud' };
    delete legacy.preferredRecognitionMode;
    stubStorage(legacy);
    expect((await loadPrefs()).preferredRecognitionMode).toBe('cloud');
  });

  it('prefers the new key when both are stored', async () => {
    stubStorage({ ...DEFAULT_PREFS, preferredEnglishMode: 'cloud', preferredRecognitionMode: 'local' });
    expect((await loadPrefs()).preferredRecognitionMode).toBe('local');
  });

  it('accepts any catalog language as the saved selection', async () => {
    stubStorage({ ...DEFAULT_PREFS, selectedLanguage: 'de-DE', bookmarkedLanguages: ['fa-IR', 'de-DE'] });
    const prefs = await loadPrefs();
    expect(prefs.selectedLanguage).toBe('de-DE');
    expect(prefs.bookmarkedLanguages).toEqual(['fa-IR', 'de-DE']);
  });
});
