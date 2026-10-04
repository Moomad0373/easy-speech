import {
  DEFAULT_GEMINI_MODEL,
  GEMINI_API_KEY_STORAGE_KEY,
  GEMINI_API_ORIGIN,
  GEMINI_INTERACTIONS_PATH,
  GEMINI_MODELS_PATH,
  GEMINI_TRACE,
  MAX_API_KEY_LENGTH,
  MAX_RECORDING_BYTES,
} from '../shared/constants';
import type {
  GeminiStatusResponse,
  GeminiTranscribeResponse,
  VerifyGeminiKeyResponse,
} from '../shared/messaging';
import { buildTranscriptionConfig, sanitizeTranscriptionSettings, type TranscriptionSettings } from '../shared/transcription';
import { readTokenUsage, recordUsage } from '../shared/usage';

const MAX_BASE64_LENGTH = Math.ceil(MAX_RECORDING_BYTES * 4 / 3) + 1024;

function normalizeModel(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_GEMINI_MODEL;
  const model = value.trim();
  return /^[A-Za-z0-9._-]{1,100}$/.test(model) ? model : DEFAULT_GEMINI_MODEL;
}

export async function getGeminiApiKey(): Promise<string | null> {
  const stored = await chrome.storage.local.get(GEMINI_API_KEY_STORAGE_KEY);
  const value = stored[GEMINI_API_KEY_STORAGE_KEY];
  if (typeof value !== 'string') return null;
  const apiKey = value.trim();
  return apiKey.length > 0 && apiKey.length <= MAX_API_KEY_LENGTH ? apiKey : null;
}

export async function getGeminiStatus(model = DEFAULT_GEMINI_MODEL): Promise<GeminiStatusResponse> {
  return {
    ok: true,
    configured: (await getGeminiApiKey()) !== null,
    model: normalizeModel(model),
  };
}

export async function saveGeminiApiKey(value: unknown): Promise<GeminiStatusResponse> {
  if (typeof value !== 'string') throw new Error('API key must be text.');
  const apiKey = value.trim();
  if (apiKey.length === 0 || apiKey.length > MAX_API_KEY_LENGTH) {
    throw new Error('Enter a valid Google API key.');
  }
  await chrome.storage.local.set({ [GEMINI_API_KEY_STORAGE_KEY]: apiKey });
  return getGeminiStatus();
}

export async function clearGeminiApiKey(): Promise<GeminiStatusResponse> {
  await chrome.storage.local.remove(GEMINI_API_KEY_STORAGE_KEY);
  return getGeminiStatus();
}

/**
 * Checks a candidate key with the cheapest authenticated call Google offers —
 * `GET /v1beta/models`, one result. No audio is sent and nothing is billed.
 *
 * This exists because a public user base mistypes keys constantly, and being
 * told the key was never valid only AFTER recording a paragraph and waiting for
 * a transcript is the worst possible moment to find out. The typed key is
 * checked before it is saved, so the mistake costs a click instead of a take.
 *
 * `candidate` is the key still sitting in the settings input. It becomes a
 * header on exactly one request and is never written to storage; an empty
 * candidate re-checks the key already saved.
 */
export async function verifyGeminiApiKey(candidate?: string): Promise<VerifyGeminiKeyResponse> {
  const typed = typeof candidate === 'string' ? candidate.trim() : '';
  const apiKey = typed.length > 0 ? typed : await getGeminiApiKey();
  if (!apiKey || apiKey.length > MAX_API_KEY_LENGTH) {
    return { ok: false, error: 'missing-key', message: 'Enter a Google API key first.' };
  }

  let response: Response;
  try {
    response = await fetch(`${GEMINI_API_ORIGIN}${GEMINI_MODELS_PATH}?pageSize=1`, {
      method: 'GET',
      headers: { 'x-goog-api-key': apiKey },
    });
  } catch {
    // Naming the host matters here: this is the exact failure a user on a
    // blocked network gets, and "check your connection" would send them hunting
    // for a problem they do not have.
    return {
      ok: false,
      error: 'network',
      message:
        "Google's API could not be reached. This mode needs access to generativelanguage.googleapis.com, which some networks block.",
    };
  }

  if (response.ok) return { ok: true };

  const body = await response.text().catch(() => '');
  const mapped = apiError(response.status, body, apiKey);
  // Mapped through the same helper a real transcription failure uses, so the
  // message the user reads here is the message they would have read mid-dictation.
  const error = mapped.error === 'auth' || mapped.error === 'quota' ? mapped.error : 'api';
  return { ok: false, error, message: mapped.message };
}

interface GeminiResponsePart {
  text?: unknown;
  audioTranscription?: { text?: unknown };
}

/**
 * Reads a generateContent payload in either transcript shape:
 *  - `part.text` — general-purpose models such as gemini-3.5-flash-lite;
 *  - `part.audioTranscription.text` — the dedicated gemini-3.5-transcribe
 *    model, which leaves `part.text` empty while still reporting a STOP
 *    finish reason, so reading only `text` reports every recording as
 *    "Gemini returned no transcript".
 * The structured field wins when both appear.
 *
 * The Interactions API answers with `output_text` (see
 * parseTranscriptionResponse); this reader covers the generateContent shape
 * as a fallback so a model that is pointed at by mistake still returns its
 * transcript instead of an empty error.
 */
function extractCandidatesTranscript(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return '';
  const candidates = (payload as { candidates?: unknown }).candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) return '';
  const first = candidates[0];
  if (!first || typeof first !== 'object') return '';
  const content = (first as { content?: unknown }).content;
  if (!content || typeof content !== 'object') return '';
  const parts = (content as { parts?: unknown }).parts;
  if (!Array.isArray(parts)) return '';
  const fields = parts.map((part) => {
    if (!part || typeof part !== 'object') return { plain: '', transcription: '' };
    const typed = part as GeminiResponsePart;
    const structured = typed.audioTranscription?.text;
    return {
      plain: typeof typed.text === 'string' ? typed.text : '',
      transcription: typeof structured === 'string' ? structured : '',
    };
  });
  const transcription = fields.map((field) => field.transcription).join('');
  if (transcription.trim() !== '') return transcription.trim();
  return fields
    .map((field) => field.plain)
    .join('')
    .trim();
}

function emptyResponseMessage(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return 'Gemini returned no transcript.';
  const candidates = (payload as { candidates?: unknown }).candidates;
  const first = Array.isArray(candidates) && candidates[0] && typeof candidates[0] === 'object'
    ? candidates[0] as { finishReason?: unknown; safetyRatings?: unknown }
    : null;
  const feedback = (payload as { promptFeedback?: { blockReason?: unknown } }).promptFeedback;
  const reason = typeof first?.finishReason === 'string'
    ? first.finishReason
    : typeof feedback?.blockReason === 'string'
      ? feedback.blockReason
      : null;
  return reason ? `Gemini returned no transcript (${reason}).` : 'Gemini returned no transcript.';
}

/** Google's own error text is shown to the user; keep it short enough to read. */
const MAX_ERROR_DETAIL_LENGTH = 240;

/**
 * Google's `{ error: { message } }` from a failed response, capped and with the
 * API key redacted — or null when the body is absent or not that shape.
 */
function googleErrorDetail(body: string, apiKey: string | null): string | null {
  if (!body) return null;
  let message: string | null = null;
  try {
    const candidate = (JSON.parse(body) as { error?: { message?: unknown } } | null)?.error?.message;
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      message = candidate.trim();
    }
  } catch {
    return null;
  }
  if (message === null) return null;
  // Google does not echo the key back, but this string is rendered in the UI and
  // the promise that the key never leaves storage should not depend on the
  // server's good manners. The length floor matters: a real key is ~39 chars,
  // while a one-character paste would otherwise shred the whole message.
  if (apiKey && apiKey.length >= 8) message = message.split(apiKey).join('[redacted]');
  if (message.length > MAX_ERROR_DETAIL_LENGTH) {
    message = `${message.slice(0, MAX_ERROR_DETAIL_LENGTH - 1)}…`;
  }
  return message;
}

/**
 * Maps a failed HTTP status to a message the user can act on.
 *
 * 400 and 404 carry Google's actual reason — an unknown model, an unsupported
 * audio container, a rejected transcription_config. Everyone using this with
 * their own key will hit those, and a single generic "could not transcribe"
 * leaves them no way to work out what to change, so the server's own text is
 * surfaced rather than swallowed.
 */
function apiError(status: number, body: string, apiKey: string | null): GeminiTranscribeResponse {
  if (status === 401 || status === 403) {
    return { ok: false, error: 'auth', message: 'The Google API key was rejected.' };
  }
  if (status === 429) {
    return { ok: false, error: 'quota', message: 'The Gemini API quota is unavailable right now.' };
  }
  return {
    ok: false,
    error: 'api',
    message: googleErrorDetail(body, apiKey) ?? 'Gemini could not transcribe this recording.',
  };
}

/**
 * The transcription request: a direct call to Google's Interactions API,
 * authenticated with the user's own key.
 *
 * `transcription_config` — the language hint, the verbatim/smart mode and the
 * custom vocabulary — is only accepted here, inside `generation_config`;
 * `models/{model}:generateContent` has no such field. The clip travels inline
 * as base64 (`input[].data`), which the API documents for audio well under its
 * size ceiling, so no File API upload is needed.
 *
 * There is deliberately no free-text prompt: the previous "transcribe this,
 * the expected language is فارسی" wording is exactly what language_codes
 * replaces, and a prompt could only contradict the structured config.
 */
async function requestDirectTranscription(
  input: { data: string; mimeType: string; transcription: TranscriptionSettings },
  apiKey: string,
  model: string
): Promise<Response> {
  const body = {
    model,
    input: [
      {
        type: 'audio',
        data: input.data,
        mime_type: input.mimeType || 'audio/webm',
      },
    ],
    generation_config: {
      transcription_config: buildTranscriptionConfig(input.transcription),
    },
  };
  return fetch(`${GEMINI_API_ORIGIN}${GEMINI_INTERACTIONS_PATH}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
    },
    body: JSON.stringify(body),
  });
}

/**
 * Accepts every transcript shape the Interactions API is documented to answer
 * with and normalizes it to GeminiTranscribeResponse:
 *   - `output_text`                    the documented Interactions field
 *   - `interaction.output_text`        the SDK-forwarded equivalent
 *   - `candidates[].content.parts[]`   the generateContent shape, where the
 *                                       dedicated transcription model answers
 *                                       under `audioTranscription.text`
 *
 * A body that is none of these is an error, never a transcript. It is never
 * treated as plain text to insert either: an unparseable body from a public
 * endpoint is far more likely to be a proxy's HTML error page than anyone's
 * speech, and inserting that into the field the user was typing in would be
 * unrecoverable.
 */
async function parseTranscriptionResponse(response: Response): Promise<GeminiTranscribeResponse> {
  const raw = (await response.text().catch(() => '')).trim();
  let payload: unknown = null;
  if (raw.startsWith('{') || raw.startsWith('[')) {
    try {
      payload = JSON.parse(raw);
    } catch {
      payload = null;
    }
  }

  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const record = payload as Record<string, unknown>;
    // Read before any early return: a request that failed still consumed
    // quota, and the Settings counters must reflect it.
    const usage = readTokenUsage(payload);
    // `output_text` is the documented Interactions field; the nested
    // `interaction.output_text` is its object-forwarded equivalent.
    const transcript = [record.output_text, (record.interaction as { output_text?: unknown } | undefined)?.output_text]
      .find((value): value is string => typeof value === 'string' && value.trim().length > 0);
    if (transcript !== undefined) return { ok: true, text: transcript.trim(), ...(usage ? { usage } : {}) };
    const geminiText = extractCandidatesTranscript(payload);
    if (geminiText) return { ok: true, text: geminiText, ...(usage ? { usage } : {}) };
    if (Array.isArray(record.candidates) || record.promptFeedback !== undefined) {
      return { ok: false, error: 'empty', message: emptyResponseMessage(payload), ...(usage ? { usage } : {}) };
    }
  }

  return { ok: false, error: 'api', message: 'Gemini returned an unreadable response.' };
}

/**
 * Development trace (GEMINI_TRACE): surfaces the transcription flow in the
 * service worker console so request → response can be followed live. Logs
 * metadata and server answers only — never the API key itself.
 */
function trace(...parts: unknown[]): void {
  if (GEMINI_TRACE) console.info('[VoiceType gemini]', ...parts);
}

/** Non-reversible fingerprint (SHA-256 prefix + length) for comparing keys. */
async function keyFingerprint(key: string): Promise<string> {
  try {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
    const hex = [...new Uint8Array(digest).slice(0, 6)]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
    return `${hex} (len=${key.length})`;
  } catch {
    return `(len=${key.length})`;
  }
}

export async function transcribeAudio(input: {
  data: string;
  mimeType: string;
  transcription?: TranscriptionSettings;
  model: string;
  requestId?: string;
}): Promise<GeminiTranscribeResponse> {
  const apiKey = await getGeminiApiKey();
  if (!apiKey) {
    trace('blocked before request: no API key saved in Settings');
    return { ok: false, error: 'missing-key', message: 'Add a Google API key in Settings first.' };
  }
  if (typeof input.data !== 'string' || input.data.length === 0 || input.data.length > MAX_BASE64_LENGTH) {
    trace('blocked before request: audio too large', { base64Chars: typeof input.data === 'string' ? input.data.length : 0 });
    return { ok: false, error: 'size', message: 'The recording is too large. Record a shorter clip.' };
  }

  // The message reaches the service worker from a content script running in an
  // arbitrary web page, so the settings are sanitized here — at the boundary
  // that actually builds the request — rather than trusted from the sender.
  const transcription = sanitizeTranscriptionSettings(input.transcription);
  const model = normalizeModel(input.model);
  trace('request →', {
    endpoint: `${GEMINI_API_ORIGIN}${GEMINI_INTERACTIONS_PATH}`,
    model,
    transcription,
    audioBase64Chars: input.data.length,
    requestId: input.requestId ?? null,
    keyFingerprint: await keyFingerprint(apiKey),
  });

  const request = { data: input.data, mimeType: input.mimeType, transcription, requestId: input.requestId };
  let response: Response;
  try {
    response = await requestDirectTranscription(request, apiKey, model);
  } catch (error) {
    trace('network failure →', error instanceof Error ? `${error.name}: ${error.message}` : String(error));
    return {
      ok: false,
      error: 'network',
      message: 'The Gemini API could not be reached. Check your internet connection.',
    };
  }

  trace('response ←', { status: response.status, statusText: response.statusText });
  if (!response.ok) {
    // Read here rather than inside the parser: the success path consumes the
    // body itself, and on this path it never runs.
    const body = await response.text().catch(() => '');
    const mapped = apiError(response.status, body, apiKey);
    trace('mapped ←', mapped);
    return mapped;
  }
  const parsed = await parseTranscriptionResponse(response);
  // Counts and metadata only: the transcript itself is the user's speech and
  // has no business in a console log, even a development one.
  trace('result ←', { ...parsed, text: parsed.text === undefined ? undefined : `${parsed.text.length} chars` });
  // Recorded here, in the background, because this is the one place every
  // transcription passes through — recorded and uploaded alike — and because
  // it holds the model the user actually ran. A failed request is recorded too:
  // it consumed quota, and hiding that would put the counters out of step with
  // the bill. `recordUsage` never throws, so it cannot fail a transcription.
  await recordUsage({ usage: parsed.usage, model });
  return parsed;
}
