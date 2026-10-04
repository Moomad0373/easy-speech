/**
 * Local copies of recordings that have not been transcribed yet.
 *
 * The problem this exists for: dictation is spoken, not typed, so a recording
 * that fails to transcribe cannot be reconstructed by the user. Re-recording a
 * paragraph because the network blipped is the single worst thing this
 * extension can ask of someone. So a captured clip is written here BEFORE it is
 * sent, kept while the request is in flight or has failed, and deleted the
 * moment a transcript comes back.
 *
 * Two implementation facts drive the design:
 *
 *  - This lives in the service worker, not the content script, and that is not
 *    a stylistic choice. A content script's IndexedDB belongs to the HOST PAGE
 *    — saving there would file the user's microphone audio inside the storage of
 *    whatever site they happened to be dictating into, where the site could
 *    read it. The worker's database belongs to the extension.
 *  - The audio therefore has to cross the messaging boundary, which is JSON:
 *    blobs do not survive it. It is base64-encoded and sent in chunks, so a
 *    12 MB clip is a sequence of ordinary messages rather than one enormous
 *    allocation that could take the worker down with it.
 *
 * Nothing here is uploaded. The database is local to the browser profile, and
 * the user can erase it from the Settings page at any time.
 */
import { MAX_RECORDING_BYTES } from '../shared/constants';

const DB_NAME = 'voice-type-recordings';
const DB_VERSION = 1;
const STORE = 'recordings';

/**
 * How many untranscribed clips to keep. Failures are the only case where a
 * clip survives, so this is a safety net against a user who records repeatedly
 * into a permanently broken configuration; the oldest goes first.
 */
export const MAX_STORED_RECORDINGS = 5;

/**
 * How many clips may be assembled at once. Only this extension's own content
 * scripts can start a save, so the cap is a memory guard against a bug (an
 * id that never commits) rather than a defence against an attacker — but it
 * bounds the worker's memory all the same.
 */
export const MAX_PENDING_SAVES = 8;

/**
 * Base64 ceiling derived from MAX_RECORDING_BYTES (4/3 inflation) with slack
 * for padding. Enforced at append time so a runaway chunk sequence cannot
 * balloon the worker's memory before commitSave's own check would run.
 */
const MAX_BASE64_CHARS = Math.ceil((MAX_RECORDING_BYTES * 4) / 3) + 1024;

/** Base64 characters per message. Big enough to be few, small enough to be safe. */
export const CHUNK_CHARS = 512 * 1024;

/** A clip on disk, with the audio still in it. */
export interface StoredRecording {
  id: string;
  createdAt: number;
  /** Decoded audio size, for display. */
  bytes: number;
  mimeType: string;
  model: string;
  attempts: number;
  lastError: string | null;
  /** Base64 audio, exactly as MediaRecorder produced it. */
  data: string;
}

/** The same record without the audio — what the UI is allowed to see. */
export type StoredRecordingInfo = Omit<StoredRecording, 'data'>;

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const open = indexedDB.open(DB_NAME, DB_VERSION);
    open.onupgradeneeded = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id' });
        // The list view is ordered newest-first and never reads the audio.
        store.createIndex('createdAt', 'createdAt');
      }
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => {
      // Do not cache a failed open: a later attempt should be able to retry.
      dbPromise = null;
      reject(open.error ?? new Error('Could not open the recording store'));
    };
  });
  return dbPromise;
}

/**
 * A clip being assembled from chunks. Held in the worker rather than written
 * incrementally so a completed save is a single atomic record: there is no
 * half-written clip for the UI to find, and nothing to clean up if a chunk is
 * lost. The worker is awake for the whole of this loop (it is answering these
 * messages), so the buffer cannot be evicted mid-save.
 */
const pending = new Map<string, { mimeType: string; bytes: number; model: string; createdAt: number; parts: string[] }>();

export function beginSave(id: string): boolean {
  if (pending.has(id)) return true;
  if (pending.size >= MAX_PENDING_SAVES) return false;
  pending.set(id, { mimeType: '', bytes: 0, model: '', createdAt: 0, parts: [] });
  return true;
}

/** Appends one base64 chunk; false for an unknown id or an over-long clip. */
export function appendChunk(id: string, data: string, meta?: { mimeType?: string; bytes?: number; model?: string; createdAt?: number }): boolean {
  const entry = pending.get(id);
  if (!entry) return false;
  // Reject the accumulation before buffering it — by the time commitSave
  // re-derives the size, the bytes are already in memory.
  let accumulated = data.length;
  for (const part of entry.parts) accumulated += part.length;
  if (accumulated > MAX_BASE64_CHARS) return false;
  entry.parts.push(data);
  if (meta) {
    if (typeof meta.mimeType === 'string') entry.mimeType = meta.mimeType;
    if (typeof meta.bytes === 'number') entry.bytes = meta.bytes;
    if (typeof meta.model === 'string') entry.model = meta.model;
    if (typeof meta.createdAt === 'number') entry.createdAt = meta.createdAt;
  }
  return true;
}

export function abortSave(id: string): void {
  pending.delete(id);
}

function info(record: StoredRecording): StoredRecordingInfo {
  const { data: _data, ...rest } = record;
  return rest;
}

async function put(record: StoredRecording): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE, 'readwrite');
  await request(tx.objectStore(STORE).put(record));
}

/** Keeps the newest MAX_STORED_RECORDINGS, dropping the rest. */
async function prune(): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE, 'readwrite');
  const store = tx.objectStore(STORE);
  const all = await request<StoredRecording[]>(store.getAll());
  if (all.length <= MAX_STORED_RECORDINGS) return;
  all.sort((a, b) => b.createdAt - a.createdAt);
  for (const record of all.slice(MAX_STORED_RECORDINGS)) store.delete(record.id);
}

/**
 * Finalize a chunked save. Returns the stored record, or null if the
 * assembly failed or the audio turned out to be unusable.
 */
export async function commitSave(id: string): Promise<StoredRecording | null> {
  const entry = pending.get(id);
  if (!entry) return null;
  pending.delete(id);

  const data = entry.parts.join('');
  entry.parts.length = 0;
  if (data.length === 0) return null;

  // base64 → bytes, without trusting the caller.
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  const bytes = Math.floor((data.length * 3) / 4) - padding;
  if (bytes <= 0 || bytes > MAX_RECORDING_BYTES) return null;

  const record: StoredRecording = {
    id,
    createdAt: entry.createdAt > 0 ? entry.createdAt : Date.now(),
    bytes,
    mimeType: entry.mimeType || 'audio/webm',
    model: entry.model,
    attempts: 0,
    lastError: null,
    data,
  };
  await put(record);
  await prune();
  return record;
}

export async function getRecording(id: string): Promise<StoredRecording | null> {
  const db = await openDb();
  const tx = db.transaction(STORE, 'readonly');
  const record = await request<StoredRecording | undefined>(tx.objectStore(STORE).get(id));
  return record ?? null;
}

export async function listRecordings(): Promise<StoredRecordingInfo[]> {
  const db = await openDb();
  const tx = db.transaction(STORE, 'readonly');
  const all = await request<StoredRecording[]>(tx.objectStore(STORE).getAll());
  return all
    .map(info)
    .sort((a, b) => b.createdAt - a.createdAt);
}

export async function deleteRecording(id: string): Promise<void> {
  abortSave(id);
  const db = await openDb();
  const tx = db.transaction(STORE, 'readwrite');
  await request(tx.objectStore(STORE).delete(id));
}

export async function clearRecordings(): Promise<void> {
  pending.clear();
  const db = await openDb();
  const tx = db.transaction(STORE, 'readwrite');
  await request(tx.objectStore(STORE).clear());
}

/** Records that a retry failed, so the UI can explain why a clip is still here. */
export async function markAttempt(id: string, lastError: string | null): Promise<StoredRecordingInfo | null> {
  const record = await getRecording(id);
  if (!record) return null;
  const next: StoredRecording = { ...record, attempts: record.attempts + 1, lastError };
  await put(next);
  return info(next);
}

export async function markAttempted(id: string): Promise<StoredRecordingInfo | null> {
  return markAttempt(id, null);
}

/** True when a save is currently mid-flight (diagnostics and tests). */
export function isSaving(id: string): boolean {
  return pending.has(id);
}
