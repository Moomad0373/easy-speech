import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureContentScript } from '../src/shared/messaging';

/**
 * On-demand content-script injection. The old implementation slept a fixed
 * 60 ms after executeScript and hoped the injected listener was up; the
 * implementation under test polls the status probe instead, so these tests
 * pin the observable contract: fast when ready, deterministic when not.
 */

const READY_STATUS = {
  ok: true,
  status: { state: 'idle', language: 'fa-IR', mode: null },
};

function stubChrome(sendMessage: ReturnType<typeof vi.fn>, executeScript: ReturnType<typeof vi.fn>): void {
  vi.stubGlobal('chrome', {
    tabs: { query: vi.fn(async () => [{ id: 1 }]), sendMessage },
    scripting: { executeScript },
    storage: { local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) } },
  });
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('ensureContentScript', () => {
  it('short-circuits when the content script is already present', async () => {
    const sendMessage = vi.fn(async (_tabId: number, message: { type: string }) => {
      if (message.type === 'GET_STATUS') return READY_STATUS;
      return { ok: true };
    });
    const executeScript = vi.fn(async () => {});
    stubChrome(sendMessage, executeScript);

    await expect(ensureContentScript(1)).resolves.toBeUndefined();
    expect(executeScript).not.toHaveBeenCalled();
  });

  it('injects and then returns as soon as the script answers a probe', async () => {
    let statusCalls = 0;
    const sendMessage = vi.fn(async (_tabId: number, message: { type: string }) => {
      if (message.type !== 'GET_STATUS') return { ok: true };
      statusCalls += 1;
      if (statusCalls === 1) throw new Error('Receiving end does not exist');
      return READY_STATUS;
    });
    const executeScript = vi.fn(async () => {});
    stubChrome(sendMessage, executeScript);

    await expect(ensureContentScript(1)).resolves.toBeUndefined();
    expect(executeScript).toHaveBeenCalledTimes(1);
    expect(executeScript).toHaveBeenCalledWith({
      target: { tabId: 1 },
      files: ['content/content.js'],
    });
    expect(statusCalls).toBeGreaterThanOrEqual(2);
  });

  it('explains when Chrome forbids injection on this page', async () => {
    const sendMessage = vi.fn(async () => {
      throw new Error('Receiving end does not exist');
    });
    const executeScript = vi.fn(async () => {
      throw new Error('Cannot access contents of the page.');
    });
    stubChrome(sendMessage, executeScript);

    await expect(ensureContentScript(1)).rejects.toThrow('does not allow extensions');
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('gives up with a clear error when the script never becomes ready', async () => {
    const sendMessage = vi.fn(async () => {
      throw new Error('Receiving end does not exist');
    });
    const executeScript = vi.fn(async () => {});
    stubChrome(sendMessage, executeScript);
    vi.useFakeTimers();

    // Attach the rejection handler before the timers advance, or Node flags
    // an unhandled rejection while the loop is still running.
    let rejection: Error | null = null;
    const pending = ensureContentScript(1).catch((error: Error) => {
      rejection = error;
    });
    await vi.advanceTimersByTimeAsync(2100);
    await pending;

    expect(rejection).toBeInstanceOf(Error);
    expect(rejection!.message).toContain('could not start');
    // It kept polling for the full window instead of giving up early.
    expect(statusCallCount(sendMessage)).toBeGreaterThan(3);
  });

  function statusCallCount(sendMessage: ReturnType<typeof vi.fn>): number {
    return sendMessage.mock.calls.filter((call) => (call[1] as { type: string }).type === 'GET_STATUS').length;
  }
});
