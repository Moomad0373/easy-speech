import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getGeminiStatus,
  saveGeminiApiKey,
  transcribeAudio,
  verifyGeminiApiKey,
} from '../src/background/gemini';
import type { TranscriptionSettings } from '../src/shared/transcription';
import { loadUsageLedger, summarizeUsage } from '../src/shared/usage';

// The extension talks to Google's Gemini API directly, with the user's own key.
// There is no intermediary server and no endpoint constant to pin: this file
// exercises the only request path that exists.

function stubStorage(initial: Record<string, unknown> = {}): void {
  const values = { ...initial };
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: vi.fn(async (key: string) => ({ [key]: values[key] })),
        set: vi.fn(async (value: Record<string, unknown>) => Object.assign(values, value)),
        remove: vi.fn(async (key: string) => { delete values[key]; }),
      },
    },
  });
}

const VERBATIM_EN: TranscriptionSettings = { language: 'en-US', mode: 'verbatim', vocabulary: [] };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Gemini client', () => {
  it('stores a key without returning it from status', async () => {
    stubStorage();
    const status = await saveGeminiApiKey('  secret-key  ');
    expect(status.configured).toBe(true);
    expect(status).not.toHaveProperty('apiKey');
    expect((await getGeminiStatus()).configured).toBe(true);
  });

  it('sends inline audio to the Interactions endpoint and reads output_text', async () => {
    stubStorage({ geminiApiKey: 'secret-key' });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      output_text: '  hello from Gemini  ',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await transcribeAudio({
      data: 'YXVkaW8=',
      mimeType: 'audio/webm',
      transcription: VERBATIM_EN,
      model: 'gemini-3.5-transcribe',
    });

    expect(result).toEqual({ ok: true, text: 'hello from Gemini' });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    // transcription_config is only accepted on the Interactions endpoint.
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/interactions');
    expect((init.headers as Record<string, string>)['x-goog-api-key']).toBe('secret-key');
    expect(JSON.parse(String(init.body))).toEqual({
      model: 'gemini-3.5-transcribe',
      input: [{ type: 'audio', data: 'YXVkaW8=', mime_type: 'audio/webm' }],
      generation_config: {
        transcription_config: { language_codes: ['en-US'], mode: { type: 'verbatim' } },
      },
    });
  });

  it('never sends a free-text prompt alongside the structured config', async () => {
    // The old "the expected language is فارسی" wording is what language_codes
    // replaces; a prompt could only contradict transcription_config.
    stubStorage({ geminiApiKey: 'secret-key' });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ output_text: 'ok' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await transcribeAudio({
      data: 'YXVkaW8=',
      mimeType: 'audio/webm',
      transcription: { language: 'fa-IR', mode: 'smart', vocabulary: ['زیتکس'] },
      model: 'gemini-3.5-transcribe',
    });

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(body.generation_config).toEqual({
      transcription_config: {
        language_codes: ['fa-IR'],
        mode: 'smart',
        custom_vocabulary: ['زیتکس'],
      },
    });
    expect(JSON.stringify(body)).not.toContain('Transcribe');
    expect(body.contents).toBeUndefined();
  });

  it('extracts the transcript from a generateContent-shaped response', async () => {
    // gemini-3.5-transcribe answers with part.audioTranscription.text and
    // leaves part.text empty, so reading only the plain field would report
    // every recording as silent.
    stubStorage({ geminiApiKey: 'secret-key' });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      candidates: [{
        content: { parts: [{ text: '', audioTranscription: { text: '  hello from transcribe  ' } }] },
        finishReason: 'STOP',
      }],
      modelVersion: 'gemini-3.5-transcribe',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await transcribeAudio({
      data: 'YXVkaW8=',
      mimeType: 'audio/webm',
      transcription: VERBATIM_EN,
      model: 'gemini-3.5-transcribe',
    });

    expect(result).toEqual({ ok: true, text: 'hello from transcribe' });
  });

  it('falls back to the defaults for absent or invalid transcription settings', async () => {
    // The message arrives from a content script running in an arbitrary page,
    // so a page that forges it must not be able to inject a language code.
    stubStorage({ geminiApiKey: 'secret-key' });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ output_text: 'ok' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await transcribeAudio({
      data: 'YXVkaW8=',
      mimeType: 'audio/webm',
      transcription: { language: '../../etc/passwd', mode: 'root', vocabulary: 'not-an-array' } as never,
      model: 'gemini-3.5-transcribe',
    });

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body)).generation_config.transcription_config).toEqual({
      language_codes: ['fa-IR'],
      mode: { type: 'verbatim' },
    });
  });

  it('folds the reported usage into the local ledger', async () => {
    // The recording happens in the service worker because it is the one place
    // every transcription passes through, and it is where the model the user
    // actually ran is known.
    stubStorage({ geminiApiKey: 'secret-key' });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      output_text: 'the transcript',
      usage: { total_input_tokens: 123, total_output_tokens: 12, total_tokens: 135 },
    }), { status: 200 })));

    await transcribeAudio({
      data: 'YXVkaW8=',
      mimeType: 'audio/webm',
      transcription: VERBATIM_EN,
      model: 'gemini-3.5-transcribe',
    });

    const ledger = await loadUsageLedger();
    expect(ledger.allTime).toEqual({
      requests: 1,
      promptTokens: 123,
      completionTokens: 12,
      totalTokens: 135,
      audioTokens: 0,
    });
    expect(ledger.last?.model).toBe('gemini-3.5-transcribe');
    expect(summarizeUsage(ledger).today.totalTokens).toBe(135);
  });

  it('does not record anything when no usage was reported', async () => {
    stubStorage({ geminiApiKey: 'secret-key' });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ output_text: 'ok' }), { status: 200 })));

    await transcribeAudio({
      data: 'YXVkaW8=',
      mimeType: 'audio/webm',
      transcription: VERBATIM_EN,
      model: 'gemini-3.5-transcribe',
    });

    expect((await loadUsageLedger()).allTime.requests).toBe(0);
  });

  it('never writes the transcript into the ledger', async () => {
    // The ledger is counts and a clock. It must not become a second copy of
    // the user's speech sitting in storage.
    stubStorage({ geminiApiKey: 'secret-key' });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      output_text: 'my bank password is hunter2',
      usage: { total_tokens: 10 },
    }), { status: 200 })));

    await transcribeAudio({
      data: 'YXVkaW8=',
      mimeType: 'audio/webm',
      transcription: { language: 'en-US', mode: 'verbatim', vocabulary: ['Kubernetes'] },
      model: 'gemini-3.5-transcribe',
    });

    const stored = await chrome.storage.local.get('tokenUsage');
    expect(JSON.stringify(stored)).not.toContain('hunter2');
    expect(JSON.stringify(stored)).not.toContain('Kubernetes');
  });

  it('maps authentication failures without returning the API response body', async () => {
    stubStorage({ geminiApiKey: 'bad-key' });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('secret provider details', { status: 401 })));

    const result = await transcribeAudio({
      data: 'YXVkaW8=',
      mimeType: 'audio/webm',
      transcription: VERBATIM_EN,
      model: 'gemini-3.5-flash-lite',
    });

    expect(result).toEqual({ ok: false, error: 'auth', message: 'The Google API key was rejected.' });
  });

  it('explains an empty Gemini candidate result', async () => {
    stubStorage({ geminiApiKey: 'secret-key' });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      candidates: [{ finishReason: 'SAFETY' }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })));

    const result = await transcribeAudio({
      data: 'YXVkaW8=',
      mimeType: 'audio/webm',
      transcription: VERBATIM_EN,
      model: 'gemini-3.5-flash-lite',
    });

    expect(result).toEqual({
      ok: false,
      error: 'empty',
      message: 'Gemini returned no transcript (SAFETY).',
    });
  });

  it('rejects oversized audio before making a request', async () => {
    stubStorage({ geminiApiKey: 'secret-key' });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await transcribeAudio({
      data: 'x'.repeat(20 * 1024 * 1024),
      mimeType: 'audio/webm',
      transcription: VERBATIM_EN,
      model: 'gemini-3.5-flash-lite',
    });

    expect(result.error).toBe('size');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces Google's own reason for a rejected request", async () => {
    // Everyone using this with their own key will hit a bad model ID or an
    // unsupported container at some point. A generic "could not transcribe"
    // gives them nothing to act on, so the server's message is shown.
    stubStorage({ geminiApiKey: 'secret-key' });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      error: {
        code: 400,
        message: 'models/gemini-nope is not found for API version v1beta, or is not supported for predict.',
        status: 'INVALID_ARGUMENT',
      },
    }), { status: 400, headers: { 'Content-Type': 'application/json' } })));

    const result = await transcribeAudio({
      data: 'YXVkaW8=',
      mimeType: 'audio/webm',
      transcription: VERBATIM_EN,
      model: 'gemini-nope',
    });

    expect(result.error).toBe('api');
    expect(result.message).toContain('models/gemini-nope is not found');
  });

  it("never lets Google's error text carry the API key back out", async () => {
    // Google does not echo the key, but this string is rendered in the UI, so
    // the guarantee that the key stays in storage must not depend on that.
    stubStorage({ geminiApiKey: 'super-secret-key' });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      error: { code: 400, message: 'Invalid key super-secret-key supplied for this project.' },
    }), { status: 400, headers: { 'Content-Type': 'application/json' } })));

    const result = await transcribeAudio({
      data: 'YXVkaW8=',
      mimeType: 'audio/webm',
      transcription: VERBATIM_EN,
      model: 'gemini-3.5-transcribe',
    });

    expect(result.message).not.toContain('super-secret-key');
    expect(result.message).toContain('[redacted]');
  });

  it('caps an over-long error message', async () => {
    stubStorage({ geminiApiKey: 'secret-key' });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      error: { code: 400, message: 'x'.repeat(5000) },
    }), { status: 400, headers: { 'Content-Type': 'application/json' } })));

    const result = await transcribeAudio({
      data: 'YXVkaW8=',
      mimeType: 'audio/webm',
      transcription: VERBATIM_EN,
      model: 'gemini-3.5-transcribe',
    });

    expect(result.message!.length).toBeLessThanOrEqual(240);
  });

  it('never treats an unparseable body as a transcript', async () => {
    // Regression guard. Against a public endpoint, a non-JSON body is far more
    // likely to be a proxy's or captive-portal's HTML than anyone's speech, and
    // inserting it into the field the user was typing in would be unrecoverable.
    stubStorage({ geminiApiKey: 'secret-key' });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      '<html><head><title>502 Bad Gateway</title></head></html>',
      { status: 200, headers: { 'Content-Type': 'text/html' } }
    )));

    const result = await transcribeAudio({
      data: 'YXVkaW8=',
      mimeType: 'audio/webm',
      transcription: VERBATIM_EN,
      model: 'gemini-3.5-transcribe',
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe('api');
    expect(result.message).toBe('Gemini returned an unreadable response.');
    expect(result).not.toHaveProperty('text');
  });
  it('checks the key in the input without saving it', async () => {
    // The whole point: catch the typo before the user records anything, and
    // never persist a key that has not passed a save.
    stubStorage({ geminiApiKey: 'stored-key' });
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await verifyGeminiApiKey('  typed-key  ');

    expect(result).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1');
    expect((init.headers as Record<string, string>)['x-goog-api-key']).toBe('typed-key');
    expect(await chrome.storage.local.get('geminiApiKey')).toEqual({ geminiApiKey: 'stored-key' });
  });

  it('re-checks the saved key when the input is empty', async () => {
    stubStorage({ geminiApiKey: 'stored-key' });
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    expect(await verifyGeminiApiKey()).toEqual({ ok: true });
    expect(await verifyGeminiApiKey('   ')).toEqual({ ok: true });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>)['x-goog-api-key']).toBe('stored-key');
  });

  it('reports a rejected key instead of saving it', async () => {
    stubStorage();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error: { code: 400, message: 'API key not valid. Please pass a valid API key.' } }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    )));

    const result = await verifyGeminiApiKey('wrong-key');

    expect(result.ok).toBe(false);
    expect(result.message).toContain('API key not valid');
    expect(await chrome.storage.local.get('geminiApiKey')).toEqual({ geminiApiKey: undefined });
  });

  it('maps a forbidden key to auth', async () => {
    stubStorage();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 403 })));

    expect(await verifyGeminiApiKey('wrong-key')).toEqual({
      ok: false,
      error: 'auth',
      message: 'The Google API key was rejected.',
    });
  });

  it('names the blocked host when Google cannot be reached', async () => {
    stubStorage();
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }));

    const result = await verifyGeminiApiKey('some-key');

    expect(result.error).toBe('network');
    // A user on a blocked network must be told that, not sent to check their
    // router.
    expect(result.message).toContain('generativelanguage.googleapis.com');
  });

  it('asks for a key when there is nothing to check', async () => {
    stubStorage();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    expect(await verifyGeminiApiKey()).toEqual({
      ok: false,
      error: 'missing-key',
      message: 'Enter a Google API key first.',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});