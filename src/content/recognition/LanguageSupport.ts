import type {
  AvailabilityState,
  Language,
  RecognitionMode,
  RecognitionModePreference,
} from '../../shared/types';
import { getSpeechRecognitionCtor } from './speechApi';

const KNOWN_AVAILABILITY: readonly string[] = ['available', 'downloadable', 'downloading', 'unavailable'];

export interface ResolvedMode {
  mode: RecognitionMode;
  availability: AvailabilityState;
  /** Human-readable explanation of why this mode was chosen. Never hides fallbacks. */
  note: string;
}

/**
 * Detects local (on-device) recognition capabilities and resolves which mode
 * to use for ANY catalog language. On-device support is per language and per
 * Chrome install, so it is always queried for the requested language and the
 * answer is reported honestly — the resolver never assumes a language is
 * local-only or cloud-only.
 */
export class LanguageSupport {
  /** True when the browser exposes the Web Speech API at all. */
  static isSupported(): boolean {
    return getSpeechRecognitionCtor() !== null;
  }

  /** True only when Chrome exposes the on-device APIs (Chrome 139+). */
  static supportsOnDevice(): boolean {
    const ctor = getSpeechRecognitionCtor();
    if (!ctor || typeof ctor.available !== 'function' || typeof ctor.install !== 'function') {
      return false;
    }
    try {
      return 'processLocally' in new ctor();
    } catch {
      return false;
    }
  }

  /**
   * Checks local (on-device) availability for a language via
   * SpeechRecognition.available(). Returns 'unknown' when the API is missing
   * or misbehaves — availability is never guessed.
   */
  static async checkLanguageAvailability(language: Language): Promise<AvailabilityState> {
    const ctor = getSpeechRecognitionCtor();
    if (!ctor || typeof ctor.available !== 'function') return 'unknown';
    try {
      return normalizeAvailability(
        await ctor.available({ langs: [language], processLocally: true, quality: 'dictation' })
      );
    } catch {
      // Some Chrome builds may reject the `quality` option — retry without it.
      try {
        return normalizeAvailability(await ctor.available({ langs: [language], processLocally: true }));
      } catch {
        return 'unknown';
      }
    }
  }

  /**
   * Installs the local language pack when Chrome reports it as downloadable.
   * Returns true only when the pack is actually 'available' afterwards.
   */
  static async installLanguagePack(language: Language): Promise<boolean> {
    const ctor = getSpeechRecognitionCtor();
    if (!ctor || typeof ctor.install !== 'function') return false;
    try {
      await ctor.install({ langs: [language], processLocally: true });
    } catch {
      return false;
    }
    const availability = await LanguageSupport.checkLanguageAvailability(language);
    return availability === 'available';
  }

  /**
   * Resolves the authoritative recognition mode for a session, for any
   * language in the catalog:
   * - preference 'cloud': always cloud.
   * - Chrome reports the language 'available' on-device: local.
   * - otherwise: cloud fallback with the actual availability stated, so a
   *   language like Persian (no on-device pack) and an English install whose
   *   pack is missing are explained the same honest way.
   */
  static async getRecognitionMode(
    language: Language,
    preference: RecognitionModePreference
  ): Promise<ResolvedMode> {
    if (!LanguageSupport.isSupported()) {
      return { mode: 'cloud', availability: 'unknown', note: 'Web Speech API is not available in this browser.' };
    }

    if (preference === 'cloud') {
      return { mode: 'cloud', availability: 'unknown', note: 'Cloud recognition selected.' };
    }

    const availability = await LanguageSupport.checkLanguageAvailability(language);
    if (availability === 'available') {
      return { mode: 'local', availability, note: 'Local (on-device) recognition.' };
    }
    if (preference === 'local') {
      return {
        mode: 'cloud',
        availability,
        note: `Local recognition is not ready (${availability}); falling back to cloud recognition.`,
      };
    }
    if (availability === 'downloadable' || availability === 'downloading') {
      return {
        mode: 'cloud',
        availability,
        note: 'A local language pack can be installed; using cloud recognition until then.',
      };
    }
    if (availability === 'unavailable') {
      return {
        mode: 'cloud',
        availability,
        note: 'No on-device recognition for this language; using cloud (browser-managed) recognition.',
      };
    }
    return { mode: 'cloud', availability, note: 'On-device availability unknown; using cloud recognition.' };
  }
}

function normalizeAvailability(value: string): AvailabilityState {
  return KNOWN_AVAILABILITY.includes(value) ? (value as AvailabilityState) : 'unknown';
}
