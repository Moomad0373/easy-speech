import type { Language, RecognitionMode, TranscriptionProvider } from '../../../shared/types';
import type { TranscriptionSettings } from '../../../shared/transcription';

export interface EngineConfig {
  language: Language;
  mode: RecognitionMode;
  provider?: TranscriptionProvider;
  geminiModel?: string;
  /**
   * Voice Transcribing settings (language hint, verbatim/smart, custom
   * vocabulary). Only GeminiTranscribeEngine uses them; the Web Speech API
   * offers no equivalent, so live dictation ignores this field.
   */
  transcription?: TranscriptionSettings;
}

export interface EngineResult {
  /** For interim results (isFinal=false): the FULL pending utterance —
   *  engines must combine fragmented/revised browser results per event. */
  transcript: string;
  isFinal: boolean;
  confidence: number;
  replaces?: string;
}

export interface EngineError {
  code: string;
  message?: string;
}

export interface EngineCallbacks {
  onStart(): void;
  onResult(result: EngineResult): void;
  onError(error: EngineError): void;
  onEnd(): void;
  /**
   * A short, transient message for the user — a side effect worth telling them
   * about, such as a transcript being copied to the clipboard. Optional, so an
   * engine that has nothing to report can stay silent.
   */
  onNote?(note: string): void;
}

/**
 * Abstraction over a speech-to-text provider (spec §42). The first
 * implementation is WebSpeechEngine; a future local model (WhisperEngine,
 * GeminiTranscribeEngine, ...) can implement the same interface without
 * touching RecognitionManager, insertion adapters, or UI code.
 */
export interface SpeechEngine {
  readonly config: EngineConfig;
  start(): void;
  stop(): void;
  abort(): void;
}

export type EngineFactory = (config: EngineConfig, callbacks: EngineCallbacks) => SpeechEngine;
