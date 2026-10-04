import type {
  CustomVoiceCommand,
  Language,
  RecognitionModePreference,
  TranscriptionLanguage,
  TranscriptionMode,
  TranscriptionProvider,
} from './types';

import { DEFAULT_GEMINI_MODEL, SUPPORTED_LANGUAGES } from './constants';
import { DEFAULT_LANGUAGE_SHORTCUT, sanitizeShortcut, type ShortcutSpec } from './shortcut';
import {
  DEFAULT_TRANSCRIPTION_SETTINGS,
  isTranscriptionLanguage,
  isTranscriptionMode,
  sanitizeVocabularyTerms,
} from './transcription';

export type ThemePreference = 'system' | 'light' | 'dark';

/** Hard cap so a corrupted payload can never explode the prefs object. */
const MAX_CUSTOM_COMMANDS = 200;

export interface Prefs {
  selectedLanguage: Language;
  /** How on-device recognition is used for any language (see types). */
  preferredRecognitionMode: RecognitionModePreference;
  autoRestart: boolean;
  showStatusIndicator: boolean;
  voiceCommands: boolean;
  /** "Always type numbers as digits" (spec §41) — final transcripts only. */
  numbersAsDigits: boolean;
  /** Languages the quick-switch shortcut cycles through (spec §42). */
  bookmarkedLanguages: Language[];
  /**
   * In-page combo that cycles the bookmarked languages; recorded on the
   * Settings page. null disables the custom switcher (Chrome's commands
   * shortcut keeps working independently).
   */
  languageSwitchShortcut: ShortcutSpec | null;
  customCommands: CustomVoiceCommand[];
  theme: ThemePreference;
  dictationProvider: TranscriptionProvider;
  geminiModel: string;
  // ---- Voice Transcribing (Gemini) settings -----------------------------------
  /** Language hint for transcription: a BCP-47 code, or 'auto' to detect. */
  transcriptionLanguage: TranscriptionLanguage;
  /** 'verbatim' (lossless, the default) or 'smart' (disfluency removal). */
  transcriptionMode: TranscriptionMode;
  /** Domain terms the model should recognise, as Google's custom_vocabulary. */
  transcriptionVocabulary: string[];
}

export const DEFAULT_PREFS: Prefs = {
  selectedLanguage: 'fa-IR',
  preferredRecognitionMode: 'auto',
  autoRestart: true,
  showStatusIndicator: true,
  voiceCommands: true,
  numbersAsDigits: false,
  bookmarkedLanguages: ['fa-IR', 'en-US'],
  languageSwitchShortcut: { ...DEFAULT_LANGUAGE_SHORTCUT },
  customCommands: [],
  theme: 'system',
  dictationProvider: 'voiceTyping',
  geminiModel: DEFAULT_GEMINI_MODEL,
  transcriptionLanguage: DEFAULT_TRANSCRIPTION_SETTINGS.language,
  transcriptionMode: DEFAULT_TRANSCRIPTION_SETTINGS.mode,
  transcriptionVocabulary: [],
};

const STORAGE_KEY = 'prefs';

/**
 * Normalizes the stored switcher combo: absent → default, explicit null →
 * disabled, anything else valid → spec, anything else invalid → default.
 */
function loadSwitchShortcut(value: unknown): ShortcutSpec | null {
  if (value === undefined) return { ...DEFAULT_LANGUAGE_SHORTCUT };
  if (value === null) return null;
  return sanitizeShortcut(value) ?? { ...DEFAULT_LANGUAGE_SHORTCUT };
}

function isLanguage(value: unknown): value is Language {
  return typeof value === 'string' && (SUPPORTED_LANGUAGES as readonly string[]).includes(value);
}

function isRecognitionModePreference(value: unknown): value is RecognitionModePreference {
  return value === 'auto' || value === 'local' || value === 'cloud';
}

function isTheme(value: unknown): value is ThemePreference {
  return value === 'system' || value === 'light' || value === 'dark';
}

function isTranscriptionProvider(value: unknown): value is TranscriptionProvider {
  return value === 'voiceTyping' || value === 'gemini';
}

export function sanitizeGeminiModel(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_GEMINI_MODEL;
  const model = value.trim();
  return /^[A-Za-z0-9._-]{1,100}$/.test(model) ? model : DEFAULT_GEMINI_MODEL;
}

/**
 * One-time upgrade: prefs saved while 'gemini-3.5-flash-lite' was the default
 * move to the current default; an explicitly chosen other model is untouched.
 */
const LEGACY_DEFAULT_GEMINI_MODEL = 'gemini-3.5-flash-lite';

function migrateGeminiModel(model: string): string {
  return model === LEGACY_DEFAULT_GEMINI_MODEL ? DEFAULT_GEMINI_MODEL : model;
}

/**
 * One-time upgrade: `preferredEnglishMode` was the recognition-mode preference
 * back when only English could run on-device. Any stored value carries over;
 * the semantics ('auto' | 'local' | 'cloud') are unchanged.
 */
function migrateRecognitionMode(raw: Partial<Prefs> & Record<string, unknown>): RecognitionModePreference {
  if (isRecognitionModePreference(raw.preferredRecognitionMode)) return raw.preferredRecognitionMode;
  if (isRecognitionModePreference(raw.preferredEnglishMode)) return raw.preferredEnglishMode;
  return DEFAULT_PREFS.preferredRecognitionMode;
}

/** Deduplicated list of supported languages, capped to every known language. */
export function sanitizeLanguageBookmarks(value: unknown): Language[] {
  if (!Array.isArray(value)) return [];
  const result: Language[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    if (!(SUPPORTED_LANGUAGES as readonly string[]).includes(entry)) continue;
    const language = entry as Language;
    if (!result.includes(language)) result.push(language);
  }
  return result;
}

/**
 * Merges a SET_OPTIONS payload into prefs (spec §20). The base is ALWAYS the
 * caller's freshly loaded stored prefs — never an in-memory snapshot: a
 * content script applying a broadcast must not re-persist stale values for
 * fields the payload doesn't carry (that regression reverted options-page
 * changes milliseconds after they were saved).
 *
 * This function only MERGES — callers decide whether to persist.
 */
export function mergeSetOptions(
  stored: Prefs,
  options: Partial<{
    showStatusIndicator: boolean;
    autoRestart: boolean;
    voiceCommands: boolean;
    numbersAsDigits: boolean;
    bookmarkedLanguages: unknown;
    customCommands: unknown;
    selectedLanguage: unknown;
    preferredRecognitionMode: unknown;
    theme: unknown;
    languageSwitchShortcut: unknown;
    dictationProvider: unknown;
    geminiModel: unknown;
    transcriptionLanguage: unknown;
    transcriptionMode: unknown;
    transcriptionVocabulary: unknown;
  }>
): Prefs {
  const next: Prefs = { ...stored };
  if (typeof options.showStatusIndicator === 'boolean') {
    next.showStatusIndicator = options.showStatusIndicator;
  }
  if (typeof options.autoRestart === 'boolean') next.autoRestart = options.autoRestart;
  if (typeof options.voiceCommands === 'boolean') next.voiceCommands = options.voiceCommands;
  if (typeof options.numbersAsDigits === 'boolean') next.numbersAsDigits = options.numbersAsDigits;
  if (isLanguage(options.selectedLanguage)) next.selectedLanguage = options.selectedLanguage;
  if (isRecognitionModePreference(options.preferredRecognitionMode)) {
    next.preferredRecognitionMode = options.preferredRecognitionMode;
  }
  if (isTheme(options.theme)) next.theme = options.theme;
  if (isTranscriptionProvider(options.dictationProvider)) next.dictationProvider = options.dictationProvider;
  if (options.geminiModel !== undefined) next.geminiModel = sanitizeGeminiModel(options.geminiModel);
  if (isTranscriptionLanguage(options.transcriptionLanguage)) {
    next.transcriptionLanguage = options.transcriptionLanguage;
  }
  if (isTranscriptionMode(options.transcriptionMode)) next.transcriptionMode = options.transcriptionMode;
  if (options.transcriptionVocabulary !== undefined) {
    next.transcriptionVocabulary = sanitizeVocabularyTerms(options.transcriptionVocabulary);
  }
  if (options.bookmarkedLanguages !== undefined) {
    next.bookmarkedLanguages = sanitizeLanguageBookmarks(options.bookmarkedLanguages);
  }
  if (options.customCommands !== undefined) {
    next.customCommands = sanitizeCustomCommands(options.customCommands);
  }
  if (options.languageSwitchShortcut !== undefined) {
    next.languageSwitchShortcut = sanitizeShortcut(options.languageSwitchShortcut);
  }
  return next;
}

/**
 * Validates a stored custom-commands list: drops malformed entries, trims
 * phrases, caps the list size. Valid shape is `{ phrase, replacement }` with
 * a non-empty phrase; an empty replacement is allowed (mutes the phrase).
 */
export function sanitizeCustomCommands(value: unknown): CustomVoiceCommand[] {
  if (!Array.isArray(value)) return [];
  const result: CustomVoiceCommand[] = [];
  for (const entry of value) {
    if (result.length >= MAX_CUSTOM_COMMANDS) break;
    if (!entry || typeof entry !== 'object') continue;
    const candidate = entry as { phrase?: unknown; replacement?: unknown };
    if (typeof candidate.phrase !== 'string') continue;
    const phrase = candidate.phrase.trim();
    if (phrase.length === 0) continue;
    const replacement = typeof candidate.replacement === 'string' ? candidate.replacement : '';
    result.push({ phrase, replacement });
  }
  return result;
}

/** Load user preferences from chrome.storage.local with safe defaults. */
export async function loadPrefs(): Promise<Prefs> {
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    const raw = stored[STORAGE_KEY] as (Partial<Prefs> & Record<string, unknown>) | undefined;
    return {
      selectedLanguage: isLanguage(raw?.selectedLanguage) ? raw.selectedLanguage : DEFAULT_PREFS.selectedLanguage,
      preferredRecognitionMode: raw ? migrateRecognitionMode(raw) : DEFAULT_PREFS.preferredRecognitionMode,
      autoRestart: typeof raw?.autoRestart === 'boolean' ? raw.autoRestart : DEFAULT_PREFS.autoRestart,
      showStatusIndicator: typeof raw?.showStatusIndicator === 'boolean'
        ? raw.showStatusIndicator
        : DEFAULT_PREFS.showStatusIndicator,
      voiceCommands: typeof raw?.voiceCommands === 'boolean' ? raw.voiceCommands : DEFAULT_PREFS.voiceCommands,
      numbersAsDigits:
        typeof raw?.numbersAsDigits === 'boolean' ? raw.numbersAsDigits : DEFAULT_PREFS.numbersAsDigits,
      bookmarkedLanguages: Array.isArray(raw?.bookmarkedLanguages)
        ? sanitizeLanguageBookmarks(raw?.bookmarkedLanguages)
        : [...DEFAULT_PREFS.bookmarkedLanguages],
      languageSwitchShortcut: loadSwitchShortcut(raw?.languageSwitchShortcut),
      customCommands: sanitizeCustomCommands(raw?.customCommands),
      theme: isTheme(raw?.theme) ? raw.theme : DEFAULT_PREFS.theme,
      dictationProvider: isTranscriptionProvider(raw?.dictationProvider)
        ? raw.dictationProvider
        : DEFAULT_PREFS.dictationProvider,
      geminiModel: migrateGeminiModel(sanitizeGeminiModel(raw?.geminiModel)),
      transcriptionLanguage: isTranscriptionLanguage(raw?.transcriptionLanguage)
        ? raw.transcriptionLanguage
        : DEFAULT_PREFS.transcriptionLanguage,
      transcriptionMode: isTranscriptionMode(raw?.transcriptionMode)
        ? raw.transcriptionMode
        : DEFAULT_PREFS.transcriptionMode,
      transcriptionVocabulary: sanitizeVocabularyTerms(raw?.transcriptionVocabulary),
    };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

/** Merge-persist a partial preference update. Never throws. */
export async function savePrefs(partial: Partial<Prefs>): Promise<void> {
  try {
    // Base the stored object on FRESH storage, never on an in-memory
    // snapshot — multiple writers (options page, content script, service
    // worker) would otherwise resurrect each other's stale fields.
    const current = await loadPrefs();
    await chrome.storage.local.set({ [STORAGE_KEY]: { ...current, ...partial } });
  } catch {
    // Storage unavailable (e.g. context invalidated) — preferences are not critical.
  }
}

/** Persisted floating-badge position in pixels (top-left of the badge). */
export interface BadgePosition {
  x: number;
  y: number;
}

const BADGE_POSITION_KEY = 'badgePosition';

/** Loads the remembered badge position; null when none was saved. Never throws. */
export async function loadBadgePosition(): Promise<BadgePosition | null> {
  try {
    const stored = (await chrome.storage.local.get(BADGE_POSITION_KEY))[BADGE_POSITION_KEY] as
      | Partial<BadgePosition>
      | undefined;
    if (!stored) return null;
    const { x, y } = stored;
    if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) {
      return null;
    }
    return { x, y };
  } catch {
    return null;
  }
}

/** Remembers the badge position after a drag. Never throws. */
export async function saveBadgePosition(position: BadgePosition): Promise<void> {
  try {
    await chrome.storage.local.set({ [BADGE_POSITION_KEY]: position });
  } catch {
    // Storage unavailable — the badge just falls back to its default spot.
  }
}
