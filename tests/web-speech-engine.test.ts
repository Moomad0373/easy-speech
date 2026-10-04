import { afterEach, describe, expect, it, vi } from 'vitest';
import { STOP_FLUSH_FAILSAFE_MS } from '../src/shared/constants';
import type {
  SpeechRecognitionErrorEventLike,
  SpeechRecognitionEventLike,
  SpeechRecognitionLike,
  SpeechRecognitionResultListLike,
} from '../src/types/speech-recognition';
import { WebSpeechEngine } from '../src/content/recognition/engine/WebSpeechEngine';

class FakeRecognition implements SpeechRecognitionLike {
  lang = '';
  continuous = false;
  interimResults = false;
  maxAlternatives = 1;
  startCalls = 0;
  stopCalls = 0;
  abortCalls = 0;
  onstart: ((event?: unknown) => void) | null = null;
  onaudiostart: ((event?: unknown) => void) | null = null;
  onsoundstart: ((event?: unknown) => void) | null = null;
  onspeechstart: ((event?: unknown) => void) | null = null;
  onspeechend: ((event?: unknown) => void) | null = null;
  onsoundend: ((event?: unknown) => void) | null = null;
  onaudioend: ((event?: unknown) => void) | null = null;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null = null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null = null;
  onend: (() => void) | null = null;
  onnomatch: ((event?: unknown) => void) | null = null;

  start(): void {
    this.startCalls += 1;
  }
  stop(): void {
    this.stopCalls += 1;
  }
  abort(): void {
    this.abortCalls += 1;
  }
}

type ResultSpec = { transcript: string; isFinal: boolean };

function emit(recognition: FakeRecognition, resultIndex: number, results: ResultSpec[]): void {
  const list = results.map((r) => ({
    isFinal: r.isFinal,
    length: 1,
    0: { transcript: r.transcript, confidence: r.isFinal ? 0.9 : 0 },
  }));
  recognition.onresult?.({
    resultIndex,
    results: list as unknown as SpeechRecognitionResultListLike,
  });
}

function createEngine() {
  const recognition = new FakeRecognition();
  const onResult = vi.fn();
  const onEnd = vi.fn();
  const engine = new WebSpeechEngine(
    { language: 'fa-IR', mode: 'cloud' },
    { onStart: vi.fn(), onResult, onError: vi.fn(), onEnd }
  );
  // getSpeechRecognitionCtor() resolves globalThis.SpeechRecognition and the
  // engine does `new ctor()` — so the stub must be a real constructible class.
  class StubCtor {
    constructor() {
      return recognition as unknown as StubCtor;
    }
  }
  vi.stubGlobal('SpeechRecognition', StubCtor);
  engine.start();
  return { engine, recognition, onResult, onEnd };
}

function interimsOf(onResult: ReturnType<typeof vi.fn>): string[] {
  return onResult.mock.calls.filter((call) => call[0].isFinal === false).map((call) => call[0].transcript as string);
}

function finalsOf(onResult: ReturnType<typeof vi.fn>): string[] {
  return onResult.mock.calls.filter((call) => call[0].isFinal === true).map((call) => call[0].transcript as string);
}

function lastInterim(onResult: ReturnType<typeof vi.fn>): string {
  const interims = interimsOf(onResult);
  return interims[interims.length - 1] ?? '';
}

describe('WebSpeechEngine result dispatch', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('combines fragmented interim results into the full pending text (fa-IR log scenario)', () => {
    const { recognition, onResult } = createEngine();

    emit(recognition, 0, [{ transcript: ' مدل', isFinal: false }]);
    expect(lastInterim(onResult)).toBe(' مدل');

    emit(recognition, 0, [{ transcript: ' دل‌های', isFinal: false }]);
    expect(lastInterim(onResult)).toBe(' دل‌های');

    emit(recognition, 0, [{ transcript: ' دل‌های گوگل', isFinal: false }]);

    // Chrome splits the utterance into two live results (real logs).
    emit(recognition, 0, [
      { transcript: ' دل‌های', isFinal: false },
      { transcript: ' گوگل', isFinal: false },
    ]);
    expect(lastInterim(onResult)).toBe(' دل‌های گوگل');

    emit(recognition, 0, [
      { transcript: ' دل‌های', isFinal: false },
      { transcript: ' گوگل که', isFinal: false },
    ]);
    expect(lastInterim(onResult)).toBe(' دل‌های گوگل که');

    // Chrome merges everything back into the first result and drops the
    // second result from the list — the fragment is absorbed, not duplicated.
    emit(recognition, 0, [{ transcript: ' دل‌های گوگل که', isFinal: false }]);
    expect(lastInterim(onResult)).toBe(' دل‌های گوگل که');

    // Same merge, but the stale fragment is still present in the list.
    emit(recognition, 0, [
      { transcript: ' دل‌های گوگل که', isFinal: false },
      { transcript: ' که', isFinal: false },
    ]);
    expect(lastInterim(onResult)).toBe(' دل‌های گوگل که');
  });

  it('keeps later pending fragments visible when an earlier fragment finalizes', () => {
    const { recognition, onResult } = createEngine();

    emit(recognition, 0, [
      { transcript: ' یک', isFinal: false },
      { transcript: ' دو', isFinal: false },
    ]);
    expect(lastInterim(onResult)).toBe(' یک دو');

    // Chrome finalizes result 0 while result 1 stays live (the list keeps
    // both entries).
    emit(recognition, 0, [
      { transcript: ' یک', isFinal: true },
      { transcript: ' دو', isFinal: false },
    ]);
    expect(finalsOf(onResult)).toEqual([' یک']);
    expect(lastInterim(onResult)).toBe(' دو');
  });

  it('dispatches the final exactly once and never emits a trailing empty interim', () => {
    const { recognition, onResult } = createEngine();

    emit(recognition, 0, [{ transcript: ' سلام', isFinal: false }]);
    emit(recognition, 0, [{ transcript: ' سلام دنیا', isFinal: true }]);

    expect(finalsOf(onResult)).toEqual([' سلام دنیا']);
    expect(interimsOf(onResult)).toEqual([' سلام']);
  });

  it('never re-dispatches an already finalized result', () => {
    const { recognition, onResult } = createEngine();

    emit(recognition, 0, [{ transcript: ' done', isFinal: true }]);
    emit(recognition, 0, [{ transcript: ' done', isFinal: true }]); // pathological re-emit
    expect(finalsOf(onResult)).toEqual([' done']);
  });

  it('does not re-emit unchanged interim text', () => {
    const { recognition, onResult } = createEngine();

    emit(recognition, 0, [{ transcript: ' hello', isFinal: false }]);
    expect(interimsOf(onResult)).toHaveLength(1);
    emit(recognition, 0, [{ transcript: ' hello', isFinal: false }]);
    expect(interimsOf(onResult)).toHaveLength(1);
  });

  it('suppresses a stale fragment that finalizes after its covering result', () => {
    // Chrome re-segmentation (the reported bug): index 0 finalizes as
    // " beautiful day" while a stale index 1 still holds " day". Finalizing
    // that fragment later must NOT commit " day" again — that duplication
    // typed every covered word twice ("beautiful day day").
    const { recognition, onResult } = createEngine();

    emit(recognition, 0, [
      { transcript: ' beautiful', isFinal: false },
      { transcript: ' day', isFinal: false },
    ]);
    expect(lastInterim(onResult)).toBe(' beautiful day');

    emit(recognition, 0, [
      { transcript: ' beautiful day', isFinal: false },
      { transcript: ' day', isFinal: false },
    ]);
    expect(lastInterim(onResult)).toBe(' beautiful day');

    emit(recognition, 0, [
      { transcript: ' beautiful day', isFinal: true },
      { transcript: ' day', isFinal: false },
    ]);
    expect(finalsOf(onResult)).toEqual([' beautiful day']);
    // no trailing interim composed of the stale fragment
    expect(interimsOf(onResult)).toHaveLength(2);

    // The leftover fragment now finalizes on its own — suppressed, not committed.
    emit(recognition, 1, [{ transcript: ' day', isFinal: true }]);
    expect(finalsOf(onResult)).toEqual([' beautiful day']);
  });

  it('never re-commits a fragment absorbed by an earlier LIVE result', () => {
    // The live/live absorption must also be permanent: a fragment dropped from
    // the interim combination must not re-enter as a final when Chrome later
    // finalizes it.
    const { recognition, onResult } = createEngine();

    emit(recognition, 0, [
      { transcript: ' hello world', isFinal: false },
      { transcript: ' world', isFinal: false },
    ]);
    expect(lastInterim(onResult)).toBe(' hello world');

    emit(recognition, 1, [{ transcript: ' world', isFinal: true }]);
    expect(finalsOf(onResult)).toEqual([]);
  });

  it('treats a covered fragment as fresh when it grows past its cover', () => {
    // Suppression is text-based, so a fragment that Chrome revises into words
    // the cover no longer contains is genuine new content and must dispatch.
    const { recognition, onResult } = createEngine();

    emit(recognition, 0, [
      { transcript: ' great', isFinal: false },
      { transcript: ' day', isFinal: false },
    ]);
    emit(recognition, 0, [
      { transcript: ' great day', isFinal: true },
      { transcript: ' day', isFinal: false },
    ]);
    expect(finalsOf(onResult)).toEqual([' great day']);

    // The fragment at index 1 was covered by " great day"… but Chrome revises
    // it into genuinely new words, so it must dispatch (full list, as Chrome
    // keeps earlier finalized entries present).
    emit(recognition, 1, [
      { transcript: ' great day', isFinal: true },
      { transcript: ' dream', isFinal: true },
    ]);
    expect(finalsOf(onResult)).toEqual([' great day', ' dream']);
  });

  it('does not duplicate words across a multi-phrase continuous session', () => {
    // Two phrases, each leaving a stale fragment that later finalizes.
    // Chrome's results list keeps earlier finalized entries, so every event
    // carries the full list. Each phrase must be committed exactly once.
    const { recognition, onResult } = createEngine();

    // Phrase 1: index 0 (main) + index 1 (stale fragment)
    emit(recognition, 0, [
      { transcript: ' one two', isFinal: false },
      { transcript: ' two', isFinal: false },
    ]);
    emit(recognition, 0, [
      { transcript: ' one two', isFinal: true },
      { transcript: ' two', isFinal: false },
    ]);
    emit(recognition, 1, [
      { transcript: ' one two', isFinal: true },
      { transcript: ' two', isFinal: true },
    ]);
    // Phrase 2: index 2 (main) + index 3 (stale fragment)
    emit(recognition, 2, [
      { transcript: ' one two', isFinal: true },
      { transcript: ' two', isFinal: true },
      { transcript: ' three four', isFinal: false },
      { transcript: ' four', isFinal: false },
    ]);
    emit(recognition, 2, [
      { transcript: ' one two', isFinal: true },
      { transcript: ' two', isFinal: true },
      { transcript: ' three four', isFinal: true },
      { transcript: ' four', isFinal: false },
    ]);
    emit(recognition, 3, [
      { transcript: ' one two', isFinal: true },
      { transcript: ' two', isFinal: true },
      { transcript: ' three four', isFinal: true },
      { transcript: ' four', isFinal: true },
    ]);

    expect(finalsOf(onResult)).toEqual([' one two', ' three four']);
  });

  it('starts a fresh pending utterance after a final result', () => {
    const { recognition, onResult } = createEngine();

    emit(recognition, 0, [{ transcript: ' first', isFinal: true }]);
    emit(
      recognition,
      1,
      [
        { transcript: ' first', isFinal: true },
        { transcript: ' second', isFinal: false },
      ]
    );
    expect(lastInterim(onResult)).toBe(' second');
  });

  it('drops a stale prefix fragment when a later fragment already contains its words', () => {
    // Chrome re-segmentation can leave an OLD fragment at index 0 alive
    // while emitting a NEW fragment at index 1 whose text contains the old
    // fragment's words. Concatenating naively yields duplicated words
    // (" hello  hello world"); the old prefix must be suppressed.
    const { recognition, onResult } = createEngine();

    emit(recognition, 0, [{ transcript: ' hello', isFinal: false }]);
    expect(lastInterim(onResult)).toBe(' hello');

    emit(recognition, 0, [
      { transcript: ' hello', isFinal: false },
      { transcript: ' hello world', isFinal: false },
    ]);
    expect(lastInterim(onResult)).toBe(' hello world');
  });

  it('keeps adjacent word fragments separated when Chrome omits the space', () => {
    const { recognition, onResult } = createEngine();

    emit(recognition, 0, [
      { transcript: ' I want to press enter again', isFinal: false },
      { transcript: 'is the second test I will press enter in this section', isFinal: false },
    ]);

    expect(lastInterim(onResult)).toBe(
      ' I want to press enter again is the second test I will press enter in this section'
    );
  });

  it('dispatches only the new suffix of a later cumulative final', () => {
    const { recognition, onResult } = createEngine();

    emit(recognition, 0, [{ transcript: ' I want to press enter again', isFinal: false }]);
    emit(recognition, 0, [
      { transcript: ' I want to press enter again this is the second test', isFinal: false },
    ]);
    emit(recognition, 0, [{ transcript: ' I want to press enter again', isFinal: true }]);
    emit(recognition, 1, [
      { transcript: ' I want to press enter again', isFinal: true },
      {
        transcript: ' I want to press enter again this is the second test I will press enter in this section',
        isFinal: true,
      },
    ]);

    expect(finalsOf(onResult)).toEqual([
      ' I want to press enter again',
      ' this is the second test I will press enter in this section',
    ]);
  });

  it('keeps a short word as a new final result instead of treating it as a stale suffix', () => {
    const { recognition, onResult } = createEngine();

    emit(recognition, 0, [{ transcript: ' this', isFinal: true }]);
    emit(recognition, 1, [
      { transcript: ' this', isFinal: true },
      { transcript: ' is', isFinal: true },
    ]);

    expect(finalsOf(onResult)).toEqual([' this', ' is']);
  });

  it('suppresses an early partial final when a later cumulative fragment supersedes it', () => {
    const { recognition, onResult } = createEngine();

    emit(recognition, 0, [{ transcript: ' th', isFinal: false }]);
    emit(recognition, 0, [
      { transcript: ' th', isFinal: true },
      { transcript: ' this is the second test', isFinal: false },
    ]);
    expect(finalsOf(onResult)).toEqual([]);
    expect(lastInterim(onResult)).toBe(' this is the second test');

    emit(recognition, 1, [
      { transcript: ' th', isFinal: true },
      { transcript: ' this is the second test', isFinal: true },
    ]);
    expect(finalsOf(onResult)).toEqual([' this is the second test']);
  });

  it('replaces an early single-word final when a cumulative final adds words', () => {
    const { recognition, onResult } = createEngine();

    emit(recognition, 0, [{ transcript: ' I', isFinal: true }]);
    emit(recognition, 1, [
      { transcript: ' I', isFinal: true },
      { transcript: ' I want to test this extension', isFinal: true },
    ]);

    expect(finalsOf(onResult)).toEqual([' I', ' I want to test this extension']);
    expect(onResult.mock.calls[1]?.[0].replaces).toBe(' I');
  });

  it('replaces a one-word final when the browser grows it without a boundary', () => {
    const { recognition, onResult } = createEngine();

    emit(recognition, 0, [{ transcript: ' shit', isFinal: true }]);
    emit(recognition, 0, [{ transcript: ' shitwant to test this extension', isFinal: true }]);

    expect(finalsOf(onResult)).toEqual([' shit', ' shitwant to test this extension']);
    expect(onResult.mock.calls[1]?.[0].replaces).toBe(' shit');
  });

  it('keeps a boundary when a separate result grows from a longer word', () => {
    const { recognition, onResult } = createEngine();

    emit(recognition, 0, [{ transcript: ' shit', isFinal: true }]);
    emit(recognition, 1, [
      { transcript: ' shit', isFinal: true },
      { transcript: ' shitwant to test this extension', isFinal: true },
    ]);

    expect(finalsOf(onResult)).toEqual([' shit', ' want to test this extension']);
    expect(onResult.mock.calls[1]?.[0].replaces).toBeUndefined();
  });

  it('marks a later cumulative correction for replacement after an early partial final', () => {
    const { recognition, onResult } = createEngine();

    emit(recognition, 0, [{ transcript: ' th', isFinal: true }]);
    emit(recognition, 1, [
      { transcript: ' th', isFinal: true },
      { transcript: ' this is the second test', isFinal: true },
    ]);

    expect(finalsOf(onResult)).toEqual([' th', ' this is the second test']);
    expect(onResult.mock.calls[1]?.[0].replaces).toBe(' th');
  });

  it('clears per-session state on start so a reused engine never swallows a final', () => {
    const { engine, recognition, onResult } = createEngine();

    emit(recognition, 0, [{ transcript: ' done', isFinal: true }]);
    expect(finalsOf(onResult)).toEqual([' done']);

    // A new utterance (or a restarted session) reusing index 0 must dispatch
    // again — never be suppressed by the previous utterance's index.
    engine.start();
    emit(recognition, 0, [{ transcript: ' again', isFinal: true }]);
    expect(finalsOf(onResult)).toEqual([' done', ' again']);
  });

  it('configures continuous interim recognition for the session language', () => {
    const { recognition } = createEngine();
    expect(recognition.lang).toBe('fa-IR');
    expect(recognition.continuous).toBe(true);
    expect(recognition.interimResults).toBe(true);
    expect(recognition.maxAlternatives).toBe(1);
    expect(recognition.startCalls).toBe(1);
  });

  it('throws when the Web Speech API is unavailable', () => {
    vi.unstubAllGlobals();
    const engine = new WebSpeechEngine(
      { language: 'fa-IR', mode: 'cloud' },
      { onStart: vi.fn(), onResult: vi.fn(), onError: vi.fn(), onEnd: vi.fn() }
    );
    expect(() => engine.start()).toThrow(/not available/);
  });
});

describe('WebSpeechEngine stop failsafe', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('finishes once when stop and abort both omit onend', () => {
    vi.useFakeTimers();
    const { recognition, engine, onEnd, onResult } = createEngine();
    const lateEnd = recognition.onend!;
    const lateResult = recognition.onresult!;
    engine.stop();
    vi.advanceTimersByTime(STOP_FLUSH_FAILSAFE_MS);
    expect(onEnd).toHaveBeenCalledTimes(1);
    lateEnd();
    lateResult({ resultIndex: 0, results: [{ isFinal: true, length: 1, 0: { transcript: 'late', confidence: 1 } }] as unknown as SpeechRecognitionResultListLike });
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(onResult).not.toHaveBeenCalled();
  });

  it('aborts when onend never arrives after stop()', () => {
    vi.useFakeTimers();
    const { recognition, engine } = createEngine();
    engine.stop();
    expect(recognition.stopCalls).toBe(1);
    vi.advanceTimersByTime(STOP_FLUSH_FAILSAFE_MS);
    expect(recognition.abortCalls).toBe(1);
  });

  it('cancels the failsafe when onend arrives in time', () => {
    vi.useFakeTimers();
    const { recognition, engine } = createEngine();
    engine.stop();
    recognition.onend?.();
    vi.advanceTimersByTime(STOP_FLUSH_FAILSAFE_MS + 1000);
    expect(recognition.abortCalls).toBe(0);
  });
});
