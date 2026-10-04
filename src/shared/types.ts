/**
 * Core domain types shared between the popup, content script, and service
 * worker. Architectural principle: Speech Recognition ≠ Transcript Management
 * ≠ Cursor/Selection Management ≠ Text Insertion ≠ UI ≠ Chrome Messaging.
 */
import { SUPPORTED_LANGUAGES } from './constants';

/** Any dictation language in the catalog (see SUPPORTED_LANGUAGES). */
export type Language = (typeof SUPPORTED_LANGUAGES)[number];

export type TranscriptionProvider = 'voiceTyping' | 'gemini';

/** How recognition is performed for the active session. */
export type RecognitionMode = 'local' | 'cloud';

/**
 * User preference for how on-device recognition is used, for ANY language:
 * 'auto' uses the local pack when Chrome reports it available, 'local' insists
 * on on-device (falling back to cloud only when the pack is not ready), and
 * 'cloud' never tries on-device.
 */
export type RecognitionModePreference = 'auto' | 'local' | 'cloud';

/**
 * Language selection for the Voice Transcribing engine. A fixed BCP-47 code
 * biases the model towards that language; 'auto' omits the hint so the model
 * detects the language itself (and follows code-switching mid-clip).
 */
export type TranscriptionLanguage = Language | 'auto';

/**
 * Voice Transcribing output mode, per Google's TranscriptionConfig:
 * - 'verbatim' (the documented default) is a literal transcript — filler
 *   words, repetitions and false starts are preserved as spoken.
 * - 'smart' removes disfluencies and applies structured formatting.
 */
export type TranscriptionMode = 'verbatim' | 'smart';

/**
 * What one transcription cost, as Google reported it. `promptTokens` is what
 * was billed after caching, which is why `rawPromptTokens` is tracked
 * alongside it; `audioTokens` is the share of the prompt that was the
 * recording itself.
 */
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** Prompt tokens served from cache instead of being re-processed. */
  cachedTokens: number;
  /** Tokens spent on the model's deliberation. */
  thoughtTokens: number;
  /** Tokens spent on tools. */
  toolUseTokens: number;
  /** Portion of `promptTokens` attributed to the audio input. */
  audioTokens: number;
  /** Google's raw prompt count, which differs from `promptTokens` after caching. */
  rawPromptTokens: number;
}

/** Chrome's report about on-device (local) availability for a language. */
export type AvailabilityState =
  | 'available'
  | 'downloadable'
  | 'downloading'
  | 'unavailable'
  | 'unknown';

export type RecognitionState =
  | 'idle'
  | 'starting'
  | 'listening'
  | 'processing'
  | 'restarting'
  | 'error'
  | 'stopping';

export interface RecognitionErrorInfo {
  code: string;
  /** Human-readable message suitable for direct display in the UI. */
  message: string;
  /** Raw browser/internal error string, retained for diagnostics only. */
  raw?: string;
}

export type TargetKind = 'input' | 'textarea' | 'contenteditable' | 'none';

export interface TargetSummary {
  kind: TargetKind;
  selector: string;
  connected: boolean;
}

/**
 * A user-defined voice command: when the spoken transcript contains `phrase`,
 * it is replaced with `replacement` instead of being typed (spec §40). The
 * replacement supports `\n` (line break) and `\t` (tab) escapes.
 */
export interface CustomVoiceCommand {
  phrase: string;
  replacement: string;
}

/**
 * Cursor/selection context captured BEFORE recognition starts and kept up to
 * date after every insertion. Deliberately not re-derived from
 * document.activeElement, which may change during a dictation session.
 *
 * The optional preview fields track the live-dictation preview: interim
 * transcripts are written into the field as they arrive and replaced by the
 * final transcript. Form controls remember the previewed value range;
 * contenteditors remember the text node holding the preview.
 */
export type InsertionTarget =
  | {
      type: 'input';
      element: HTMLInputElement;
      start: number;
      end: number;
      previewStart?: number | null;
      previewEnd?: number | null;
      previewText?: string | null;
    }
  | {
      type: 'textarea';
      element: HTMLTextAreaElement;
      start: number;
      end: number;
      previewStart?: number | null;
      previewEnd?: number | null;
      previewText?: string | null;
    }
  | {
      type: 'contenteditable';
      element: HTMLElement;
      range: Range;
      previewNode?: Text | null;
      /** Exact string inserted for the live preview (site may re-parent it). */
      previewText?: string | null;
      /** Text offset of the preview start inside the editor (spec §14). */
      previewOffset?: number | null;
    };

export interface RecognitionStatus {
  state: RecognitionState;
  language: Language | null;
  mode: RecognitionMode | null;
  /** Why this mode was chosen (fallback explanations, etc.). */
  modeNote: string;
  /** Local (on-device) availability for the active/last-used language. */
  availability: AvailabilityState;
  sessionCount: number;
  restartCount: number;
  lastEvent: string;
  lastError: RecognitionErrorInfo | null;
  target: TargetSummary | null;
  interimTranscript: string;
  lastFinalTranscript: string;
  /** Final transcript that could not be inserted — never silently discarded. */
  uncommittedTranscript: string | null;
  /**
   * A short, transient note for the user — currently "copied to clipboard"
   * after a Voice Transcribing result. Surfaced briefly by the floating badge
   * and the popup rather than persisted, because it describes a moment, not
   * state. Null when there is nothing to say.
   */
  note: string | null;
  autoRestart: boolean;
  provider?: TranscriptionProvider;
}
