import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Tests for the MV3 service worker's keyboard-command orchestration — most
 * importantly the language-cycle flow. Regression guard: the worker must only
 * FORWARD `CYCLE_LANGUAGE` to the tab. The content script owns the cycle
 * logic (it also serves the in-page shortcut); advancing/persisting here too
 * made Alt+Shift+L a no-op with two bookmarks (each side advanced once).
 */

const READY_STATUS = {
  ok: true,
  status: { state: 'idle', language: 'fa-IR', mode: null },
};

interface WorkerStub {
  tabMessages: Array<{ id: number; message: { type?: string } }>;
  executeScript: ReturnType<typeof vi.fn>;
  storageSet: ReturnType<typeof vi.fn>;
  sendMessage: ReturnType<typeof vi.fn>;
}

function stubChrome(options: {
  prefs?: unknown;
  statusBehavior?: 'ready' | 'not-injected-then-ready' | 'never-ready';
}): WorkerStub {
  const tabMessages: WorkerStub['tabMessages'] = [];
  const storageSet = vi.fn(async () => {});
  const executeScript = vi.fn(async () => {});
  let statusCalls = 0;

  const sendMessage = vi.fn(async (_tabId: number, message: { type?: string }) => {
    tabMessages.push({ id: _tabId, message });
    if (message.type === 'GET_STATUS') {
      statusCalls += 1;
      const behavior = options.statusBehavior ?? 'ready';
      if (behavior === 'ready') return READY_STATUS;
      if (behavior === 'never-ready') throw new Error('Receiving end does not exist');
      if (statusCalls === 1) throw new Error('Receiving end does not exist');
      return READY_STATUS;
    }
    return { ok: true };
  });

  vi.stubGlobal('chrome', {
    commands: { onCommand: { addListener: vi.fn() } },
    tabs: {
      query: vi.fn(async () => [{ id: 42 }]),
      sendMessage,
    },
    scripting: { executeScript },
    storage: {
      local: {
        get: vi.fn(async () => ({ prefs: options.prefs })),
        set: storageSet,
      },
    },
  });

  return { tabMessages, executeScript, storageSet, sendMessage };
}

/** Re-import the worker so its top-level command listener uses the fresh stub. */
async function loadWorker(): Promise<(command: string) => void> {
  vi.resetModules();
  await import('../src/background/service-worker');
  const chrome = globalThis.chrome as unknown as {
    commands: { onCommand: { addListener: ReturnType<typeof vi.fn> } };
  };
  const registration = chrome.commands.onCommand.addListener.mock.calls[0]?.[0];
  expect(registration, 'service worker registered a command listener').toBeTypeOf('function');
  return registration as (command: string) => void;
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('cycle-language command', () => {
  it('forwards CYCLE_LANGUAGE to the tab without advancing or persisting', async () => {
    const ctx = stubChrome({
      prefs: { selectedLanguage: 'fa-IR', bookmarkedLanguages: ['fa-IR', 'en-US'] },
      statusBehavior: 'ready',
    });
    const onCommand = await loadWorker();

    onCommand('cycle-language');

    await vi.waitFor(() => {
      expect(ctx.sendMessage).toHaveBeenCalledWith(42, { type: 'CYCLE_LANGUAGE' });
    });
    // The double-advance regression: persisting here (in addition to the
    // content handler) rotated the selection twice / back to the start.
    expect(ctx.storageSet).not.toHaveBeenCalled();
    const forwarded = ctx.tabMessages.filter((m) => m.message.type === 'CYCLE_LANGUAGE');
    expect(forwarded).toHaveLength(1);
  });

  it('injects the content script first when the tab does not have it yet', async () => {
    const ctx = stubChrome({ statusBehavior: 'not-injected-then-ready' });
    const onCommand = await loadWorker();

    onCommand('cycle-language');

    await vi.waitFor(() => {
      expect(ctx.executeScript).toHaveBeenCalledTimes(1);
      expect(ctx.sendMessage).toHaveBeenCalledWith(42, { type: 'CYCLE_LANGUAGE' });
    });
    expect(ctx.storageSet).not.toHaveBeenCalled();
  });

  it('does nothing (and does not persist) when no languages are bookmarked', async () => {
    const ctx = stubChrome({
      prefs: { selectedLanguage: 'fa-IR', bookmarkedLanguages: [] },
      statusBehavior: 'ready',
    });
    const onCommand = await loadWorker();

    onCommand('cycle-language');
    // Flush the async early-return path.
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(ctx.sendMessage).not.toHaveBeenCalled();
    expect(ctx.storageSet).not.toHaveBeenCalled();
  });
});

describe('toggle-dictation command', () => {
  it('still routes START/STOP through the tab', async () => {
    const ctx = stubChrome({
      prefs: { selectedLanguage: 'fa-IR', bookmarkedLanguages: ['fa-IR'] },
      statusBehavior: 'ready',
    });
    const onCommand = await loadWorker();

    onCommand('toggle-dictation');

    await vi.waitFor(() => {
      expect(ctx.sendMessage).toHaveBeenCalledWith(42, {
        type: 'START_RECOGNITION',
        language: 'fa-IR',
        preferredMode: 'auto',
      });
    });
  });
});

/**
 * The local recording store's message routing.
 *
 * The split that matters: the content script captures audio and therefore has to
 * be able to save it and take it out again, but it must never be able to read
 * the store back, list it, or make the extension re-send what is in it. Those
 * are the operations that hand audio out, so they are extension pages only.
 */
describe('service worker — recording store routing', () => {
  interface StoreStub {
    dispatch: (message: unknown, sender: unknown) => Promise<{ ok: boolean; error?: string; recordings?: unknown[] }>;
    sender: { tab: { id: number } };
    extensionSender: { id: string; url: string };
  }

  async function loadStoreWorker(): Promise<StoreStub> {
    const { IDBFactory } = await import('fake-indexeddb');
    globalThis.indexedDB = new IDBFactory() as unknown as IDBFactory;

    let listener!: (raw: unknown, sender: unknown, sendResponse: (value: unknown) => void) => boolean | undefined;
    vi.stubGlobal('chrome', {
      commands: { onCommand: { addListener: vi.fn() } },
      tabs: { query: vi.fn(async () => [{ id: 42 }]), sendMessage: vi.fn(async () => READY_STATUS) },
      scripting: { executeScript: vi.fn(async () => {}) },
      storage: { local: { get: vi.fn(async () => ({ prefs: {} })), set: vi.fn(async () => {}) } },
      runtime: {
        id: 'test-extension-id',
        getURL: (path: string) => `chrome-extension://test-extension-id/${path}`,
        onMessage: {
          addListener: vi.fn((fn: typeof listener) => { listener = fn; }),
        },
      },
    });

    vi.resetModules();
    await import('../src/background/service-worker');

    const dispatch = async (message: unknown, sender: unknown) =>
      new Promise<{ ok: boolean; error?: string; recordings?: unknown[] }>((resolve) => {
        const kept = listener(message, sender, resolve as (value: unknown) => void);
        if (kept !== true) resolve({ ok: false, error: 'not handled' });
      });

    return {
      dispatch,
      sender: { tab: { id: 42 } },
      extensionSender: { id: 'test-extension-id', url: 'chrome-extension://test-extension-id/options.html' },
    };
  }

  it('lets a content script save a clip it just captured', async () => {
    const ctx = await loadStoreWorker();

    // A content script owns the microphone, so it must be able to write. This
    // regressed once: an over-broad guard refused every store message from a
    // page, which silently disabled the whole feature.
    expect((await ctx.dispatch({ type: 'RECORDING_SAVE_BEGIN', id: 'c1' }, ctx.sender)).ok).toBe(true);
    expect((await ctx.dispatch({ type: 'RECORDING_SAVE_CHUNK', id: 'c1', data: btoa('audio') }, ctx.sender)).ok).toBe(true);
    expect((await ctx.dispatch({ type: 'RECORDING_SAVE_COMMIT', id: 'c1' }, ctx.sender)).ok).toBe(true);
  });

  it('lets a content script remove a clip once it is transcribed', async () => {
    const ctx = await loadStoreWorker();
    await ctx.dispatch({ type: 'RECORDING_SAVE_BEGIN', id: 'c2' }, ctx.sender);
    await ctx.dispatch({ type: 'RECORDING_SAVE_CHUNK', id: 'c2', data: btoa('audio') }, ctx.sender);
    await ctx.dispatch({ type: 'RECORDING_SAVE_COMMIT', id: 'c2' }, ctx.sender);

    expect((await ctx.dispatch({ type: 'RECORDING_DELETE', id: 'c2' }, ctx.sender)).ok).toBe(true);
  });

  it('refuses to list, clear, or retry on behalf of a web page', async () => {
    const ctx = await loadStoreWorker();
    await ctx.dispatch({ type: 'RECORDING_SAVE_BEGIN', id: 'c3' }, ctx.sender);
    await ctx.dispatch({ type: 'RECORDING_SAVE_CHUNK', id: 'c3', data: btoa('audio') }, ctx.sender);
    await ctx.dispatch({ type: 'RECORDING_SAVE_COMMIT', id: 'c3' }, ctx.sender);

    // These hand stored audio back out, so a page must not reach them.
    for (const message of [
      { type: 'RECORDING_LIST' },
      { type: 'RECORDING_CLEAR' },
      { type: 'RECORDING_RETRY', id: 'c3' },
    ]) {
      const result = await ctx.dispatch(message, ctx.sender);
      expect(result.ok).toBe(false);
      expect(result.error).toContain('only available to the extension');
    }
  });

  it('refuses store reads even when the sender LOOKS like an extension page', async () => {
    // Another extension's id is not ours — the pinning on chrome.runtime.id,
    // not the URL scheme, is what keeps the store's read path closed.
    const ctx = await loadStoreWorker();
    const result = await ctx.dispatch(
      { type: 'RECORDING_LIST' },
      { id: 'other-extension-id', url: 'chrome-extension://other-extension-id/options.html' }
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain('only available to the extension');
  });

  it('lets the Settings page list and clear what is stored', async () => {
    const ctx = await loadStoreWorker();
    await ctx.dispatch({ type: 'RECORDING_SAVE_BEGIN', id: 'c4' }, ctx.sender);
    await ctx.dispatch({ type: 'RECORDING_SAVE_CHUNK', id: 'c4', data: btoa('audio') }, ctx.sender);
    await ctx.dispatch({ type: 'RECORDING_SAVE_COMMIT', id: 'c4' }, ctx.extensionSender);

    const list = await ctx.dispatch({ type: 'RECORDING_LIST' }, ctx.extensionSender);
    expect(list.ok).toBe(true);
    expect(list.recordings).toHaveLength(1);

    expect((await ctx.dispatch({ type: 'RECORDING_CLEAR' }, ctx.extensionSender)).ok).toBe(true);
    expect((await ctx.dispatch({ type: 'RECORDING_LIST' }, ctx.extensionSender)).recordings).toHaveLength(0);
  });

  it('ignores messages that are not addressed to the store', async () => {
    const ctx = await loadStoreWorker();
    const result = await ctx.dispatch({ type: 'SOMETHING_ELSE' }, ctx.extensionSender);
    expect(result.error).toBe('not handled');
  });
});
