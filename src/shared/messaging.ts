import type {
  AvailabilityState,
  CustomVoiceCommand,
  Language,
  RecognitionMode,
  RecognitionModePreference,
  RecognitionStatus,
  TokenUsage,
  TranscriptionLanguage,
  TranscriptionMode,
  TranscriptionProvider,
} from './types';
import type { ThemePreference } from './storage';
import type { ShortcutSpec } from './shortcut';
import type { TranscriptionSettings } from './transcription';
import { CONTENT_SCRIPT_READY_POLL_MS, CONTENT_SCRIPT_READY_TIMEOUT_MS } from './constants';

/** Partial settings update pushed to content scripts (spec §20). */
export interface SetOptionsPayload {
  showStatusIndicator?: boolean;
  autoRestart?: boolean;
  voiceCommands?: boolean;
  numbersAsDigits?: boolean;
  bookmarkedLanguages?: Language[];
  languageSwitchShortcut?: ShortcutSpec | null;
  customCommands?: CustomVoiceCommand[];
  selectedLanguage?: Language;
  preferredRecognitionMode?: RecognitionModePreference;
  theme?: ThemePreference;
  dictationProvider?: TranscriptionProvider;
  geminiModel?: string;
  transcriptionLanguage?: TranscriptionLanguage;
  transcriptionMode?: TranscriptionMode;
  transcriptionVocabulary?: string[];
}

/** All messages flowing over chrome.runtime / chrome.tabs messaging. */
export type ExtensionMessage =
  | { type: 'START_RECOGNITION'; language: Language; preferredMode: RecognitionModePreference }
  | { type: 'START_GEMINI_RECORDING'; language: Language; model: string }
  | {
      /**
       * Transcribe a recording the user already has: the popup reads the
       * picked file, sends it as base64 audio, and the content script inserts
       * the transcript exactly like a live recording's.
       */
      type: 'TRANSCRIBE_AUDIO_FILE';
      data: string;
      mimeType: string;
      fileName: string;
      language: Language;
      model: string;
    }
  | { type: 'STOP_RECOGNITION' }
  | { type: 'GET_STATUS' }
  | ({ type: 'SET_OPTIONS' } & SetOptionsPayload)
  | { type: 'GET_MODE_PREVIEW'; language: Language }
  | { type: 'INSTALL_LANGUAGE_PACK'; language: Language }
  | { type: 'CYCLE_LANGUAGE' }
  | { type: 'RECOGNITION_STATUS'; status: RecognitionStatus };

export interface CycleLanguageResponse {
  ok: boolean;
  language: Language | null;
}

export interface StatusResponse {
  ok: boolean;
  status: RecognitionStatus;
}

export interface StartResponse {
  ok: boolean;
  reason?: 'no-target' | 'error' | 'gemini-key' | 'recording' | 'file';
  mode?: 'local' | 'cloud';
}

export interface GeminiStatusResponse {
  ok: boolean;
  configured: boolean;
  model: string;
}

export interface GeminiTranscribeResponse {
  ok: boolean;
  text?: string;
  error?: 'missing-key' | 'auth' | 'quota' | 'api' | 'network' | 'empty' | 'size';
  message?: string;
  /**
   * What the request cost, when Google reported it. Present on success AND on
   * failure — a request that returned no transcript still consumed quota, and
   * the Settings counters must show that. Absent means "not reported", which
   * is never the same as zero.
   */
  usage?: TokenUsage;
}

/** Answer to a save/delete/clear request against the local recording store. */
export interface RecordingStoreAck {
  ok: boolean;
  error?: string;
}

/** Metadata about a clip kept because it has not been transcribed yet. */
export interface StoredRecordingInfo {
  id: string;
  createdAt: number;
  bytes: number;
  mimeType: string;
  model: string;
  attempts: number;
  lastError: string | null;
}

export interface RecordingListResponse {
  ok: boolean;
  recordings: StoredRecordingInfo[];
}

/**
 * Answer to a retry. On success the clip is deleted from the store and the
 * transcript is returned; on failure the clip is kept, its attempt counter
 * advanced, and the reason is in `message`.
 */
export interface RecordingRetryResponse {
  ok: boolean;
  text?: string;
  error?: GeminiTranscribeResponse['error'];
  message?: string;
  attempts?: number;
}

/**
 * The local recording store. Audio is only ever written from the content
 * script (which captures it) and read back by the background (which
 * transcribes it), so every one of these is refused from a page context.
 *
 * `data` is a base64 CHUNK, not the whole clip: the messaging boundary is
 * JSON, so a large recording is sent as a sequence of ordinary messages rather
 * than one allocation big enough to threaten the worker.
 */
export type RecordingStoreMessage =
  | { type: 'RECORDING_SAVE_BEGIN'; id: string }
  | {
      type: 'RECORDING_SAVE_CHUNK';
      id: string;
      data: string;
      mimeType?: string;
      bytes?: number;
      model?: string;
      createdAt?: number;
    }
  | { type: 'RECORDING_SAVE_COMMIT'; id: string }
  | { type: 'RECORDING_SAVE_ABORT'; id: string }
  | { type: 'RECORDING_DELETE'; id: string }
  | { type: 'RECORDING_LIST' }
  | { type: 'RECORDING_CLEAR' }
  | { type: 'RECORDING_RETRY'; id: string };

export type GeminiRuntimeMessage =
  | { type: 'GET_GEMINI_STATUS' }
  | { type: 'SET_GEMINI_API_KEY'; apiKey: string }
  | { type: 'CLEAR_GEMINI_API_KEY' }
  | {
      /**
       * Check a candidate key with one cheap authenticated call, so a typo is
       * caught on the settings page instead of after a recording has been made.
       * The key still sitting in the input is sent along; the worker uses it as
       * a header on a single request and never persists it. Omit `apiKey` to
       * re-check the key already in storage.
       */
      type: 'VERIFY_GEMINI_API_KEY';
      apiKey?: string;
    }
  | {
      type: 'TRANSCRIBE_AUDIO';
      data: string;
      mimeType: string;
      /**
       * The Voice Transcribing settings chosen on the Settings page. The
       * service worker re-validates them (this message is sent by a content
       * script living in an arbitrary page) before building the request.
       */
      transcription: TranscriptionSettings;
      model: string;
      requestId: string;
    };

/**
 * Answer to VERIFY_GEMINI_API_KEY. Deliberately not GeminiTranscribeResponse:
 * this never carries a transcript or token usage, only whether the key works
 * and — when it does not — which of the few possible reasons applies.
 */
export interface VerifyGeminiKeyResponse {
  ok: boolean;
  error?: 'missing-key' | 'auth' | 'quota' | 'api' | 'network';
  message?: string;
}

/** Answer to GET_MODE_PREVIEW: honest capability report for the popup UI. */
export interface ModePreviewResponse {
  ok: boolean;
  /** True when the browser exposes the Web Speech API at all. */
  supported: boolean;
  /** True only on Chrome versions with on-device recognition APIs (139+). */
  onDeviceSupported: boolean;
  mode: RecognitionMode | null;
  availability: AvailabilityState;
  note: string;
  provider?: TranscriptionProvider;
  geminiConfigured?: boolean;
}

export interface InstallPackResponse {
  ok: boolean;
  preview: ModePreviewResponse;
}

/** Broadcast a status update from the content script to popup/SW. Never throws. */
export function broadcastStatus(status: RecognitionStatus): void {
  const message: ExtensionMessage = { type: 'RECOGNITION_STATUS', status };
  try {
    const pending = chrome.runtime.sendMessage(message);
    // Popup may be closed / SW may not care — swallow "receiving end" errors.
    if (pending && typeof pending.catch === 'function') pending.catch(() => {});
  } catch {
    // Extension context invalidated (e.g. reloaded) — nothing we can do.
  }
}

export async function getActiveTab(): Promise<chrome.tabs.Tab | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab ?? null;
}

/** Ask the content script for its status; returns null when not injected. */
export async function requestStatus(tabId: number): Promise<RecognitionStatus | null> {
  try {
    const response = (await chrome.tabs.sendMessage(tabId, {
      type: 'GET_STATUS',
    } satisfies ExtensionMessage)) as StatusResponse | undefined;
    return response?.status ?? null;
  } catch {
    return null;
  }
}

/**
 * Make sure the content script is present in the tab, injecting it on demand
 * (activeTab + scripting). Throws with a user-friendly message when Chrome
 * forbids injection (chrome://, Web Store, PDF viewer, ...) or when the
 * injected script never becomes responsive.
 */
export async function ensureContentScript(tabId: number): Promise<void> {
  if ((await requestStatus(tabId)) !== null) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content/content.js'],
    });
  } catch {
    throw new Error(
      'Chrome does not allow extensions to run on this page. Open a normal website (http/https) first.'
    );
  }
  // The injected script registers its message listeners during evaluation,
  // but that can lag executeScript's resolution by a tick (and a document in
  // its loading phase defers parts of setup). Poll instead of a fixed sleep:
  // fast in the normal case, deterministic in the slow one.
  const deadline = Date.now() + CONTENT_SCRIPT_READY_TIMEOUT_MS;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      if ((await requestStatus(tabId)) !== null) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, CONTENT_SCRIPT_READY_POLL_MS));
  }
  throw new Error(
    'The dictation helper could not start in this tab. Reload the page and try again.' +
      (lastError instanceof Error ? ` (${lastError.message})` : '')
  );
}

/** Fire-and-forget message to a tab; resolves null when there is no receiver. */
export async function sendToTab<T>(tabId: number, message: ExtensionMessage): Promise<T | null> {
  try {
    return (await chrome.tabs.sendMessage(tabId, message)) as T;
  } catch {
    return null;
  }
}
