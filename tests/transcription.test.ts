import { describe, expect, it } from 'vitest';
import { MAX_CUSTOM_VOCABULARY_TERMS, MAX_VOCABULARY_TERM_LENGTH } from '../src/shared/constants';
import {
  buildTranscriptionConfig,
  DEFAULT_TRANSCRIPTION_SETTINGS,
  formatVocabularyInput,
  parseVocabularyInput,
  sanitizeTranscriptionSettings,
  sanitizeVocabularyTerms,
  transcriptionSettingsFrom,
} from '../src/shared/transcription';

/**
 * The three Voice Transcribing settings, pinned to the shapes Google's Gemini
 * API documents for `generation_config.transcription_config`. These are the
 * contract with the API: a field renamed or dropped here silently changes how
 * every recording is transcribed.
 */
describe('Voice Transcribing settings', () => {
  it('defaults to verbatim — the documented, lossless mode', () => {
    expect(DEFAULT_TRANSCRIPTION_SETTINGS.mode).toBe('verbatim');
    expect(DEFAULT_TRANSCRIPTION_SETTINGS.vocabulary).toEqual([]);
  });

  it('sends a BCP-47 hint when a language is chosen', () => {
    expect(buildTranscriptionConfig({ language: 'fa-IR', mode: 'verbatim', vocabulary: [] })).toEqual({
      language_codes: ['fa-IR'],
      mode: { type: 'verbatim' },
    });
    expect(buildTranscriptionConfig({ language: 'en-US', mode: 'verbatim', vocabulary: [] }))
      .toMatchObject({ language_codes: ['en-US'] });
  });

  it('sends an empty language list for automatic detection', () => {
    // "Omit language codes or pass an empty list … to let the model detect
    // spoken languages and handle code-switching automatically."
    const config = buildTranscriptionConfig({ language: 'auto', mode: 'verbatim', vocabulary: [] });
    expect(config.language_codes).toEqual([]);
  });

  it('sends smart as the bare documented string and verbatim as the object', () => {
    expect(buildTranscriptionConfig({ language: 'auto', mode: 'smart', vocabulary: [] }).mode).toBe('smart');
    expect(buildTranscriptionConfig({ language: 'auto', mode: 'verbatim', vocabulary: [] }).mode)
      .toEqual({ type: 'verbatim' });
  });

  it('omits custom_vocabulary entirely when no terms were given', () => {
    const config = buildTranscriptionConfig({ language: 'auto', mode: 'smart', vocabulary: [] });
    expect('custom_vocabulary' in config).toBe(false);
  });

  it('combines all three settings in one config', () => {
    // custom_vocabulary and smart mode are each documented as incompatible
    // with timestamps and diarization only — this extension asks for neither.
    expect(
      buildTranscriptionConfig({
        language: 'en-US',
        mode: 'smart',
        vocabulary: ['Kubernetes', 'BigQuery', 'زیتکس'],
      })
    ).toEqual({
      language_codes: ['en-US'],
      mode: 'smart',
      custom_vocabulary: ['Kubernetes', 'BigQuery', 'زیتکس'],
    });
  });

  it('never emits more terms than the API accepts', () => {
    const vocabulary = Array.from({ length: MAX_CUSTOM_VOCABULARY_TERMS + 50 }, (_, i) => `term${i}`);
    const config = buildTranscriptionConfig({ language: 'auto', mode: 'verbatim', vocabulary });
    expect(config.custom_vocabulary).toHaveLength(MAX_CUSTOM_VOCABULARY_TERMS);
  });

  it('rejects a language that is not one of the offered options', () => {
    // The value reaches the API through a message sent by a content script
    // living in an arbitrary page, so an unknown code must not be forwarded.
    const config = buildTranscriptionConfig({
      language: 'xx-YY',
      mode: 'nonsense',
      vocabulary: ['ok'],
    });
    expect(config.language_codes).toEqual([DEFAULT_TRANSCRIPTION_SETTINGS.language]);
    expect(config.mode).toEqual({ type: 'verbatim' });
  });
});

describe('custom vocabulary parsing', () => {
  it('splits a comma-separated list', () => {
    expect(parseVocabularyInput('Kubernetes, BigQuery, Gemini')).toEqual([
      'Kubernetes',
      'BigQuery',
      'Gemini',
    ]);
  });

  it('also accepts newlines, the Persian comma and semicolons', () => {
    // Pasting a list from a document keeps its line breaks, and the Persian
    // and Arabic commas are what a Persian list is actually written with.
    expect(parseVocabularyInput('Kubernetes\nBigQuery\nزیتکس')).toEqual([
      'Kubernetes',
      'BigQuery',
      'زیتکس',
    ]);
    expect(parseVocabularyInput('یک، دو')).toEqual(['یک', 'دو']);
    expect(parseVocabularyInput('one; two')).toEqual(['one', 'two']);
  });

  it('drops blanks and trims each term', () => {
    expect(parseVocabularyInput('  , Gemini ,, ,  Kubernetes  ,')).toEqual(['Gemini', 'Kubernetes']);
    expect(parseVocabularyInput('   ')).toEqual([]);
  });

  it('removes case-insensitive duplicates, keeping the first spelling', () => {
    expect(sanitizeVocabularyTerms(['Gemini', 'gemini', 'GEMINI', 'Kubernetes'])).toEqual([
      'Gemini',
      'Kubernetes',
    ]);
  });

  it('caps a runaway term instead of sending it whole', () => {
    const [term] = sanitizeVocabularyTerms(['x'.repeat(5000)]);
    expect(term).toHaveLength(MAX_VOCABULARY_TERM_LENGTH);
  });

  it('ignores non-string entries from a corrupt payload', () => {
    expect(sanitizeVocabularyTerms(['ok', 42, null, { term: 'no' }])).toEqual(['ok']);
    expect(sanitizeVocabularyTerms('not an array')).toEqual([]);
  });

  it('round-trips through the textarea representation', () => {
    const typed = 'Kubernetes, BigQuery,\nزیتکس';
    const terms = parseVocabularyInput(typed);
    expect(parseVocabularyInput(formatVocabularyInput(terms))).toEqual(terms);
  });
});

describe('sanitizeTranscriptionSettings', () => {
  it('keeps valid fields and repairs the rest independently', () => {
    expect(
      sanitizeTranscriptionSettings({ language: 'auto', mode: 'bogus', vocabulary: ['a', 1] })
    ).toEqual({ language: 'auto', mode: 'verbatim', vocabulary: ['a'] });
  });

  it('falls back entirely for a non-object input', () => {
    for (const value of [undefined, null, 'x', 7, []]) {
      expect(sanitizeTranscriptionSettings(value)).toEqual(DEFAULT_TRANSCRIPTION_SETTINGS);
    }
  });

  it('copies the vocabulary rather than aliasing the caller list', () => {
    const source = ['Gemini'];
    const settings = transcriptionSettingsFrom({
      transcriptionLanguage: 'en-US',
      transcriptionMode: 'smart',
      transcriptionVocabulary: source,
    });
    source.push('Kubernetes');
    expect(settings.vocabulary).toEqual(['Gemini']);
  });
});
