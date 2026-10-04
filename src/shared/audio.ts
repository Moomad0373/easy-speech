/**
 * Audio-file support for the "transcribe an existing recording" flow.
 *
 * A file the user picks and a clip the in-page recorder captures travel the
 * same road from here on: base64 audio + a bare `audio/*` MIME type handed to
 * the transcription request. This module owns everything that differs BEFORE
 * that point — telling a usable audio file from an unusable one, and working
 * out its real type.
 *
 * Browsers report unreliable MIME types for picked files: `.m4a` often arrives
 * as `audio/x-m4a` or `audio/mp4`, `.wav` as `audio/wave` or `audio/x-wav`,
 * `.mp3` as `audio/mpeg` or `audio/mp3`, and uncommon formats arrive with an
 * empty type or `application/octet-stream`. The declared type is therefore
 * only trusted when it is a type the transcription API documents; otherwise
 * the file extension decides. Getting this wrong is not cosmetic — the type
 * is sent to the model as part of the request.
 */
import { MAX_RECORDING_BYTES } from './constants';

/** Same ceiling as a live recording: one transcription request, one clip. */
export const MAX_AUDIO_FILE_BYTES = MAX_RECORDING_BYTES;

/**
 * Audio types the transcription API documents. Anything else is resolved from
 * the file extension instead, so a browser-specific alias never reaches the
 * request as-is.
 */
const DOCUMENTED_AUDIO_MIME_TYPES: ReadonlySet<string> = new Set([
  'audio/aac',
  'audio/flac',
  'audio/m4a',
  'audio/mp3',
  'audio/mp4',
  'audio/mpeg',
  'audio/ogg',
  'audio/wav',
  'audio/webm',
  'audio/x-m4a',
  'audio/x-pn-realaudio',
  'audio/x-pn-realaudio-plain',
  'audio/x-wav',
]);

/** Canonical type per extension, used when the declared type is unusable. */
const EXTENSION_MIME_TYPES: Readonly<Record<string, string>> = {
  aac: 'audio/aac',
  amr: 'audio/amr',
  flac: 'audio/flac',
  m4a: 'audio/mp4',
  m4b: 'audio/mp4',
  mp3: 'audio/mp3',
  mp4: 'audio/mp4',
  mpga: 'audio/mpeg',
  oga: 'audio/ogg',
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
  wav: 'audio/wav',
  wave: 'audio/wav',
  webm: 'audio/webm',
  '3gp': 'audio/3gpp',
  '3gpp': 'audio/3gpp',
};

/**
 * `accept` attribute for the file input: every `audio/*` the OS knows about,
 * plus the extensions above so a file whose type the browser cannot report is
 * still selectable. Selection is validated again in code — `accept` only
 * filters the picker, it is not a guarantee.
 */
export const AUDIO_FILE_ACCEPT = `audio/*, ${Object.keys(EXTENSION_MIME_TYPES)
  .map((extension) => `.${extension}`)
  .join(', ')}`;

/**
 * Browser-reported audio types that are the same format under another name.
 * Normalised to the documented spelling so the request is not refused over a
 * naming difference (Chrome reports `.wav` files as `audio/wave`).
 */
const AUDIO_MIME_ALIASES: Readonly<Record<string, string>> = {
  'audio/wave': 'audio/wav',
  'audio/x-pn-wav': 'audio/wav',
  'audio/vnd.wave': 'audio/wav',
  'audio/mp3': 'audio/mp3',
  'audio/x-mpeg': 'audio/mpeg',
  'audio/m4b': 'audio/mp4',
};

/**
 * Types that say nothing about the content, so the file extension gets the
 * final say. Everything else the browser reports is believed: a file declared
 * as video or as a document is not audio, whatever it is called.
 */
const UNINFORMATIVE_MIME_TYPES: ReadonlySet<string> = new Set([
  'application/octet-stream',
  'binary/octet-stream',
]);

/** Lowercase extension of `fileName`, without the dot ('' when there is none). */
export function audioFileExtension(fileName: string): string {
  const name = fileName.trim().toLowerCase();
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return '';
  return name.slice(dot + 1);
}

/**
 * The audio MIME type to send for `fileName`, or null when the file is not a
 * recognisable audio file.
 *
 * Order matters:
 *  1. A documented `audio/*` type the browser reports is used as-is, so the
 *     extension never second-guesses a type the OS vouched for.
 *  2. Another `audio/*` type is still audio, so it is passed through under its
 *     canonical name when one is known — refusing a `.wav` because the browser
 *     spelled it `audio/wave` would be a pointless dead end.
 *  3. Any type that is NOT audio ends the search. A video named `.mp4` is a
 *     video: uploading it as audio would waste the user's time and mislabel
 *     the request.
 *  4. Only when the browser says nothing (an empty or generic type, which is
 *     what uncommon containers usually produce) does the extension decide.
 */
export function resolveAudioMimeType(fileName: string, declaredType?: string | null): string | null {
  const declared = (declaredType ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  if (DOCUMENTED_AUDIO_MIME_TYPES.has(declared)) return declared;
  if (declared.startsWith('audio/') && declared.length > 'audio/'.length) {
    return AUDIO_MIME_ALIASES[declared] ?? declared;
  }
  if (declared !== '' && !UNINFORMATIVE_MIME_TYPES.has(declared)) return null;
  return EXTENSION_MIME_TYPES[audioFileExtension(fileName)] ?? null;
}

/** True when the file can be sent for transcription. */
export function isSupportedAudioFile(fileName: string, declaredType?: string | null): boolean {
  return resolveAudioMimeType(fileName, declaredType) !== null;
}

/** Human-readable size for the file summary (e.g. "2.4 MB"). */
export function formatAudioFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 ? Math.round(value) : Math.round(value * 10) / 10} ${units[unit]}`;
}

/** Formats listed in the picker's hint, for the upload UI. */
export const AUDIO_FILE_FORMAT_HINT = 'MP3, M4A, WAV, WebM, OGG, FLAC, AAC';

/**
 * Base64 audio as sent over extension messaging. Chunked so a multi-megabyte
 * clip does not build one enormous argument list.
 */
export async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

/** Inverse of blobToBase64: rebuilds the clip the user picked. */
export function base64ToBlob(base64: string, mimeType: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Blob([bytes], { type: mimeType });
}
