/**
 * Languages dictation can target. The catalog is the union of Chrome's own
 * speech-demo list (the canonical cloud-recognition locale set) and the
 * community-maintained additions Chrome's speech service demonstrably accepts
 * (the Arabic regional variants, Persian, Hebrew). Persian and English lead
 * the array because they are the defaults; everything else is alphabetical.
 *
 * Membership here is a CATALOG, not a guarantee: on-device availability is
 * queried per language at runtime (see LanguageSupport), and a cloud language
 * the browser's speech service does not carry fails with the honest
 * 'language-not-supported' error rather than silently misbehaving.
 */
export const SUPPORTED_LANGUAGES = [
  'fa-IR',
  'en-US',
  'af-ZA',
  'am-ET',
  'ar-AE',
  'ar-BH',
  'ar-DZ',
  'ar-EG',
  'ar-IL',
  'ar-IQ',
  'ar-JO',
  'ar-KW',
  'ar-LB',
  'ar-LY',
  'ar-MA',
  'ar-OM',
  'ar-PS',
  'ar-QA',
  'ar-SA',
  'ar-TN',
  'ar-YE',
  'az-AZ',
  'bg-BG',
  'bn-BD',
  'bn-IN',
  'ca-ES',
  'cmn-Hans-CN',
  'cmn-Hans-HK',
  'cmn-Hant-TW',
  'cs-CZ',
  'da-DK',
  'de-DE',
  'el-GR',
  'en-AU',
  'en-CA',
  'en-GH',
  'en-GB',
  'en-IN',
  'en-IE',
  'en-KE',
  'en-NZ',
  'en-NG',
  'en-PH',
  'en-ZA',
  'en-TZ',
  'es-AR',
  'es-BO',
  'es-CL',
  'es-CO',
  'es-CR',
  'es-DO',
  'es-EC',
  'es-SV',
  'es-ES',
  'es-US',
  'es-GT',
  'es-HN',
  'es-MX',
  'es-NI',
  'es-PA',
  'es-PY',
  'es-PE',
  'es-PR',
  'es-UY',
  'es-VE',
  'eu-ES',
  'fi-FI',
  'fil-PH',
  'fr-FR',
  'gl-ES',
  'gu-IN',
  'he-IL',
  'hi-IN',
  'hr-HR',
  'hu-HU',
  'hy-AM',
  'id-ID',
  'is-IS',
  'it-IT',
  'it-CH',
  'ja-JP',
  'jv-ID',
  'ka-GE',
  'km-KH',
  'kn-IN',
  'ko-KR',
  'lo-LA',
  'lt-LT',
  'lv-LV',
  'ml-IN',
  'mr-IN',
  'ms-MY',
  'ne-NP',
  'nl-NL',
  'nb-NO',
  'pl-PL',
  'pt-BR',
  'pt-PT',
  'ro-RO',
  'ru-RU',
  'si-LK',
  'sk-SK',
  'sl-SI',
  'sr-RS',
  'su-ID',
  'sv-SE',
  'sw-KE',
  'sw-TZ',
  'ta-IN',
  'ta-LK',
  'ta-MY',
  'ta-SG',
  'te-IN',
  'th-TH',
  'tr-TR',
  'uk-UA',
  'ur-IN',
  'ur-PK',
  'vi-VN',
  'yue-Hant-HK',
  'zu-ZA',
] as const;
export const DEFAULT_GEMINI_MODEL = 'gemini-3.5-transcribe';
export const GEMINI_API_ORIGIN = 'https://generativelanguage.googleapis.com';
export const GEMINI_API_KEY_STORAGE_KEY = 'geminiApiKey';

/**
 * Transcription settings (language hint, verbatim/smart mode, custom
 * vocabulary) are only accepted in `generation_config.transcription_config`,
 * which the Gemini API documents on the Interactions endpoint — not on
 * `models/{model}:generateContent`. Inline base64 audio is accepted there
 * (`input[].data`), so clips never need a File API upload.
 */
export const GEMINI_INTERACTIONS_PATH = '/v1beta/interactions';

/**
 * Sanity ceiling for a pasted Google API key, enforced identically in the
 * service worker (which stores it) and the options page (which validates the
 * input before offering to save).
 */
export const MAX_API_KEY_LENGTH = 512;

/** Google's documented ceiling for TranscriptionConfig.custom_vocabulary. */
export const MAX_CUSTOM_VOCABULARY_TERMS = 1000;

/**
 * Per-term request-size guard, NOT an API limit (Google documents only the
 * 1,000-term ceiling). A term far longer than a word or short phrase is a
 * paste accident, and an unbounded term would bloat every transcription
 * request. Longer input is truncated.
 */
export const MAX_VOCABULARY_TERM_LENGTH = 200;

/**
 * The single endpoint this extension ever contacts. Transcription requests go
 * straight from the service worker to Google's Gemini API, authenticated with
 * the user's own API key — there is no intermediary server of any kind.
 *
 * The host is listed in manifest host_permissions, which is what lets the
 * background fetch cross origins without CORS. It is also the one privacy
 * boundary worth stating plainly: a user whose network cannot reach
 * generativelanguage.googleapis.com cannot use the Gemini recording mode. That
 * is honest and visible rather than papered over with a proxy, and it is
 * documented as a known limitation in the store listing.
 */
export const GEMINI_MODELS_PATH = '/v1beta/models';

/**
 * Development trace for the transcription path. When true, the service worker
 * logs each request/response to its console (chrome://extensions → Easy speech →
 * "Inspect views: service worker"). Traces never contain the API key — only its
 * length and a non-reversible SHA-256 fingerprint — so they are safe to read or
 * share. MUST be false in any published build.
 */
export const GEMINI_TRACE = false;
export const MAX_RECORDING_DURATION_MS = 5 * 60 * 1000;
export const MAX_RECORDING_BYTES = 12 * 1024 * 1024;

/**
 * How long a transcription request may take end to end — uploading the clip
 * and waiting for the transcript.
 *
 * The budget has to cover the slowest thing the user can legitimately do, not
 * the average one. At the 12 MB ceiling a clip takes a few minutes to push up
 * on a weak connection, and the model then needs time to process up to five
 * minutes of audio; the previous 90 s was below the floor, so a long recording
 * could never complete no matter how good the network was. Ten minutes clears
 * that with room to spare, and remains a real bound rather than an open wait.
 *
 * Nothing in the browser imposes this: the service worker stays alive for a
 * request in flight (an open message channel and a pending fetch both count as
 * activity, so the 30 s idle shutdown does not apply), and the content script
 * is only racing a timer of its own.
 */
export const GEMINI_TRANSCRIPTION_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Restart backoff schedule in ms, indexed by the number of consecutive
 * restarts that produced no results at all. Prevents the
 * start → immediate end → start → immediate end crash loop.
 */
export const RESTART_BACKOFF_MS = [150, 300, 600, 1200, 2500] as const;

/** Give up auto-restarting after this many consecutive result-less sessions. */
export const MAX_CONSECUTIVE_EMPTY_RESTARTS = 5;

/** Give up if more than this many restarts happen within RESTART_WINDOW_MS. */
export const MAX_RESTARTS_PER_WINDOW = 6;
export const RESTART_WINDOW_MS = 30_000;

/** After stop(), force abort() if the graceful flush hasn't finished. */
export const STOP_FLUSH_FAILSAFE_MS = 1500;

/** Throttle for interim status broadcasts (ms); state changes always go out. */
export const STATUS_BROADCAST_THROTTLE_MS = 120;

/**
 * After injecting the content script on demand, poll for its message
 * listener at this interval and give up (with a clear error) after the
 * timeout — replaces a fixed sleep that was both slow and race-prone.
 */
export const CONTENT_SCRIPT_READY_POLL_MS = 25;
export const CONTENT_SCRIPT_READY_TIMEOUT_MS = 2000;

/**
 * Recognition errors that mean "do not auto-restart; surface to the user".
 * ('no-speech', 'network' and non-user 'aborted' are treated as expected
 * lifecycle events and may be recovered from.)
 */
export const HARD_ERROR_CODES: ReadonlySet<string> = new Set([
  'not-allowed',
  'service-not-allowed',
  'audio-capture',
  'language-not-supported',
  'gemini-error',
]);
