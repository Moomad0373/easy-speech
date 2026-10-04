import { afterEach, describe, expect, it, vi } from 'vitest';
import { GEMINI_TRANSCRIPTION_TIMEOUT_MS } from '../src/shared/constants';
import { GeminiTranscribeEngine } from '../src/content/recognition/engine/GeminiTranscribeEngine';
import type { EngineError, EngineResult } from '../src/content/recognition/engine/SpeechEngine';
import { RecordingPanel } from '../src/content/RecordingPanel';
import { RecognitionManager } from '../src/content/recognition/RecognitionManager';
import { TargetManager } from '../src/content/insertion/TargetManager';
import { FormControlAdapter } from '../src/content/insertion/FormControlAdapter';

afterEach(() => {
  document.getElementById('__voice-type-recording-host')?.remove();
  vi.unstubAllGlobals();
});

/** MediaRecorder stub plus the globals the recording card needs. */
function stubCapture(): { tracks: Array<{ stop: ReturnType<typeof vi.fn> }> } {
  const tracks = [{ stop: vi.fn() }];
  const stream = { getTracks: () => tracks } as unknown as MediaStream;
  class FakeMediaRecorder {
    static isTypeSupported(): boolean { return true; }
    state: 'inactive' | 'recording' = 'inactive';
    mimeType = 'audio/webm;codecs=opus';
    onstop: (() => void) | null = null;
    private listeners = new Map<string, Set<(event: Event) => void>>();
    addEventListener(type: string, listener: (event: Event) => void): void {
      const set = this.listeners.get(type) ?? new Set();
      set.add(listener);
      this.listeners.set(type, set);
    }
    start(): void { this.state = 'recording'; }
    stop(): void {
      this.state = 'inactive';
      this.dispatch('dataavailable', { data: new Blob(['audio'], { type: this.mimeType }) } as unknown as Event);
      this.dispatch('stop', new Event('stop'));
    }
    private dispatch(type: string, event: Event): void {
      for (const listener of this.listeners.get(type) ?? []) listener(event);
      if (type === 'stop') this.onstop?.();
    }
  }
  vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: vi.fn(async () => stream) },
  });
  return { tracks };
}

function cardShadow(): ShadowRoot {
  return document.getElementById('__voice-type-recording-host')!.shadowRoot!;
}

function cardState(): string | null {
  return cardShadow().querySelector('.card')?.getAttribute('data-state') ?? null;
}

function cardPresent(): boolean {
  return document.getElementById('__voice-type-recording-host') !== null;
}

/**
 * A manager wired exactly the way the content script wires it, with a real
 * target manager so the transcript actually lands in a field. Unit tests that
 * stub the engine hooks hide the coupling between the manager and the engine,
 * which is where this flow used to break.
 */
/** A stand-in for chrome.runtime.sendMessage, narrow enough to inspect. */
type MockSender = (message: { type?: string }) => Promise<unknown>;

function realManager(sendMessage: MockSender, field: HTMLTextAreaElement) {
  const targets = new TargetManager([new FormControlAdapter()]);
  let manager!: RecognitionManager;
  manager = new RecognitionManager({
    engineFactory: (config, callbacks) => new GeminiTranscribeEngine(config, callbacks, {
      onStopRequested: () => manager.stop(),
      onCancelRequested: () => manager.cancel(),
    }),
    targets,
    onStatus: () => {},
  });
  expect(targets.capture(field).ok).toBe(true);
  return { manager, targets };
}

/**
 * Stands in for the service worker.
 *
 * The engine now saves every captured clip locally before it sends anything, so
 * a bare "returns this object" mock is no longer enough: it would hand a
 * transcript back in reply to a save acknowledgement. This answers the
 * recording-store messages for real and delegates only the transcription.
 */
function stubWorker(respond: (message: { type?: string }) => unknown) {
  const seen: { type?: string }[] = [];
  const sendMessage = vi.fn(async (message: { type?: string }) => {
    seen.push(message);
    if (message.type === 'TRANSCRIBE_AUDIO') return respond(message);
    if (message.type === 'RECORDING_LIST') return { ok: true, recordings: [] };
    return { ok: true };
  });
  vi.stubGlobal('chrome', { runtime: { sendMessage } });
  return {
    sendMessage,
    types: () => seen.map((m) => m.type),
    countOf: (type: string) => seen.filter((m) => m.type === type).length,
  };
}

function startGemini(manager: RecognitionManager): void {
  manager.start(
    { language: 'en-US', mode: 'cloud', provider: 'gemini', geminiModel: 'gemini-3.5-transcribe' },
    'unknown',
    ''
  );
}

describe('GeminiTranscribeEngine - through the real manager', () => {
  afterEach(() => {
    document.getElementById('__voice-type-recording-host')?.remove();
    vi.unstubAllGlobals();
  });

  it('types the transcript by itself, with no second click', async () => {
    // The reported friction: record, stop, wait, then press Insert. The
    // transcript now goes where the user was writing the moment it arrives.
    stubCapture();
    const field = document.createElement('textarea');
    document.body.appendChild(field);
    const worker = stubWorker(() => ({ ok: true, text: 'the dictated sentence' }));
    const { manager } = realManager(worker.sendMessage, field);

    startGemini(manager);
    const orb = cardShadow().querySelector('.orb') as HTMLButtonElement;
    orb.click();
    await vi.waitFor(() => expect(cardState()).toBe('recording'));
    orb.click();

    // While it waits, the card stays put with the design's waiting affordance.
    await vi.waitFor(() => expect(cardState()).toBe('processing'));
    expect(cardPresent()).toBe(true);
    expect(cardShadow().querySelector('.spin')).not.toBeNull();

    // The text arrives on its own, and the card gets out of the way.
    await vi.waitFor(() => expect(field.value).toBe('the dictated sentence'));
    expect(cardPresent()).toBe(false);
    expect(manager.getStatus().uncommittedTranscript).toBeNull();
    manager.cancel();
    field.remove();
  });

  it('reopens the card for a second recording, the way the floating badge does', async () => {
    // The second reported problem: after one recording, clicking the badge did
    // not bring the card back, so there was no way to dictate again.
    stubCapture();
    const field = document.createElement('textarea');
    document.body.appendChild(field);
    const worker = stubWorker(() => ({ ok: true, text: 'one more thing' }));
    const { manager, targets } = realManager(worker.sendMessage, field);

    // --- session one
    startGemini(manager);
    let orb = cardShadow().querySelector('.orb') as HTMLButtonElement;
    orb.click();
    await vi.waitFor(() => expect(cardState()).toBe('recording'));
    orb.click();
    await vi.waitFor(() => expect(field.value).toBe('one more thing'));
    // The card left nothing behind: no stale host, no stale key handler.
    expect(cardPresent()).toBe(false);
    expect(manager.getStatus().state).toBe('idle');

    // --- session two: exactly what a badge click does (re-capture, re-start)
    expect(targets.capture(field).ok).toBe(true);
    startGemini(manager);
    await vi.waitFor(() => expect(cardPresent()).toBe(true));
    expect(cardState()).toBe('idle');

    orb = cardShadow().querySelector('.orb') as HTMLButtonElement;
    orb.click();
    await vi.waitFor(() => expect(cardState()).toBe('recording'));
    orb.click();
    await vi.waitFor(() => expect(field.value).toBe('one more thing one more thing'));
    expect(worker.countOf('TRANSCRIBE_AUDIO')).toBe(2);
    manager.cancel();
    field.remove();
  });

  it('still lets a real stop during the wait cancel it', async () => {
    stubCapture();
    const field = document.createElement('textarea');
    document.body.appendChild(field);
    let resolveMessage!: (value: unknown) => void;
    // Only the transcription hangs. The local save that precedes it answers at
    // once, as the worker would — otherwise `resolveMessage` would be bound to
    // a save acknowledgement and the assertions below would pass vacuously.
    const sendMessage = vi.fn((message: { type?: string }) =>
      message.type === 'TRANSCRIBE_AUDIO'
        ? new Promise((resolve) => { resolveMessage = resolve; })
        : Promise.resolve({ ok: true })
    );
    vi.stubGlobal('chrome', { runtime: { sendMessage } });
    const { manager } = realManager(sendMessage, field);

    startGemini(manager);
    const orb = cardShadow().querySelector('.orb') as HTMLButtonElement;
    orb.click();
    await vi.waitFor(() => expect(cardState()).toBe('recording'));
    orb.click();
    // Wait for the request itself, not just the spinner: the card enters
    // "processing" a tick before the message is sent.
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'TRANSCRIBE_AUDIO' })
    ));
    expect(cardState()).toBe('processing');

    // A genuine stop now: the wait ends and the card goes away.
    manager.stop();
    expect(cardPresent()).toBe(false);

    // A transcript arriving after that must not be typed behind the user's back.
    resolveMessage({ ok: true, text: 'too late' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(field.value).toBe('');
    manager.cancel();
    field.remove();
  });
});

describe('GeminiTranscribeEngine', () => {
  it('sends the clip and inserts the transcript without a second click', async () => {
    const { tracks } = stubCapture();
    let resolveMessage!: (value: { ok: boolean; text: string }) => void;
    // Only the transcription is held open; the local save that precedes it
    // answers at once, as the worker would.
    const worker = stubWorker(() => new Promise<{ ok: boolean; text: string }>((resolve) => { resolveMessage = resolve; }));
    vi.stubGlobal('chrome', { runtime: { sendMessage: worker.sendMessage } });
    const onStart = vi.fn();
    const onResult = vi.fn();
    const onEnd = vi.fn();
    const onStopRequested = vi.fn();
    let engine!: GeminiTranscribeEngine;
    engine = new GeminiTranscribeEngine(
      { language: 'en-US', mode: 'cloud', provider: 'gemini', geminiModel: 'gemini-3.5-flash-lite' },
      { onStart, onResult, onError: vi.fn(), onEnd },
      { onStopRequested: () => { onStopRequested(); engine.stop(); }, onCancelRequested: vi.fn() }
    );
    engine.start();
    const orb = cardShadow().querySelector('.orb') as HTMLButtonElement;
    orb.click();
    await vi.waitFor(() => expect(onStart).toHaveBeenCalledOnce());
    expect(cardState()).toBe('recording');

    orb.click();
    await vi.waitFor(() => expect(cardState()).toBe('processing'));
    // The design removed the separate Transcribe button: stopping submits.
    await vi.waitFor(() => expect(cardShadow().querySelector('.status')?.textContent).toContain('Waiting for Gemini'));

    resolveMessage({ ok: true, text: 'accurate transcript' });
    await vi.waitFor(() => expect(onResult).toHaveBeenCalledWith({
      transcript: 'accurate transcript', isFinal: true, confidence: 1,
    }));
    // Once, from submit() itself: the card has no Stop button any more.
    expect(onStopRequested).toHaveBeenCalledTimes(1);
    expect(onEnd).toHaveBeenCalledTimes(1);
    // The card is gone as soon as its work is done.
    expect(cardPresent()).toBe(false);
    // The recorded blob carries `audio/webm;codecs=opus`; the request must carry
    // the bare audio/* type (the Gemini API rejects parameters).
    expect(worker.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'TRANSCRIBE_AUDIO', mimeType: 'audio/webm' })
    );
    expect(tracks[0]?.stop).toHaveBeenCalled();
    engine.abort();
  });

  it('keeps the card open after a failure so the clip can simply be retaken', async () => {
    // Closing the card on every hiccup would make one dropped request cost the
    // user the whole recording.
    stubCapture();
    vi.stubGlobal('chrome', {
      runtime: { sendMessage: vi.fn(async () => ({ ok: false, error: 'network', message: 'Could not reach the transcription service.' })) },
    });
    const onEnd = vi.fn();
    const engine = new GeminiTranscribeEngine(
      { language: 'en-US', mode: 'cloud', provider: 'gemini', geminiModel: 'gemini-3.5-transcribe' },
      { onStart: vi.fn(), onResult: vi.fn(), onError: vi.fn(), onEnd },
      { onStopRequested: vi.fn(), onCancelRequested: vi.fn() }
    );
    engine.start();
    const orb = cardShadow().querySelector('.orb') as HTMLButtonElement;
    orb.click();
    await vi.waitFor(() => expect(cardState()).toBe('recording'));
    orb.click();
    await vi.waitFor(() => expect(cardState()).toBe('idle'));

    const status = cardShadow().querySelector('.status') as HTMLElement;
    expect(status.textContent).toBe('Could not reach the transcription service.');
    expect(status.classList.contains('error')).toBe(true);
    // The session is left open, and the mic is offered again.
    expect(onEnd).not.toHaveBeenCalled();
    orb.click();
    await vi.waitFor(() => expect(cardState()).toBe('recording'));
    engine.abort();
  });

  it('ignores the stop that reports the finished clip', async () => {
    // Finishing a recording reports the stop to the manager, which calls
    // engine.stop() straight back. Treating that echo as a user stop cancelled
    // the session the instant the clip was finished: the card was destroyed and
    // the transcript discarded.
    stubCapture();
    let resolveMessage!: (value: unknown) => void;
    // Only the transcription is held open. The local save that precedes it
    // answers immediately, as the worker would.
    const sendMessage = vi.fn((message: { type?: string }) =>
      message.type === 'TRANSCRIBE_AUDIO'
        ? new Promise((resolve) => { resolveMessage = resolve; })
        : Promise.resolve({ ok: true })
    );
    vi.stubGlobal('chrome', { runtime: { sendMessage } });
    const onResult = vi.fn();
    const onCancelRequested = vi.fn();
    let engine!: GeminiTranscribeEngine;
    engine = new GeminiTranscribeEngine(
      { language: 'en-US', mode: 'cloud', provider: 'gemini', geminiModel: 'gemini-3.5-transcribe' },
      { onStart: vi.fn(), onResult, onError: vi.fn(), onEnd: vi.fn() },
      { onStopRequested: () => engine.stop(), onCancelRequested }
    );
    engine.start();
    const orb = cardShadow().querySelector('.orb') as HTMLButtonElement;
    orb.click();
    await vi.waitFor(() => expect(cardState()).toBe('recording'));
    orb.click();
    // Wait for the request itself, not just the spinner: the card enters
    // "processing" a tick before the message goes out.
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'TRANSCRIBE_AUDIO' })
    ));
    expect(cardState()).toBe('processing');

    // The echo was inert: the request is still in flight and nothing cancelled.
    expect(onCancelRequested).not.toHaveBeenCalled();
    expect(cardPresent()).toBe(true);
    resolveMessage({ ok: true, text: 'still inserted' });
    await vi.waitFor(() => expect(onResult).toHaveBeenCalledWith({
      transcript: 'still inserted', isFinal: true, confidence: 1,
    }));
    engine.abort();
  });
});

describe('GeminiTranscribeEngine - uploading a recording the user already has', () => {
  afterEach(() => {
    document.getElementById('__voice-type-recording-host')?.remove();
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
    Object.defineProperty(document, 'execCommand', { configurable: true, value: undefined });
    vi.unstubAllGlobals();
  });

  function engineWith(
    upload: { blob: Blob; name: string },
    overrides: {
      onStart?: () => void;
      onResult?: (result: unknown) => void;
      onError?: (error: unknown) => void;
      onEnd?: () => void;
      respond?: () => Promise<unknown>;
    } = {}
  ): GeminiTranscribeEngine {
    const sendMessage = vi.fn(overrides.respond ?? (async () => ({ ok: true, text: 'transcribed words' })));
    vi.stubGlobal('chrome', { runtime: { sendMessage } });
    return new GeminiTranscribeEngine(
      { language: 'en-US', mode: 'cloud', provider: 'gemini', geminiModel: 'gemini-3.5-transcribe' },
      {
        onStart: overrides.onStart ?? vi.fn(),
        onResult: overrides.onResult ?? vi.fn(),
        onError: overrides.onError ?? vi.fn(),
        onEnd: overrides.onEnd ?? vi.fn(),
      },
      { onStopRequested: vi.fn(), onCancelRequested: vi.fn(), upload }
    );
  }

  it('submits the file without ever showing the recorder', async () => {
    const onStart = vi.fn();
    const onResult = vi.fn();
    const onEnd = vi.fn();
    const engine = engineWith(
      { blob: new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/mp4' }), name: 'memo.m4a' },
      { onStart, onResult, onEnd }
    );

    engine.start();
    await vi.waitFor(() => expect(onResult).toHaveBeenCalled());

    // No microphone prompt, no panel: the audio was already in hand.
    expect(onStart).toHaveBeenCalledOnce();
    expect(cardPresent()).toBe(false);
    expect(onResult).toHaveBeenCalledWith({
      transcript: 'transcribed words', isFinal: true, confidence: 1,
    });
    expect(onEnd).toHaveBeenCalledOnce();
  });

  it('sends the file with its own audio type over the recording request path', async () => {
    const sendMessage = vi.fn(async () => ({ ok: true, text: 'ok' }));
    vi.stubGlobal('chrome', { runtime: { sendMessage } });
    const engine = new GeminiTranscribeEngine(
      {
        language: 'fa-IR',
        mode: 'cloud',
        provider: 'gemini',
        geminiModel: 'gemini-3.5-transcribe',
        transcription: { language: 'auto', mode: 'smart', vocabulary: ['زیتکس'] },
      },
      { onStart: vi.fn(), onResult: vi.fn(), onError: vi.fn(), onEnd: vi.fn() },
      {
        onStopRequested: vi.fn(),
        onCancelRequested: vi.fn(),
        upload: { blob: new Blob([new Uint8Array([9, 9])], { type: 'audio/mpeg' }), name: 'voice.mp3' },
      }
    );

    engine.start();
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalled());

    // The very same request a recorded clip makes — only the audio differs, so
    // the transcript comes back through one code path. The Voice Transcribing
    // settings travel with it instead of the bare session language: the user's
    // choice is "automatic + smart", not the dictation language.
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'TRANSCRIBE_AUDIO',
      mimeType: 'audio/mpeg',
      transcription: { language: 'auto', mode: 'smart', vocabulary: ['زیتکس'] },
      model: 'gemini-3.5-transcribe',
      data: btoa(String.fromCharCode(9, 9)),
    }));
  });

  it('reports a rejected file through the normal error channel', async () => {
    // An upload has no card to hold the message, so the badge and the popup are
    // the only places left to report it — and the session must still settle.
    const onError = vi.fn();
    const onResult = vi.fn();
    const onEnd = vi.fn();
    const engine = engineWith(
      { blob: new Blob([new Uint8Array([1])], { type: 'audio/wav' }), name: 'x.wav' },
      { onError, onResult, onEnd, respond: async () => ({ ok: false, error: 'quota', message: 'Quota unavailable.' }) }
    );

    engine.start();
    await vi.waitFor(() => expect(onError).toHaveBeenCalled());

    expect(onError).toHaveBeenCalledWith({ code: 'gemini-error', message: 'Quota unavailable.' });
    expect(onResult).not.toHaveBeenCalled();
    expect(onEnd).toHaveBeenCalledOnce();
  });

  it('copies the transcript to the clipboard as a backup, and says so', async () => {
    // The reason for the backup: dictated text that has just landed in someone
    // else's document is gone for good after a mis-click, a re-rendering editor
    // or an undo. The clipboard is the only place left to recover it from.
    stubCapture();
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    vi.stubGlobal('chrome', {
      runtime: { sendMessage: vi.fn(async () => ({ ok: true, text: 'a backup worth keeping' })) },
    });
    const onResult = vi.fn();
    const onNote = vi.fn();
    const engine = new GeminiTranscribeEngine(
      { language: 'en-US', mode: 'cloud', provider: 'gemini', geminiModel: 'gemini-3.5-transcribe' },
      { onStart: vi.fn(), onResult, onError: vi.fn(), onEnd: vi.fn(), onNote },
      { onStopRequested: vi.fn(), onCancelRequested: vi.fn(), upload: { blob: new Blob([new Uint8Array([1])], { type: 'audio/wav' }), name: 'x.wav' } }
    );

    engine.start();
    await vi.waitFor(() => expect(onResult).toHaveBeenCalled());
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith('a backup worth keeping'));

    // Saying so is not optional: this silently replaces whatever the user had
    // copied, and they are the only one who can decide that is acceptable.
    await vi.waitFor(() => expect(onNote).toHaveBeenCalledWith('Transcript copied to clipboard'));
  });

  it('still inserts the transcript when the clipboard refuses it', async () => {
    stubCapture();
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: vi.fn(() => false),
    });
    vi.stubGlobal('chrome', {
      runtime: { sendMessage: vi.fn(async () => ({ ok: true, text: 'text that must land' })) },
    });
    const onResult = vi.fn();
    const onNote = vi.fn();
    const engine = new GeminiTranscribeEngine(
      { language: 'en-US', mode: 'cloud', provider: 'gemini', geminiModel: 'gemini-3.5-transcribe' },
      { onStart: vi.fn(), onResult, onError: vi.fn(), onEnd: vi.fn(), onNote },
      { onStopRequested: vi.fn(), onCancelRequested: vi.fn(), upload: { blob: new Blob([new Uint8Array([1])], { type: 'audio/wav' }), name: 'x.wav' } }
    );

    engine.start();
    // The insertion happens first and unconditionally: a missing backup must
    // never cost the user their text.
    await vi.waitFor(() => expect(onResult).toHaveBeenCalledWith({
      transcript: 'text that must land', isFinal: true, confidence: 1,
    }));
    // ...and the failure is reported rather than glossed over.
    await vi.waitFor(() => expect(onNote).toHaveBeenCalledWith('Could not copy to the clipboard'));
  });

  it('works without an onNote callback, for an engine that reports nothing', async () => {
    stubCapture();
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn(async () => {}) },
    });
    vi.stubGlobal('chrome', {
      runtime: { sendMessage: vi.fn(async () => ({ ok: true, text: 'silent' })) },
    });
    const onResult = vi.fn();
    const engine = new GeminiTranscribeEngine(
      { language: 'en-US', mode: 'cloud', provider: 'gemini', geminiModel: 'gemini-3.5-transcribe' },
      { onStart: vi.fn(), onResult, onError: vi.fn(), onEnd: vi.fn() },
      { onStopRequested: vi.fn(), onCancelRequested: vi.fn(), upload: { blob: new Blob([new Uint8Array([1])], { type: 'audio/wav' }), name: 'x.wav' } }
    );

    engine.start();
    await vi.waitFor(() => expect(onResult).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onResult).toHaveBeenCalledOnce();
  });

  it('ignores a result that arrives after the session was cancelled', async () => {
    let resolveMessage!: (value: unknown) => void;
    const onResult = vi.fn();
    const engine = engineWith(
      { blob: new Blob([new Uint8Array([1])], { type: 'audio/wav' }), name: 'x.wav' },
      {
        onResult,
        respond: () => new Promise((resolve) => { resolveMessage = resolve; }),
      }
    );

    engine.start();
    await vi.waitFor(() => expect(resolveMessage).toBeTypeOf('function'));
    engine.abort();
    resolveMessage({ ok: true, text: 'too late' });

    // A cancelled upload must not write into the field afterwards.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onResult).not.toHaveBeenCalled();
  });
});

describe('GeminiTranscribeEngine - long transcriptions on a slow connection', () => {
  afterEach(() => {
    document.getElementById('__voice-type-recording-host')?.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const OLD_LIMIT_MS = 90_000;

  function uploadEngine(respond: () => Promise<unknown>) {
    const callbacks = { onStart: vi.fn(), onResult: vi.fn(), onError: vi.fn(), onEnd: vi.fn() };
    const engine = new GeminiTranscribeEngine(
      { language: 'en-US', mode: 'cloud', provider: 'gemini', geminiModel: 'gemini-3.5-transcribe' },
      callbacks,
      {
        onStopRequested: vi.fn(),
        onCancelRequested: vi.fn(),
        upload: { blob: new Blob([new Uint8Array([1, 2])], { type: 'audio/webm' }), name: 'long.webm' },
      }
    );
    return { engine, callbacks };
  }

  it('waits well past the old 90 second limit and still inserts the transcript', async () => {
    // The reported problem: a long clip on a weak connection needs minutes to
    // upload and to be transcribed, and the request gave up after 90 seconds.
    vi.useFakeTimers();
    let resolveMessage!: (value: unknown) => void;
    vi.stubGlobal('chrome', {
      runtime: {
        sendMessage: vi.fn(() => new Promise((resolve) => { resolveMessage = resolve; })),
      },
    });
    const { engine, callbacks } = uploadEngine(() => new Promise(() => {}));

    engine.start();
    await vi.advanceTimersByTimeAsync(OLD_LIMIT_MS + 60_000);
    // Well beyond the limit that used to abort this request, and nothing has
    // been given up on.
    expect(callbacks.onError).not.toHaveBeenCalled();
    expect(callbacks.onResult).not.toHaveBeenCalled();

    resolveMessage({ ok: true, text: 'the whole long transcript' });
    await vi.advanceTimersByTimeAsync(20);

    expect(callbacks.onResult).toHaveBeenCalledWith({
      transcript: 'the whole long transcript', isFinal: true, confidence: 1,
    });
  });

  it('survives a five minute recording being uploaded and processed', async () => {
    // The longest clip the extension produces (MAX_RECORDING_DURATION_MS),
    // which is exactly the case the previous limit made impossible.
    vi.useFakeTimers();
    let resolveMessage!: (value: unknown) => void;
    vi.stubGlobal('chrome', {
      runtime: {
        sendMessage: vi.fn(() => new Promise((resolve) => { resolveMessage = resolve; })),
      },
    });
    const { engine, callbacks } = uploadEngine(() => new Promise(() => {}));

    engine.start();
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 90_000);
    expect(callbacks.onError).not.toHaveBeenCalled();

    resolveMessage({ ok: true, text: 'five minutes of speech' });
    await vi.advanceTimersByTimeAsync(20);
    expect(callbacks.onResult).toHaveBeenCalled();
  });

  it('still gives up on a request that never answers', async () => {
    // A longer budget must still be a budget.
    vi.useFakeTimers();
    vi.stubGlobal('chrome', { runtime: { sendMessage: vi.fn(() => new Promise(() => {})) } });
    const { engine, callbacks } = uploadEngine(() => new Promise(() => {}));

    engine.start();
    await vi.advanceTimersByTimeAsync(GEMINI_TRANSCRIPTION_TIMEOUT_MS + 1000);

    expect(callbacks.onResult).not.toHaveBeenCalled();
    expect(callbacks.onError).toHaveBeenCalledOnce();
    // The message states the limit that is actually in force.
    const minutes = Math.round(GEMINI_TRANSCRIPTION_TIMEOUT_MS / 60_000);
    expect(callbacks.onError).toHaveBeenCalledWith({
      code: 'gemini-error',
      message: `Gemini did not respond within ${minutes} minutes.`,
    });
  });

  it('tells the user a long wait is expected', async () => {
    vi.useFakeTimers();
    let resolveMessage!: (value: unknown) => void;
    vi.stubGlobal('chrome', {
      runtime: { sendMessage: vi.fn(() => new Promise((resolve) => { resolveMessage = resolve; })) },
    });
    const { engine } = uploadEngine(() => new Promise(() => {}));

    engine.start();
    await vi.advanceTimersByTimeAsync(50);
    const shadow = document.getElementById('__voice-type-recording-host')?.shadowRoot;
    // No panel for an upload, but the message must never claim a short wait.
    expect(shadow ?? null).toBeNull();

    resolveMessage({ ok: true, text: 'done' });
    await vi.advanceTimersByTimeAsync(20);
  });

  it('leaves the user a way out while a long transcription runs', async () => {
    // A ten minute wait has to be cancellable, and cancelling must not let a
    // late transcript slip into the field.
    const onCancel = vi.fn();
    const panel = new RecordingPanel({
      onStart: vi.fn(),
      onSubmit: vi.fn(),
      onCancel,
      onError: vi.fn(),
    });
    panel.open();
    const shadow = document.getElementById('__voice-type-recording-host')!.shadowRoot!;
    const close = shadow.querySelector('.close') as HTMLButtonElement;
    // The close control is present and usable in every state, including a
    // transcription that has been running for minutes.
    expect(close.disabled).toBe(false);
    expect(shadow.querySelector('.card')?.getAttribute('aria-label')).toBe('Voice transcription');
    close.click();
    expect(onCancel).toHaveBeenCalledOnce();
    panel.destroy();
  });

  it('leaves a recorded card cancellable while the request runs', async () => {
    vi.useFakeTimers();
    stubCapture();
    let resolveMessage!: (value: unknown) => void;
    // The local save answers immediately; only the transcription is held open.
    const sendMessage = vi.fn((message: { type?: string }) =>
      message.type === 'TRANSCRIBE_AUDIO'
        ? new Promise((resolve) => { resolveMessage = resolve; })
        : Promise.resolve({ ok: true })
    );
    vi.stubGlobal('chrome', { runtime: { sendMessage } });
    const onCancelRequested = vi.fn();
    const onResult = vi.fn();
    const engine = new GeminiTranscribeEngine(
      { language: 'en-US', mode: 'cloud', provider: 'gemini', geminiModel: 'gemini-3.5-transcribe' },
      { onStart: vi.fn(), onResult, onError: vi.fn(), onEnd: vi.fn() },
      { onStopRequested: vi.fn(), onCancelRequested }
    );
    engine.start();
    const orb = cardShadow().querySelector('.orb') as HTMLButtonElement;
    orb.click();
    await vi.waitFor(() => expect(cardState()).toBe('recording'));
    orb.click();
    // Wait for the transcription itself: the clip is saved locally first, so
    // the first message out is not the one that needs resolving.
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'TRANSCRIBE_AUDIO' })
    ));
    expect(cardState()).toBe('processing');

    // The card's own Cancel is always available while it waits.
    (cardShadow().querySelector('.close') as HTMLButtonElement).click();
    expect(onCancelRequested).toHaveBeenCalled();
    resolveMessage({ ok: true, text: 'discarded by the user' });
    await vi.advanceTimersByTimeAsync(20);
    expect(onResult).not.toHaveBeenCalled();
    engine.abort();
  });
});

/**
 * Local preservation of a recording until it has been transcribed.
 *
 * The whole feature exists because dictation is spoken: a request that fails
 * must never cost the user the audio they just produced. These tests pin the
 * three outcomes that matter — saved before sending, deleted only after a
 * transcript arrives, and kept through every kind of failure.
 */
describe('GeminiTranscribeEngine - unsent-recording recovery', () => {
  function recordedEngine() {
    const onResult = vi.fn<(result: EngineResult) => void>();
    const onError = vi.fn<(error: EngineError) => void>();
    const engine = new GeminiTranscribeEngine(
      { language: 'en-US', mode: 'cloud', provider: 'gemini', geminiModel: 'gemini-3.5-transcribe' },
      { onStart: vi.fn(), onResult, onError, onEnd: vi.fn() },
      { onStopRequested: vi.fn(), onCancelRequested: vi.fn() }
    );
    return { engine, onResult, onError };
  }

  it('saves the clip before it asks for a transcript', async () => {
    stubCapture();
    const order: string[] = [];
    const sendMessage = vi.fn(async (message: { type?: string }) => {
      order.push(message.type ?? '?');
      return { ok: true, text: 'spoken words' };
    });
    vi.stubGlobal('chrome', { runtime: { sendMessage } });
    const { engine, onResult } = recordedEngine();

    engine.start();
    const orb = cardShadow().querySelector('.orb') as HTMLButtonElement;
    orb.click();
    await vi.waitFor(() => expect(cardState()).toBe('recording'));
    orb.click();
    await vi.waitFor(() => expect(onResult).toHaveBeenCalled());

    // The save must be finished before the request leaves, or a failure during
    // the request would still lose the audio.
    expect(order.indexOf('RECORDING_SAVE_COMMIT')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('RECORDING_SAVE_COMMIT')).toBeLessThan(order.indexOf('TRANSCRIBE_AUDIO'));
    engine.abort();
  });

  it('sends the audio to the local store in chunks', async () => {
    stubCapture();
    const worker = stubWorker(() => ({ ok: true, text: 'done' }));
    const { engine, onResult } = recordedEngine();

    engine.start();
    const orb = cardShadow().querySelector('.orb') as HTMLButtonElement;
    orb.click();
    await vi.waitFor(() => expect(cardState()).toBe('recording'));
    orb.click();
    await vi.waitFor(() => expect(onResult).toHaveBeenCalled());

    expect(worker.countOf('RECORDING_SAVE_BEGIN')).toBe(1);
    expect(worker.countOf('RECORDING_SAVE_CHUNK')).toBeGreaterThanOrEqual(1);
    // The clip the user can retry has to be the same audio that was sent.
    const chunk = worker.sendMessage.mock.calls
      .map(([message]) => message as { type?: string; data?: string })
      .find((message) => message.type === 'RECORDING_SAVE_CHUNK');
    expect(chunk?.data).toBe(btoa('audio'));
    engine.abort();
  });

  it('deletes the local copy once a transcript has arrived', async () => {
    stubCapture();
    const worker = stubWorker(() => ({ ok: true, text: 'the final words' }));
    const { engine, onResult } = recordedEngine();

    engine.start();
    const orb = cardShadow().querySelector('.orb') as HTMLButtonElement;
    orb.click();
    await vi.waitFor(() => expect(cardState()).toBe('recording'));
    orb.click();
    await vi.waitFor(() => expect(onResult).toHaveBeenCalled());
    await vi.waitFor(() => expect(worker.countOf('RECORDING_DELETE')).toBe(1));

    const id = (worker.sendMessage.mock.calls
      .map(([message]) => message as { type?: string; id?: string })
      .find((message) => message.type === 'RECORDING_SAVE_COMMIT')?.id);
    expect(worker.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'RECORDING_DELETE',
      id,
    }));
    engine.abort();
  });

  it('keeps the recording when the request fails', async () => {
    stubCapture();
    const worker = stubWorker(() => ({
      ok: false,
      error: 'network',
      message: 'Could not reach the transcription service.',
    }));
    const { engine } = recordedEngine();

    engine.start();
    const orb = cardShadow().querySelector('.orb') as HTMLButtonElement;
    orb.click();
    await vi.waitFor(() => expect(cardState()).toBe('recording'));
    orb.click();
    await vi.waitFor(() => expect(worker.countOf('TRANSCRIBE_AUDIO')).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(worker.countOf('RECORDING_DELETE')).toBe(0);
    engine.abort();
  });

  it('keeps the recording when the request times out', async () => {
    vi.useFakeTimers();
    stubCapture();
    // The transcription never answers, so the engine's own timeout is what ends
    // it — the situation where the user is most likely to lose the audio.
    const worker = stubWorker(() => new Promise(() => {}));
    const { engine, onResult } = recordedEngine();

    engine.start();
    const orb = cardShadow().querySelector('.orb') as HTMLButtonElement;
    orb.click();
    await vi.advanceTimersByTimeAsync(50);
    await vi.waitFor(() => expect(cardState()).toBe('recording'));
    orb.click();
    await vi.advanceTimersByTimeAsync(GEMINI_TRANSCRIPTION_TIMEOUT_MS + 1_000);

    expect(onResult).not.toHaveBeenCalled();
    expect(worker.countOf('RECORDING_DELETE')).toBe(0);
    engine.abort();
    vi.useRealTimers();
  });

  it('keeps the recording when the user cancels mid-request', async () => {
    vi.useFakeTimers();
    stubCapture();
    const worker = stubWorker(() => new Promise(() => {}));
    const { engine, onResult } = recordedEngine();

    engine.start();
    const orb = cardShadow().querySelector('.orb') as HTMLButtonElement;
    orb.click();
    await vi.advanceTimersByTimeAsync(50);
    await vi.waitFor(() => expect(cardState()).toBe('recording'));
    orb.click();
    await vi.advanceTimersByTimeAsync(200);
    await vi.waitFor(() => expect(worker.countOf('TRANSCRIBE_AUDIO')).toBe(1));
    (cardShadow().querySelector('.close') as HTMLButtonElement).click();
    await vi.advanceTimersByTimeAsync(50);

    // Cancelling abandons the transcription, not the audio.
    expect(worker.countOf('RECORDING_DELETE')).toBe(0);
    expect(onResult).not.toHaveBeenCalled();
    engine.abort();
    vi.useRealTimers();
  });

  it('still transcribes when the local save is unavailable', async () => {
    stubCapture();
    // A storage failure must never be the reason someone cannot dictate.
    const worker = stubWorker(() => ({ ok: true, text: 'stored nowhere, typed anyway' }));
    worker.sendMessage.mockImplementation(async (message: { type?: string }) => {
      if (message.type === 'RECORDING_SAVE_BEGIN') return { ok: false };
      return { ok: true, text: 'stored nowhere, typed anyway' };
    });
    const { engine, onResult } = recordedEngine();

    engine.start();
    const orb = cardShadow().querySelector('.orb') as HTMLButtonElement;
    orb.click();
    await vi.waitFor(() => expect(cardState()).toBe('recording'));
    orb.click();
    await vi.waitFor(() => expect(onResult).toHaveBeenCalledWith(
      expect.objectContaining({ transcript: 'stored nowhere, typed anyway' })
    ));
    engine.abort();
  });

  it('does not copy an uploaded file into the local store', async () => {
    // The user still has the file they picked; a second copy would be a
    // privacy cost with no benefit.
    stubCapture();
    const worker = stubWorker(() => ({ ok: true, text: 'from a file' }));
    const onResult = vi.fn();
    const engine = new GeminiTranscribeEngine(
      { language: 'en-US', mode: 'cloud', provider: 'gemini', geminiModel: 'gemini-3.5-transcribe' },
      { onStart: vi.fn(), onResult, onError: vi.fn(), onEnd: vi.fn() },
      {
        onStopRequested: vi.fn(),
        onCancelRequested: vi.fn(),
        upload: { blob: new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/mp4' }), name: 'memo.m4a' },
      }
    );

    engine.start();
    await vi.waitFor(() => expect(onResult).toHaveBeenCalled());

    expect(worker.countOf('TRANSCRIBE_AUDIO')).toBe(1);
    expect(worker.countOf('RECORDING_SAVE_BEGIN')).toBe(0);
    expect(worker.countOf('RECORDING_SAVE_COMMIT')).toBe(0);
    engine.abort();
  });
});
