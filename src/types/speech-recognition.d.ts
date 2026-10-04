/**
 * Minimal typings for the Web Speech API surface used by this extension.
 *
 * We intentionally use our own names (`...Like`) and access the constructor
 * via globalThis (see speechApi.ts) instead of the bare global names, so this
 * never conflicts with lib.dom.d.ts and never crashes on Chrome versions that
 * lack parts of the API (e.g. `processLocally`, Chrome 139+).
 */

export interface SpeechRecognitionAlternativeLike {
  transcript: string;
  confidence: number;
}

export interface SpeechRecognitionResultLike {
  readonly isFinal: boolean;
  readonly length: number;
  [index: number]: SpeechRecognitionAlternativeLike | undefined;
}

export interface SpeechRecognitionResultListLike {
  readonly length: number;
  [index: number]: SpeechRecognitionResultLike | undefined;
}

export interface SpeechRecognitionEventLike {
  readonly resultIndex: number;
  readonly results: SpeechRecognitionResultListLike;
}

export interface SpeechRecognitionErrorEventLike {
  readonly error: string;
  readonly message?: string;
}

export interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  /** Chrome 139+: on-device recognition. Feature-detect via `'processLocally' in recognition`. */
  processLocally?: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onstart: ((event?: unknown) => void) | null;
  onaudiostart: ((event?: unknown) => void) | null;
  onsoundstart: ((event?: unknown) => void) | null;
  onspeechstart: ((event?: unknown) => void) | null;
  onspeechend: ((event?: unknown) => void) | null;
  onsoundend: ((event?: unknown) => void) | null;
  onaudioend: ((event?: unknown) => void) | null;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
  onnomatch: ((event?: unknown) => void) | null;
}

export interface SpeechRecognitionAvailableOptions {
  langs: string[];
  processLocally?: boolean;
  quality?: string;
}

export interface SpeechRecognitionStaticCtor {
  new (): SpeechRecognitionLike;
  /** Chrome 139+: e.g. returns 'available' | 'downloadable' | 'downloading' | 'unavailable'. */
  available?(options: SpeechRecognitionAvailableOptions): Promise<string>;
  /** Chrome 139+: downloads and installs an on-device language pack. */
  install?(options: SpeechRecognitionAvailableOptions): Promise<boolean> | boolean;
}
