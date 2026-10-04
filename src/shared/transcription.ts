/**
 * Voice Transcribing settings — the single source of truth for the three
 * options exposed in the Settings page's "Voice Transcribing" section:
 *
 *   • Language:      any catalog language, or Automatic detection
 *   • Mode:          Verbatim (default) / Smart
 *   • Custom words:  a comma-separated list of terms to bias recognition on
 *
 * Every value is expressed in the shape Google's Gemini API documents for
 * `generation_config.transcription_config` (see `buildTranscriptionConfig`).
 * Nothing here is Web Speech specific: the browser SpeechRecognition API has
 * no vocabulary hinting and no formatting mode, so these options belong to the
 * Voice Transcribing engine only.
 */
import { MAX_CUSTOM_VOCABULARY_TERMS, MAX_VOCABULARY_TERM_LENGTH, SUPPORTED_LANGUAGES } from './constants';
import type { TranscriptionLanguage, TranscriptionMode } from './types';

/** The three settings, normalized. This is what travels to the API layer. */
export interface TranscriptionSettings {
  /** BCP-47 hint, or 'auto' to let the model detect the language itself. */
  language: TranscriptionLanguage;
  mode: TranscriptionMode;
  /** Domain terms the model should recognise; sent as `custom_vocabulary`. */
  vocabulary: string[];
}

/**
 * Google's `transcription_config` object, exactly as documented for
 * `gemini-3.5-transcribe`:
 *
 *   {
 *     "language_codes": ["fa-IR"],   // [] ⇒ automatic language detection
 *     "mode": "smart",               // or { "type": "verbatim" }
 *     "custom_vocabulary": ["…"]     // omitted when empty
 *   }
 *
 * Smart mode is documented as incompatible with `timestamp_granularities` and
 * `diarization_mode`, and `custom_vocabulary` as incompatible with those same
 * two. This extension asks for neither, so all three settings combine freely.
 */
export interface GeminiTranscriptionConfig {
  language_codes: string[];
  mode: 'smart' | { type: 'verbatim' };
  custom_vocabulary?: string[];
}

/**
 * Language defaults to فارسی — the extension's own default dictation language
 * — so a user who never touches the setting gets the behaviour they had before
 * it existed. Mode defaults to 'verbatim', which is Google's documented
 * default and the only lossless option.
 */
export const DEFAULT_TRANSCRIPTION_SETTINGS: TranscriptionSettings = {
  language: 'fa-IR',
  mode: 'verbatim',
  vocabulary: [],
};

export function isTranscriptionLanguage(value: unknown): value is TranscriptionLanguage {
  return value === 'auto' || (SUPPORTED_LANGUAGES as readonly string[]).includes(value as string);
}

export function isTranscriptionMode(value: unknown): value is TranscriptionMode {
  return value === 'verbatim' || value === 'smart';
}

/**
 * Normalizes a stored custom-vocabulary list: trims each term, drops blanks,
 * caps the length at Google's documented 1,000 terms, and removes
 * case-insensitive duplicates (they would only waste quota and skew the count
 * shown next to the input).
 */
export function sanitizeVocabularyTerms(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const entry of value) {
    if (terms.length >= MAX_CUSTOM_VOCABULARY_TERMS) break;
    if (typeof entry !== 'string') continue;
    const term = entry.trim().slice(0, MAX_VOCABULARY_TERM_LENGTH);
    if (term.length === 0) continue;
    const key = term.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    terms.push(term);
  }
  return terms;
}

/**
 * Parses the textarea contents the user typed. Commas are the documented
 * separator; newlines are accepted too because pasting a list from elsewhere
 * is the common case, and the Persian/Arabic comma (،) and both semicolons
 * are treated as separators in a bilingual extension.
 */
export function parseVocabularyInput(text: string): string[] {
  return sanitizeVocabularyTerms(text.split(/[,،;؛\r\n]+/));
}

/** Inverse of `parseVocabularyInput`, for rendering the saved list back. */
export function formatVocabularyInput(terms: readonly string[]): string {
  return terms.join(', ');
}

/**
 * Reads all three settings out of an untrusted bag (storage, a broadcast, a
 * message from a page). Each field falls back independently, so a partial or
 * corrupt value never costs the user the other two.
 */
export function sanitizeTranscriptionSettings(value: unknown): TranscriptionSettings {
  const source = (value ?? {}) as Partial<Record<keyof TranscriptionSettings, unknown>>;
  return {
    language: isTranscriptionLanguage(source.language)
      ? source.language
      : DEFAULT_TRANSCRIPTION_SETTINGS.language,
    mode: isTranscriptionMode(source.mode) ? source.mode : DEFAULT_TRANSCRIPTION_SETTINGS.mode,
    vocabulary: sanitizeVocabularyTerms(source.vocabulary),
  };
}

/** Convenience: lift the three settings out of a full prefs object. */
export function transcriptionSettingsFrom(source: {
  transcriptionLanguage: TranscriptionLanguage;
  transcriptionMode: TranscriptionMode;
  transcriptionVocabulary: string[];
}): TranscriptionSettings {
  return {
    language: source.transcriptionLanguage,
    mode: source.transcriptionMode,
    vocabulary: [...source.transcriptionVocabulary],
  };
}

/**
 * Builds the request body Google's Gemini API documents for a transcription.
 * Always sanitizes first: the settings arrive from a message sent by a content
 * script living in an arbitrary web page.
 */
export function buildTranscriptionConfig(value: unknown): GeminiTranscriptionConfig {
  const { language, mode, vocabulary } = sanitizeTranscriptionSettings(value);
  const config: GeminiTranscriptionConfig = {
    // "Omit language codes or pass an empty list … to let the model detect
    // spoken languages and handle code-switching automatically." An explicit
    // empty list is sent rather than an omitted field so the request states
    // its own intent.
    language_codes: language === 'auto' ? [] : [language],
    // Both documented spellings: the bare string for smart, the object form
    // for verbatim (the object form is what the docs use for verbatim, and it
    // is the form that also carries diarization/timestamp options).
    mode: mode === 'smart' ? 'smart' : { type: 'verbatim' },
  };
  if (vocabulary.length > 0) config.custom_vocabulary = vocabulary;
  return config;
}
