import type { RecognitionState } from './types';

/**
 * States in which dictation is considered "running" — the popup toggle shows
 * Stop, and the toggle-dictation keyboard shortcut sends STOP_RECOGNITION.
 * Shared by the popup and the service worker so both agree on the semantics.
 */
export function isActiveState(state: RecognitionState | undefined): boolean {
  return (
    state === 'starting' ||
    state === 'listening' ||
    state === 'processing' ||
    state === 'restarting' ||
    state === 'stopping'
  );
}