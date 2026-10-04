import type { SpeechRecognitionStaticCtor } from '../../types/speech-recognition';

/**
 * Returns the browser's SpeechRecognition constructor (SpeechRecognition or
 * webkitSpeechRecognition), or null when unavailable. We deliberately access
 * it via globalThis instead of the bare global name so it works in every
 * extension context and never throws on browsers/versions without the API.
 */
export function getSpeechRecognitionCtor(): SpeechRecognitionStaticCtor | null {
  const globalScope = globalThis as unknown as {
    SpeechRecognition?: SpeechRecognitionStaticCtor;
    webkitSpeechRecognition?: SpeechRecognitionStaticCtor;
  };
  return globalScope.SpeechRecognition ?? globalScope.webkitSpeechRecognition ?? null;
}
