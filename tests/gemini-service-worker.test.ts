import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
});

async function loadWorkerListener(): Promise<{
  listener: (message: unknown, sender: chrome.runtime.MessageSender, sendResponse: (value: unknown) => void) => boolean | undefined;
  values: Record<string, unknown>;
}> {
  const values: Record<string, unknown> = { prefs: { geminiModel: 'gemini-3.5-transcribe' } };
  const addListener = vi.fn();
  vi.stubGlobal('chrome', {
    commands: { onCommand: { addListener: vi.fn() } },
    runtime: {
      id: 'id',
      getURL: (path: string) => `chrome-extension://id/${path}`,
      onMessage: { addListener },
    },
    storage: {
      local: {
        get: vi.fn(async (key: string) => ({ [key]: values[key] })),
        set: vi.fn(async (value: Record<string, unknown>) => Object.assign(values, value)),
        remove: vi.fn(async (key: string) => { delete values[key]; }),
      },
    },
    tabs: {
      query: vi.fn(async () => [{ id: 1 }]),
      sendMessage: vi.fn(async () => ({ ok: true })),
    },
    scripting: { executeScript: vi.fn(async () => {}) },
  });
  await import('../src/background/service-worker');
  return { listener: addListener.mock.calls[0]?.[0], values };
}

describe('service worker Gemini boundary', () => {
  it('allows a content tab to check status without receiving the key', async () => {
    const { listener, values } = await loadWorkerListener();
    values.geminiApiKey = 'private-key';
    const sendResponse = vi.fn();
    expect(listener?.({ type: 'GET_GEMINI_STATUS' }, { tab: { id: 1 } as chrome.tabs.Tab }, sendResponse)).toBe(true);
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled());
    expect(sendResponse.mock.calls[0]?.[0]).toEqual({
      ok: true,
      configured: true,
      model: 'gemini-3.5-transcribe',
    });
    expect(sendResponse.mock.calls[0]?.[0]).not.toHaveProperty('apiKey');
  });

  it('only accepts key writes from a Chrome or Edge extension page', async () => {
    const { listener, values } = await loadWorkerListener();
    const pageResponse = vi.fn();
    listener?.({ type: 'SET_GEMINI_API_KEY', apiKey: 'page-key' }, { id: 'id', url: 'chrome-extension://id/options/options.html' }, pageResponse);
    await vi.waitFor(() => expect(values.geminiApiKey).toBe('page-key'));

    const edgeResponse = vi.fn();
    listener?.({ type: 'SET_GEMINI_API_KEY', apiKey: 'edge-page-key' }, { id: 'id', url: 'extension://id/options/options.html' }, edgeResponse);
    await vi.waitFor(() => expect(values.geminiApiKey).toBe('edge-page-key'));

    const foreignResponse = vi.fn();
    listener?.(
      { type: 'SET_GEMINI_API_KEY', apiKey: 'foreign-key' },
      { id: 'other-id', url: 'chrome-extension://other-id/options.html' },
      foreignResponse
    );
    expect(values.geminiApiKey).toBe('edge-page-key');
    expect(foreignResponse).not.toHaveBeenCalled();

    const contentResponse = vi.fn();
    listener?.({ type: 'SET_GEMINI_API_KEY', apiKey: 'content-key' }, { tab: { id: 1 } as chrome.tabs.Tab }, contentResponse);
    expect(values.geminiApiKey).toBe('edge-page-key');
    expect(contentResponse).not.toHaveBeenCalled();
  });

  it('refuses to check a key for anything but an extension page', async () => {
    // The candidate key travels in the message, so a content script must not be
    // able to spend the user's key on a probe request of its own.
    const { listener } = await loadWorkerListener();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const contentResponse = vi.fn();
    listener?.(
      { type: 'VERIFY_GEMINI_API_KEY', apiKey: 'private-key' },
      { tab: { id: 1 } as chrome.tabs.Tab },
      contentResponse
    );
    await vi.waitFor(() => expect(contentResponse).toHaveBeenCalled());
    expect(fetchMock).not.toHaveBeenCalled();

    const pageResponse = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    listener?.(
      { type: 'VERIFY_GEMINI_API_KEY', apiKey: 'private-key' },
      { id: 'id', url: 'chrome-extension://id/options/options.html' },
      pageResponse
    );
    await vi.waitFor(() => expect(pageResponse).toHaveBeenCalled());
    expect(fetchMock).not.toHaveBeenCalled();
    expect(pageResponse.mock.calls[0]?.[0]).toEqual({ ok: true });
  });
});
