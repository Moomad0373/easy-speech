import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_CONSECUTIVE_EMPTY_RESTARTS } from '../src/shared/constants';
import type { RecognitionStatus } from '../src/shared/types';
import { RecognitionManager } from '../src/content/recognition/RecognitionManager';
import type { CommitResult, TargetController } from '../src/content/recognition/RecognitionManager';
import type {
  EngineCallbacks,
  EngineConfig,
  SpeechEngine,
} from '../src/content/recognition/engine/SpeechEngine';

class FakeEngine implements SpeechEngine {
  started = 0;
  stopped = 0;
  aborted = 0;
  constructor(
    readonly config: EngineConfig,
    readonly callbacks: EngineCallbacks
  ) {}
  start(): void {
    this.started += 1;
  }
  stop(): void {
    this.stopped += 1;
  }
  abort(): void {
    this.aborted += 1;
  }
}

function createHarness() {
  const engines: FakeEngine[] = [];
  const statuses: RecognitionStatus[] = [];
  let validation: { ok: boolean; reason?: string } = { ok: true };
  let commitResult: CommitResult = { ok: true, target: null };
  const commit = vi.fn((_text: string) => commitResult);
  const replace = vi.fn((_text: string, _previousText: string) => commitResult);
  const preview = vi.fn((_text: string) => ({ ok: true }));
  const resetPreview = vi.fn();
  const targets: TargetController = {
    summary: () => null,
    validate: () => validation,
    commit: (text: string) => commit(text),
    replace: (text: string, previousText: string) => replace(text, previousText),
    preview: (text: string) => preview(text),
    resetPreview: () => resetPreview(),
  };
  const engineFactory = vi.fn((config: EngineConfig, callbacks: EngineCallbacks) => {
    const engine = new FakeEngine(config, callbacks);
    engines.push(engine);
    return engine;
  });
  const manager = new RecognitionManager({
    engineFactory,
    targets,
    onStatus: (status) => statuses.push(status),
  });
  return {
    manager,
    engines,
    engineFactory,
    statuses,
    commit,
    replace,
    preview,
    resetPreview,
    setValidation: (v: { ok: boolean; reason?: string }) => {
      validation = v;
    },
    setCommit: (c: CommitResult) => {
      commitResult = c;
    },
  };
}

const CONFIG: EngineConfig = { language: 'fa-IR', mode: 'cloud' };

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('RecognitionManager state transitions', () => {
  it('goes idle → starting → listening', () => {
    const h = createHarness();
    h.manager.start(CONFIG, 'unavailable', 'note');
    expect(h.manager.getStatus().state).toBe('starting');
    expect(h.engines.length).toBe(1);
    expect(h.engines[0].started).toBe(1);

    h.engines[0].callbacks.onStart();
    const status = h.manager.getStatus();
    expect(status.state).toBe('listening');
    expect(status.language).toBe('fa-IR');
    expect(status.mode).toBe('cloud');
    expect(status.sessionCount).toBe(1);
  });

  it('interim results are previewed live but never committed', () => {
    const h = createHarness();
    h.manager.start(CONFIG, 'unavailable', 'note');
    h.engines[0].callbacks.onStart();

    h.engines[0].callbacks.onResult({ transcript: 'سلام', isFinal: false, confidence: 0 });
    expect(h.commit).not.toHaveBeenCalled();
    expect(h.preview).toHaveBeenCalledWith('سلام');
    expect(h.manager.getStatus().interimTranscript).toBe('سلام');

    h.engines[0].callbacks.onResult({ transcript: 'سلام دنیا', isFinal: true, confidence: 0.9 });
    expect(h.commit).toHaveBeenCalledTimes(1);
    expect(h.commit).toHaveBeenCalledWith('سلام دنیا');
    const status = h.manager.getStatus();
    expect(status.lastFinalTranscript).toBe('سلام دنیا');
    expect(status.uncommittedTranscript).toBeNull();
    expect(status.state).toBe('listening');
  });

  it('routes a corrected cumulative final through target replacement', () => {
    const h = createHarness();
    h.manager.start(CONFIG, 'unavailable', 'note');
    h.engines[0].callbacks.onStart();

    h.engines[0].callbacks.onResult({ transcript: ' th', isFinal: true, confidence: 1 });
    h.engines[0].callbacks.onResult({
      transcript: ' this is the second test',
      isFinal: true,
      confidence: 1,
      replaces: ' th',
    });

    expect(h.commit).toHaveBeenCalledTimes(1);
    expect(h.replace).toHaveBeenCalledWith(' this is the second test', ' th');
  });

  it('skips the live preview for blank interim results', () => {
    const h = createHarness();
    h.manager.start(CONFIG, 'unavailable', 'note');
    h.engines[0].callbacks.onStart();

    h.engines[0].callbacks.onResult({ transcript: '', isFinal: false, confidence: 0 });
    h.engines[0].callbacks.onResult({ transcript: '   ', isFinal: false, confidence: 0 });
    expect(h.preview).not.toHaveBeenCalled();
  });

  it('keeps the live preview alive across an auto-restart', () => {
    const h = createHarness();
    h.manager.start(CONFIG, 'unavailable', 'note');
    h.engines[0].callbacks.onStart();

    h.engines[0].callbacks.onResult({ transcript: 'نیمه‌تمام', isFinal: false, confidence: 0 });
    h.engines[0].callbacks.onEnd();
    expect(h.manager.getStatus().state).toBe('restarting');
    expect(h.resetPreview).not.toHaveBeenCalled();

    vi.advanceTimersByTime(150);
    h.engines[1].callbacks.onStart();
    // the next session keeps replacing the same preview
    h.engines[1].callbacks.onResult({ transcript: 'نیمه‌تمام جمله', isFinal: false, confidence: 0 });
    expect(h.preview).toHaveBeenLastCalledWith('نیمه‌تمام جمله');
    expect(h.resetPreview).not.toHaveBeenCalled();
  });

  it('resets the live preview when dictation ends for good', () => {
    const h = createHarness();
    h.manager.start(CONFIG, 'unavailable', 'note');
    h.engines[0].callbacks.onStart();
    h.engines[0].callbacks.onResult({ transcript: 'نیمه‌تمام', isFinal: false, confidence: 0 });

    h.manager.stop();
    h.engines[0].callbacks.onEnd();
    expect(h.manager.getStatus().state).toBe('idle');
    expect(h.resetPreview).toHaveBeenCalledTimes(1);
  });

  it('applies voice commands to final transcripts before committing', () => {
    const h = createHarness();
    h.manager.start(CONFIG, 'unavailable', 'note');
    h.engines[0].callbacks.onStart();

    h.engines[0].callbacks.onResult({ transcript: 'سلام دنیا ویرگول', isFinal: true, confidence: 1 });
    expect(h.commit).toHaveBeenCalledWith('سلام دنیا،');
    expect(h.manager.getStatus().lastFinalTranscript).toBe('سلام دنیا،');
  });

  it('applies voice commands to the live preview so it matches the commit', () => {
    const h = createHarness();
    h.manager.start(CONFIG, 'unavailable', 'note');
    h.engines[0].callbacks.onStart();

    h.engines[0].callbacks.onResult({ transcript: 'سلام ویرگول', isFinal: false, confidence: 0 });
    expect(h.preview).toHaveBeenCalledWith('سلام،');
    expect(h.manager.getStatus().interimTranscript).toBe('سلام،');
  });

  it('commits pure formatting commands instead of typing them', () => {
    const h = createHarness();
    h.manager.start(CONFIG, 'unavailable', 'note');
    h.engines[0].callbacks.onStart();

    h.engines[0].callbacks.onResult({ transcript: 'خط جدید', isFinal: true, confidence: 1 });
    expect(h.commit).toHaveBeenCalledWith('\n');
  });

  it('can disable voice commands via setVoiceCommands', () => {
    const h = createHarness();
    h.manager.start(CONFIG, 'unavailable', 'note');
    h.engines[0].callbacks.onStart();
    h.manager.setVoiceCommands(false);

    h.engines[0].callbacks.onResult({ transcript: 'سلام ویرگول', isFinal: true, confidence: 1 });
    expect(h.commit).toHaveBeenCalledWith('سلام ویرگول');
  });

  it('converts spoken numbers on FINAL results when numbersAsDigits is on', () => {
    const h = createHarness();
    h.manager.start(CONFIG, 'unavailable', 'note');
    h.engines[0].callbacks.onStart();
    h.manager.setNumbersAsDigits(true);

    h.engines[0].callbacks.onResult({ transcript: 'بیست و پنج فایل', isFinal: true, confidence: 1 });
    expect(h.commit).toHaveBeenCalledWith('25 فایل');
    expect(h.manager.getStatus().lastFinalTranscript).toBe('25 فایل');
  });

  it('does NOT convert spoken numbers while numbersAsDigits is off (default)', () => {
    const h = createHarness();
    h.manager.start(CONFIG, 'unavailable', 'note');
    h.engines[0].callbacks.onStart();

    h.engines[0].callbacks.onResult({ transcript: 'بیست و پنج فایل', isFinal: true, confidence: 1 });
    expect(h.commit).toHaveBeenCalledWith('بیست و پنج فایل');
  });

  it('never applies number conversion to interim results (live preview)', () => {
    const h = createHarness();
    h.manager.start(CONFIG, 'unavailable', 'note');
    h.engines[0].callbacks.onStart();
    h.manager.setNumbersAsDigits(true);

    h.engines[0].callbacks.onResult({ transcript: 'بیست و پنج', isFinal: false, confidence: 0 });
    expect(h.preview).toHaveBeenCalledWith('بیست و پنج');
    expect(h.manager.getStatus().interimTranscript).toBe('بیست و پنج');
  });

  it('runs number conversion AFTER voice commands on the same final result', () => {
    const h = createHarness();
    h.manager.start(CONFIG, 'unavailable', 'note');
    h.engines[0].callbacks.onStart();
    h.manager.setNumbersAsDigits(true);

    // «پنج» stays a word (voice commands don't touch numbers), then gets
    // converted by the number stage; the command word is applied first.
    h.engines[0].callbacks.onResult(
      { transcript: 'قیمت پنج هزار ویرگول', isFinal: true, confidence: 1 },
    );
    expect(h.commit).toHaveBeenCalledWith('قیمت 5000،');
  });

  it('reports the selected language even before a session starts', () => {
    const h = createHarness();
    expect(h.manager.getStatus().language).toBeNull();
    h.manager.setSelectedLanguage('en-US');
    expect(h.manager.getStatus().language).toBe('en-US');
  });

  it('uses the selected language after stopping and changing the idle preference', () => {
    const h = createHarness();
    h.manager.setSelectedLanguage('fa-IR');
    h.manager.start(CONFIG, 'unavailable', 'note');
    h.engines[0].callbacks.onStart();
    h.manager.stop();
    h.engines[0].callbacks.onEnd();
    h.manager.setSelectedLanguage('en-US');

    expect(h.manager.getStatus()).toMatchObject({ state: 'idle', language: 'en-US' });
    expect(h.statuses[h.statuses.length - 1]?.language).toBe('en-US');
  });

  it('retains the active config language through starting, processing, restarting and stopping', () => {
    const h = createHarness();
    h.manager.setSelectedLanguage('en-US');
    h.manager.start(CONFIG, 'unavailable', 'note');
    expect(h.manager.getStatus()).toMatchObject({ state: 'starting', language: 'fa-IR' });
    h.engines[0].callbacks.onStart();
    h.manager.setSelectedLanguage('en-US');
    expect(h.manager.getStatus()).toMatchObject({ state: 'listening', language: 'fa-IR' });
    h.commit.mockImplementationOnce(() => {
      expect(h.manager.getStatus()).toMatchObject({ state: 'processing', language: 'fa-IR' });
      return { ok: true, target: null };
    });
    h.engines[0].callbacks.onResult({ transcript: 'سلام', isFinal: true, confidence: 1 });
    h.engines[0].callbacks.onEnd();
    expect(h.manager.getStatus()).toMatchObject({ state: 'restarting', language: 'fa-IR' });
    vi.advanceTimersByTime(150);
    h.engines[1].callbacks.onStart();
    h.manager.stop();
    expect(h.manager.getStatus()).toMatchObject({ state: 'stopping', language: 'fa-IR' });
    h.engines[1].callbacks.onEnd();
    expect(h.manager.getStatus()).toMatchObject({ state: 'idle', language: 'en-US' });
  });

  it('falls back to the last config language when no preference has been selected', () => {
    const h = createHarness();
    h.manager.start(CONFIG, 'unavailable', 'note');
    h.manager.stop();
    h.engines[0].callbacks.onEnd();
    expect(h.manager.getStatus()).toMatchObject({ state: 'idle', language: 'fa-IR' });
  });

  it('invalidates the previous session before synchronous abort callbacks', () => {
    const h = createHarness();
    h.manager.start(CONFIG, 'unavailable', 'note');
    h.engines[0].callbacks.onStart();
    vi.spyOn(h.engines[0], 'abort').mockImplementation(() => {
      h.engines[0].callbacks.onResult({ transcript: 'stale', isFinal: true, confidence: 1 });
      h.engines[0].callbacks.onEnd();
      h.engines[0].callbacks.onError({ code: 'not-allowed' });
    });

    h.manager.start(CONFIG, 'unavailable', 'note');
    h.engines[1].callbacks.onStart();
    vi.advanceTimersByTime(10_000);
    expect(h.commit).not.toHaveBeenCalled();
    expect(h.resetPreview).not.toHaveBeenCalled();
    expect(h.manager.getStatus()).toMatchObject({ state: 'listening', lastError: null, restartCount: 0 });
    expect(h.engines).toHaveLength(2);
  });

  it('ignores stale engine events from an aborted previous session', () => {
    const h = createHarness();
    h.manager.start(CONFIG, 'unavailable', 'note');
    h.engines[0].callbacks.onStart();
    h.engines[0].callbacks.onResult({ transcript: 'سلام', isFinal: true, confidence: 1 });
    expect(h.commit).toHaveBeenCalledTimes(1);

    // Badge Start while the old engine is still winding down: manager.start()
    // aborts it and opens session #2.
    h.manager.start(CONFIG, 'unavailable', 'note');
    h.engines[1].callbacks.onStart();

    // The aborted engine's late onend/onresult arrive AFTER session #2 is
    // live — they must NOT schedule a restart (second concurrent session
    // would repeat every spoken word) nor commit duplicate text.
    h.engines[0].callbacks.onEnd();
    h.engines[0].callbacks.onResult({ transcript: 'سلام', isFinal: true, confidence: 1 });

    expect(h.commit).toHaveBeenCalledTimes(1);
    expect(h.manager.getStatus().state).toBe('listening');
    vi.advanceTimersByTime(5000); // any pending restart timer would fire here
    expect(h.engines.length).toBe(2);
  });

  it('never silently discards a final result when insertion fails', () => {
    const h = createHarness();
    h.manager.start(CONFIG, 'unavailable', 'note');
    h.engines[0].callbacks.onStart();
    h.setCommit({ ok: false, error: 'element removed from the document', target: null });

    h.engines[0].callbacks.onResult({ transcript: 'متن گم‌شده', isFinal: true, confidence: 1 });
    const status = h.manager.getStatus();
    expect(status.uncommittedTranscript).toBe('متن گم‌شده');
    expect(status.lastError?.code).toBe('insert-failed');
    expect(status.lastError?.message).toMatch(/removed/);
  });

  it('ignores empty final transcripts instead of committing them', () => {
    const h = createHarness();
    h.manager.start(CONFIG, 'unavailable', 'note');
    h.engines[0].callbacks.onStart();

    h.engines[0].callbacks.onResult({ transcript: 'سلام', isFinal: true, confidence: 1 });
    // Chrome emits empty finals at utterance boundaries (seen in real fa-IR logs).
    h.engines[0].callbacks.onResult({ transcript: '', isFinal: true, confidence: 0 });
    h.engines[0].callbacks.onResult({ transcript: '   ', isFinal: true, confidence: 0 });

    expect(h.commit).toHaveBeenCalledTimes(1);
    const status = h.manager.getStatus();
    expect(status.lastFinalTranscript).toBe('سلام');
    expect(status.uncommittedTranscript).toBeNull();
    expect(status.state).toBe('listening');
  });

  it('commits the stop-flushed final result but returns to stopping, not listening', () => {
    const h = createHarness();
    h.manager.start(CONFIG, 'unavailable', 'note');
    h.engines[0].callbacks.onStart();

    h.manager.stop();
    expect(h.manager.getStatus().state).toBe('stopping');

    // Chrome flushes the last utterance right after stop() (seen in real logs).
    h.engines[0].callbacks.onResult({ transcript: 'آخرین جمله', isFinal: true, confidence: 1 });
    expect(h.commit).toHaveBeenCalledWith('آخرین جمله');
    expect(h.manager.getStatus().state).toBe('stopping');

    h.engines[0].callbacks.onEnd();
    expect(h.manager.getStatus().state).toBe('idle');
    vi.advanceTimersByTime(10_000);
    expect(h.engines.length).toBe(1); // no restart after an explicit user stop
  });

  it('drops a late result that arrives after the session already ended', () => {
    const h = createHarness();
    h.manager.start(CONFIG, 'unavailable', 'note');
    h.engines[0].callbacks.onStart();

    h.manager.stop();
    h.engines[0].callbacks.onEnd(); // resetPreview keeps the preview as real text
    expect(h.manager.getStatus().state).toBe('idle');

    // Chrome can deliver one more result PAST onend when a stop interrupts an
    // utterance. Committing it would duplicate words resetPreview already
    // kept — it must be dropped.
    h.engines[0].callbacks.onResult({ transcript: 'دوباره', isFinal: true, confidence: 1 });
    h.engines[0].callbacks.onResult({ transcript: ' پیش‌نویس', isFinal: false, confidence: 0.9 });

    expect(h.commit).not.toHaveBeenCalled();
    expect(h.preview).not.toHaveBeenCalled();
    expect(h.manager.getStatus().state).toBe('idle');
  });

  it('auto-restarts after a normal session end while still dictating', () => {
    const h = createHarness();
    h.manager.start(CONFIG, 'unavailable', 'note');
    h.engines[0].callbacks.onStart();

    h.engines[0].callbacks.onEnd();
    expect(h.manager.getStatus().state).toBe('restarting');

    vi.advanceTimersByTime(150);
    expect(h.engines.length).toBe(2);
    expect(h.engines[1].started).toBe(1);
    h.engines[1].callbacks.onStart();
    expect(h.manager.getStatus().state).toBe('listening');
    expect(h.manager.getStatus().restartCount).toBe(1);
  });

  it('stops immediately during restart backoff without waiting for another end event', () => {
    const h = createHarness();
    h.manager.start(CONFIG, 'unavailable', 'note');
    const engine = h.engines[0];
    engine.callbacks.onStart();
    engine.callbacks.onResult({ transcript: 'pending', isFinal: false, confidence: 0 });
    engine.callbacks.onEnd();
    expect(h.manager.getStatus().state).toBe('restarting');

    h.manager.stop();
    expect(h.manager.getStatus()).toMatchObject({ state: 'idle', interimTranscript: '', lastEvent: 'stop' });
    expect(h.resetPreview).toHaveBeenCalledTimes(1);
    expect(engine.stopped).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    const status = h.manager.getStatus();
    engine.callbacks.onStart();
    engine.callbacks.onResult({ transcript: 'late', isFinal: true, confidence: 1 });
    engine.callbacks.onError({ code: 'not-allowed' });
    engine.callbacks.onEnd();
    expect(h.manager.getStatus()).toEqual(status);
    expect(h.commit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(10_000);
    expect(h.engines).toHaveLength(1);
    h.manager.stop();
    expect(h.resetPreview).toHaveBeenCalledTimes(1);
    h.manager.start(CONFIG, 'unavailable', 'note');
    h.engines[1].callbacks.onStart();
    expect(h.manager.getStatus().state).toBe('listening');
    expect(engine.aborted).toBe(0);
  });

  it('ignores all callbacks from an ended engine during restart backoff', () => {
    const h = createHarness();
    h.manager.start(CONFIG, 'unavailable', 'note');
    const { callbacks } = h.engines[0];
    callbacks.onStart();
    callbacks.onEnd();
    const status = h.manager.getStatus();
    callbacks.onStart();
    callbacks.onResult({ transcript: 'late', isFinal: false, confidence: 0 });
    callbacks.onResult({ transcript: 'late', isFinal: true, confidence: 1 });
    callbacks.onError({ code: 'not-allowed' });
    callbacks.onEnd();
    expect(h.manager.getStatus()).toEqual(status);
    expect(h.preview).not.toHaveBeenCalled();
    expect(h.commit).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(10_000);
    expect(h.engines).toHaveLength(2);
    expect(h.manager.getStatus().sessionCount).toBe(2);
  });

  it('ignores a delayed start after Stop while preserving synchronous stop-flush results', () => {
    const h = createHarness();
    h.manager.start(CONFIG, 'unavailable', 'note');
    const { callbacks } = h.engines[0];
    vi.spyOn(h.engines[0], 'stop').mockImplementation(() => {
      callbacks.onStart();
      expect(h.manager.getStatus().state).toBe('stopping');
      callbacks.onResult({ transcript: 'flushed', isFinal: true, confidence: 1 });
      expect(h.manager.getStatus().state).toBe('stopping');
      callbacks.onEnd();
    });
    h.manager.stop();
    expect(h.commit).toHaveBeenCalledExactlyOnceWith('flushed');
    expect(h.manager.getStatus().state).toBe('idle');
    expect(h.resetPreview).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(10_000);
    expect(h.engines).toHaveLength(1);
  });

  it('never restarts after an explicit user stop', () => {
    const h = createHarness();
    h.manager.start(CONFIG, 'unavailable', 'note');
    h.engines[0].callbacks.onStart();

    h.manager.stop();
    expect(h.manager.getStatus().state).toBe('stopping');
    expect(h.engines[0].stopped).toBe(1);

    h.engines[0].callbacks.onEnd();
    expect(h.manager.getStatus().state).toBe('idle');
    vi.advanceTimersByTime(10_000);
    expect(h.engines.length).toBe(1);
  });
});

describe('RecognitionManager error handling', () => {
  it.each([
    ['factory', false],
    ['start', false],
    ['factory', true],
    ['start', true],
  ] as const)('reports a fatal synchronous %s failure (auto-restart: %s)', (failure, restarting) => {
    const h = createHarness();
    if (restarting) {
      h.manager.start(CONFIG, 'unavailable', 'note');
      h.engines[0].callbacks.onStart();
      h.engines[0].callbacks.onResult({ transcript: 'pending', isFinal: false, confidence: 0 });
      h.engines[0].callbacks.onEnd();
    }
    h.engineFactory.mockImplementationOnce((config, callbacks) => {
      if (failure === 'factory') throw new Error('factory failed');
      const engine = new FakeEngine(config, callbacks);
      h.engines.push(engine);
      vi.spyOn(engine, 'start').mockImplementation(() => {
        throw new Error('start failed');
      });
      vi.spyOn(engine, 'abort').mockImplementation(() => {
        callbacks.onStart();
        callbacks.onError({ code: 'not-allowed' });
        callbacks.onEnd();
        throw new Error('abort failed');
      });
      return engine;
    });

    expect(() => {
      if (restarting) vi.advanceTimersByTime(150);
      else h.manager.start(CONFIG, 'unavailable', 'note');
    }).not.toThrow();
    const status = h.manager.getStatus();
    expect(status).toMatchObject({
      state: 'error',
      lastEvent: 'onerror:start-failed',
      lastError: { code: 'start-failed', message: 'Recognition could not be started.' },
      interimTranscript: '',
      sessionCount: restarting ? 2 : 1,
    });
    expect(h.statuses[h.statuses.length - 1]).toEqual(status);
    expect(h.resetPreview).toHaveBeenCalledTimes(1);
    if (failure === 'start') expect(h.engines[h.engines.length - 1]?.abort).toHaveBeenCalledTimes(1);
    const callbacks = h.engineFactory.mock.calls[h.engineFactory.mock.calls.length - 1]![1];
    callbacks.onStart();
    callbacks.onResult({ transcript: 'late', isFinal: true, confidence: 1 });
    callbacks.onResult({ transcript: 'late', isFinal: false, confidence: 0 });
    callbacks.onError({ code: 'network' });
    callbacks.onEnd();
    expect(h.manager.getStatus()).toEqual(status);
    expect(h.commit).not.toHaveBeenCalled();
    expect(h.preview).toHaveBeenCalledTimes(restarting ? 1 : 0);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(10_000);
    expect(h.engineFactory).toHaveBeenCalledTimes(restarting ? 2 : 1);
    h.manager.stop();
    expect(h.manager.getStatus()).toMatchObject({ state: 'idle', lastError: status.lastError });
    h.manager.start(CONFIG, 'unavailable', 'note');
    callbacks.onEnd();
    h.engines[h.engines.length - 1]!.callbacks.onStart();
    expect(h.manager.getStatus()).toMatchObject({ state: 'listening', lastError: null });
  });

  it('stops on hard errors and never restarts', () => {
    const h = createHarness();
    h.manager.start(CONFIG, 'unavailable', 'note');
    h.engines[0].callbacks.onStart();

    h.engines[0].callbacks.onError({ code: 'not-allowed' });
    const status = h.manager.getStatus();
    expect(status.state).toBe('error');
    expect(status.lastError?.message).toMatch(/permission was denied/i);

    h.engines[0].callbacks.onEnd();
    expect(h.manager.getStatus().state).toBe('idle');
    vi.advanceTimersByTime(10_000);
    expect(h.engines.length).toBe(1);
  });

  it('recovers from network errors by restarting', () => {
    const h = createHarness();
    h.manager.start(CONFIG, 'unavailable', 'note');
    h.engines[0].callbacks.onStart();

    h.engines[0].callbacks.onError({ code: 'network' });
    expect(h.manager.getStatus().lastError?.code).toBe('network');
    expect(h.manager.getStatus().state).toBe('listening');

    h.engines[0].callbacks.onEnd();
    vi.advanceTimersByTime(300);
    expect(h.engines.length).toBe(2);
  });

  it('reports a lost target instead of talking into the void', () => {
    const h = createHarness();
    h.manager.start(CONFIG, 'unavailable', 'note');
    h.engines[0].callbacks.onStart();
    h.setValidation({ ok: false, reason: 'element removed from the document' });

    h.engines[0].callbacks.onEnd();
    const status = h.manager.getStatus();
    expect(status.state).toBe('error');
    expect(status.lastError?.code).toBe('target-lost');
    vi.advanceTimersByTime(10_000);
    expect(h.engines.length).toBe(1);
  });

  it('gives up after repeated result-less restarts instead of looping forever', () => {
    const h = createHarness();
    h.manager.start(CONFIG, 'unavailable', 'note');

    for (let i = 0; i < MAX_CONSECUTIVE_EMPTY_RESTARTS; i++) {
      h.engines[h.engines.length - 1].callbacks.onEnd();
      vi.advanceTimersByTime(3000);
    }

    const status = h.manager.getStatus();
    expect(status.state).toBe('error');
    expect(status.lastError?.code).toBe('give-up-restarts');
    expect(h.engines.length).toBe(MAX_CONSECUTIVE_EMPTY_RESTARTS);
    vi.advanceTimersByTime(10_000);
    expect(h.engines.length).toBe(MAX_CONSECUTIVE_EMPTY_RESTARTS);
  });

  it('resets the empty-restart counter once results arrive again', () => {
    const h = createHarness();
    h.manager.start(CONFIG, 'unavailable', 'note');
    h.engines[0].callbacks.onStart();

    // two result-less sessions...
    h.engines[0].callbacks.onEnd();
    vi.advanceTimersByTime(300);
    h.engines[1].callbacks.onEnd();
    vi.advanceTimersByTime(600);

    // ...then a productive one
    h.engines[2].callbacks.onStart();
    h.engines[2].callbacks.onResult({ transcript: 'hi', isFinal: true, confidence: 1 });
    h.engines[2].callbacks.onEnd();
    vi.advanceTimersByTime(150);
    h.engines[3].callbacks.onStart();

    // consecutive empty restarts restarted from 0 → more failures are tolerated
    h.engines[3].callbacks.onEnd();
    vi.advanceTimersByTime(150);
    expect(h.engines.length).toBe(5);
    expect(h.manager.getStatus().state).not.toBe('error');
  });

  it('reports a missing target through reportNoTarget', () => {
    const h = createHarness();
    h.manager.reportNoTarget();
    const status = h.manager.getStatus();
    expect(status.lastError?.code).toBe('no-target');
    expect(status.lastError?.message).toMatch(/Focus a text field first/);
  });
});

