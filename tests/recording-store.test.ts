import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The local recording store.
 *
 * IndexedDB arrives from `fake-indexeddb` as a fresh factory per test, and the
 * module under test is re-imported so its cached database handle and in-flight
 * chunk buffers do not leak between cases.
 */
async function loadStore() {
  vi.resetModules();
  return import('../src/background/recordingStore');
}

/** 'hello' → base64, to build a clip without dragging in Blob plumbing. */
function base64(text: string): string {
  return btoa(text);
}

beforeEach(async () => {
  const { IDBFactory } = await import('fake-indexeddb');
  globalThis.indexedDB = new IDBFactory() as unknown as IDBFactory;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('recordingStore', () => {
  it('reassembles a chunked save into one record', async () => {
    const store = await loadStore();
    store.beginSave('a');
    store.appendChunk('a', base64('hello '), { mimeType: 'audio/webm', model: 'gemini-x', createdAt: 1000 });
    store.appendChunk('a', base64('world'), { mimeType: 'audio/webm', model: 'gemini-x', createdAt: 1000 });
    const stored = await store.commitSave('a');

    expect(stored?.data).toBe(base64('hello world'));
    expect(stored?.bytes).toBe(11);
    expect(stored?.mimeType).toBe('audio/webm');
    expect(stored?.attempts).toBe(0);
    expect(store.isSaving('a')).toBe(false);
  });

  it('returns the audio for a retry, byte for byte', async () => {
    const store = await loadStore();
    const payload = base64('the user just spoke this');
    store.beginSave('b');
    store.appendChunk('b', payload, { mimeType: 'audio/webm', bytes: 24 });
    await store.commitSave('b');

    const read = await store.getRecording('b');
    expect(read?.data).toBe(payload);
  });

  it('reports a clip that never began instead of storing empty audio', async () => {
    const store = await loadStore();
    expect(store.appendChunk('ghost', base64('x'))).toBe(false);
    expect(await store.commitSave('ghost')).toBeNull();
    expect(await store.listRecordings()).toEqual([]);
  });

  it('refuses a commit with no audio at all', async () => {
    const store = await loadStore();
    store.beginSave('c');
    expect(await store.commitSave('c')).toBeNull();
    expect(await store.listRecordings()).toEqual([]);
  });

  it('abandons a partial save on abort', async () => {
    const store = await loadStore();
    store.beginSave('d');
    store.appendChunk('d', base64('half a recording'));
    store.abortSave('d');
    expect(await store.commitSave('d')).toBeNull();
    expect(await store.listRecordings()).toEqual([]);
  });

  it('lists newest first and never hands the audio to the UI', async () => {
    const store = await loadStore();
    for (const [id, at] of [['old', 1000], ['new', 5000], ['mid', 3000]] as const) {
      store.beginSave(id);
      store.appendChunk(id, base64(id), { createdAt: at, mimeType: 'audio/webm' });
      await store.commitSave(id);
    }
    const list = await store.listRecordings();
    expect(list.map((r) => r.id)).toEqual(['new', 'mid', 'old']);
    expect(list.every((r) => !('data' in r))).toBe(true);
  });

  it('deletes a single clip and clears them all', async () => {
    const store = await loadStore();
    for (const id of ['x', 'y']) {
      store.beginSave(id);
      store.appendChunk(id, base64(id));
      await store.commitSave(id);
    }
    await store.deleteRecording('x');
    expect((await store.listRecordings()).map((r) => r.id)).toEqual(['y']);
    await store.clearRecordings();
    expect(await store.listRecordings()).toEqual([]);
  });

  it('records why a retry failed so the UI can explain itself', async () => {
    const store = await loadStore();
    store.beginSave('e');
    store.appendChunk('e', base64('clip'));
    await store.commitSave('e');

    await store.markAttempt('e', 'The transcription request could not be completed.');
    const afterFirst = await store.listRecordings();
    expect(afterFirst[0]?.attempts).toBe(1);
    expect(afterFirst[0]?.lastError).toContain('could not be completed');

    await store.markAttempt('e', 'Still failing.');
    expect((await store.listRecordings())[0]?.attempts).toBe(2);
    // The audio must survive every failed attempt — that is the whole point.
    expect((await store.getRecording('e'))?.data).toBe(base64('clip'));
  });

  it('keeps the newest clips and drops the oldest beyond the cap', async () => {
    const store = await loadStore();
    const cap = store.MAX_STORED_RECORDINGS;
    for (let i = 0; i < cap + 2; i += 1) {
      const id = `clip-${i}`;
      store.beginSave(id);
      store.appendChunk(id, base64(`clip ${i}`), { createdAt: 1000 + i * 1000 });
      await store.commitSave(id);
    }
    const list = await store.listRecordings();
    expect(list).toHaveLength(cap);
    // Oldest first, so the two earliest ids are the ones evicted.
    expect(list.map((r) => r.id)).not.toContain('clip-0');
    expect(list.map((r) => r.id)).not.toContain('clip-1');
    expect(list[0]?.id).toBe(`clip-${cap + 1}`);
  });

  it('rejects a chunk sequence that would exceed the capture limit before buffering it', async () => {
    const store = await loadStore();
    // Mirror of the store's own base64 ceiling: MAX_RECORDING_BYTES inflated 4/3.
    const cap = Math.ceil((12 * 1024 * 1024 * 4) / 3) + 1024;
    const part = 'A'.repeat(Math.ceil(cap * 0.7));
    store.beginSave('over');
    expect(store.appendChunk('over', part)).toBe(true);
    expect(store.appendChunk('over', part)).toBe(false);
    // The kept part is still a legitimate clip and can commit normally.
    const stored = await store.commitSave('over');
    expect(stored?.data).toBe(part);
  });

  it('caps how many clips may be assembled at once', async () => {
    const store = await loadStore();
    for (let i = 1; i <= store.MAX_PENDING_SAVES; i += 1) {
      expect(store.beginSave('p' + i)).toBe(true);
    }
    expect(store.beginSave('overflow')).toBe(false);
    store.abortSave('p1');
    expect(store.beginSave('overflow')).toBe(true);
  });

  it('never stores audio larger than the capture limit', async () => {
    const store = await loadStore();
    // One base64 char encodes 3/4 of a byte, so this claims ~15 MB.
    const huge = 'A'.repeat(20 * 1024 * 1024);
    store.beginSave('big');
    store.appendChunk('big', huge, { createdAt: 1 });
    expect(await store.commitSave('big')).toBeNull();
    expect(await store.listRecordings()).toEqual([]);
  });
});
