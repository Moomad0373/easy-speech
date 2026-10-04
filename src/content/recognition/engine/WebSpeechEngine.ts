import { STOP_FLUSH_FAILSAFE_MS } from '../../../shared/constants';
import type {
  SpeechRecognitionErrorEventLike,
  SpeechRecognitionEventLike,
  SpeechRecognitionLike,
  SpeechRecognitionResultListLike,
} from '../../../types/speech-recognition';
import { getSpeechRecognitionCtor } from '../speechApi';
import type { EngineCallbacks, EngineConfig, SpeechEngine } from './SpeechEngine';

type FinalOverlap = {
  kind: 'contained' | 'extension';
  delta: string;
  previousIndex?: number;
  previousTranscript?: string;
};

function isWordCharacter(value: string | undefined): boolean {
  return value !== undefined && /[\p{L}\p{N}]/u.test(value);
}

function joinTranscriptParts(parts: string[]): string {
  let result = '';
  for (const part of parts) {
    if (part.length === 0) continue;
    const previous = result.charAt(result.length - 1);
    const next = part.charAt(0);
    if (isWordCharacter(previous) && isWordCharacter(next)) result += ' ';
    result += part;
  }
  return result;
}

function addTranscriptBoundary(previous: string, current: string): string {
  if (current.length === 0 || /\s$/u.test(previous) || /^\s/u.test(current)) return current;
  const previousCharacter = previous.charAt(previous.length - 1);
  const currentCharacter = current.charAt(0);
  return isWordCharacter(previousCharacter) && isWordCharacter(currentCharacter) ? ` ${current}` : current;
}

function hasShortFinalToken(text: string, maxLength = 4): boolean {
  const words = text.trim().split(/\s+/u);
  const lastWord = words[words.length - 1] ?? '';
  return [...lastWord].length <= maxLength;
}

function isShortFinalTranscript(text: string, maxLength = 4): boolean {
  const trimmed = text.trim();
  return trimmed.length > 0 && !/\s/u.test(trimmed) && [...trimmed].length <= maxLength;
}

function transcriptOverlap(previous: string, current: string): FinalOverlap | null {
  const previousText = previous.trim();
  const currentText = current.trim();
  if (previousText.length === 0 || currentText.length === 0) return null;
  if (
    currentText === previousText ||
    previousText.startsWith(currentText) ||
    previousText.endsWith(currentText) ||
    currentText.endsWith(previousText)
  ) {
    return { kind: 'contained', delta: '' };
  }
  if (currentText.startsWith(previousText)) {
    const currentStart = current.indexOf(currentText);
    return { kind: 'extension', delta: current.slice(currentStart + previousText.length) };
  }
  return null;
}

/**
 * Wraps exactly ONE SpeechRecognition instance. It never decides about
 * restarts — RecognitionManager owns that policy and creates a fresh engine
 * per session, so a broken instance is never reused (spec §6).
 */
export class WebSpeechEngine implements SpeechEngine {
  readonly config: EngineConfig;

  private recognition: SpeechRecognitionLike | null = null;
  private failsafeTimer: ReturnType<typeof setTimeout> | null = null;
  private finishSession: (() => void) | null = null;
  /** Latest transcript per live (non-final) result index. */
  private interimParts = new Map<number, string>();
  /** Result indexes and the last raw final transcript observed at each index. */
  private finalizedTexts = new Map<number, string>();
  private finalHistory: Array<{ index: number; transcript: string }> = [];
  /**
   * Live result indexes whose text is already contained in an EARLIER result's
   * transcript (Chrome's re-segmentation leaves such stale fragments behind).
   * Maps to the covering transcript, so a later finalization of the fragment is
   * recognized as a duplicate and skipped — unless the fragment has since grown
   * into words the cover no longer contains (then it is fresh content).
   */
  private coveredBy = new Map<number, string>();

  constructor(
    config: EngineConfig,
    private callbacks: EngineCallbacks
  ) {
    this.config = config;
  }

  start(): void {
    const ctor = getSpeechRecognitionCtor();
    if (!ctor) {
      throw new Error('Web Speech API is not available in this browser context.');
    }

    // Reset per-session state. A new SpeechRecognition instance is created, but
    // our own final/interim bookkeeping is instance state that survives across
    // recognitions. Without the reset, two real-world failures occur: Chrome
    // can re-emit a final result at resultIndex=0 for the SECOND utterance of a
    // continuous session, and the previous final could suppress the new one; a
    // stale interimParts entry concatenated with a new re-segmented index can
    // also produce duplicated text like " hello  hello world".
    this.interimParts.clear();
    this.finalizedTexts.clear();
    this.finalHistory = [];
    this.coveredBy.clear();

    const recognition = new ctor();
    recognition.lang = this.config.language;
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    // Feature-detect processLocally (Chrome 139+); cloud mode is explicitly
    // false, never "accidentally local" (spec §2, §7).
    if ('processLocally' in recognition) {
      recognition.processLocally = this.config.mode === 'local';
    }

    let ended = false;
    const finish = (): void => {
      if (ended) return;
      ended = true;
      this.clearFailsafe();
      this.recognition = null;
      this.finishSession = null;
      this.callbacks.onEnd();
    };
    this.finishSession = finish;
    recognition.onstart = () => { if (!ended) this.callbacks.onStart(); };
    recognition.onresult = (event: SpeechRecognitionEventLike) => { if (!ended) this.handleResult(event); };
    recognition.onerror = (event: SpeechRecognitionErrorEventLike) => {
      if (!ended) this.callbacks.onError({ code: event.error, message: event.message });
    };
    recognition.onend = finish;

    this.recognition = recognition;
    recognition.start();
  }

  stop(): void {
    const recognition = this.recognition;
    const finish = this.finishSession;
    if (!recognition || !finish || this.failsafeTimer !== null) return;
    this.failsafeTimer = setTimeout(() => {
      try {
        recognition.abort();
      } catch {}
      finish();
    }, STOP_FLUSH_FAILSAFE_MS);
    try {
      recognition.stop();
    } catch {
      try {
        recognition.abort();
      } catch {}
      finish();
    }
  }

  abort(): void {
    this.clearFailsafe();
    try {
      this.recognition?.abort();
    } catch {
      /* already ended */
    }
  }

  private clearFailsafe(): void {
    if (this.failsafeTimer !== null) {
      clearTimeout(this.failsafeTimer);
      this.failsafeTimer = null;
    }
  }

  /**
   * Chrome's re-segmentation can keep an OLD live fragment at a later index
   * whose text is already contained in result `index`'s transcript — e.g.
   * index 0 finalizes as " beautiful day" while a stale index 1 still holds
   * " day". Such a fragment is obsolete: its words were already dispatched.
   *
   * Recording the cover (rather than only deleting the fragment from the
   * interim combination, as the per-event `absorbed` set did) means the
   * fragment's own later finalization is recognized as a duplicate and
   * skipped; without it, every covered word was typed a second time.
   */
  private absorbLaterFragments(
    results: SpeechRecognitionResultListLike,
    index: number,
    transcript: string
  ): void {
    if (transcript.trim().length === 0) return;
    for (let j = index + 1; j < results.length; j++) {
      const later = results[j];
      if (!later) continue;
      if (this.coveredBy.has(j)) continue;
      const laterText = later[0]?.transcript;
      if (!laterText || laterText.trim().length === 0) continue;
      if (transcript.trimEnd().endsWith(laterText.trim())) {
        this.coveredBy.set(j, transcript);
        this.interimParts.delete(j);
      }
    }
  }

  private absorbEarlierPrefixFragments(results: SpeechRecognitionResultListLike): void {
    for (let i = 0; i < results.length; i += 1) {
      const first = results[i]?.[0]?.transcript;
      if (!first || first.trim().length === 0) continue;
      for (let j = i + 1; j < results.length; j += 1) {
        const later = results[j]?.[0]?.transcript;
        if (!later || later.trim().length === 0) continue;
        if (transcriptOverlap(first, later)?.kind !== 'extension') continue;
        this.coveredBy.set(i, later);
        this.interimParts.delete(i);
        break;
      }
    }
  }

  private findFinalOverlap(index: number, transcript: string): FinalOverlap | null {
    for (let i = this.finalHistory.length - 1; i >= 0; i -= 1) {
      const previous = this.finalHistory[i]!;
      if (previous.index > index) continue;
      const overlap = transcriptOverlap(previous.transcript, transcript);
      if (overlap?.kind === 'extension' || previous.index === index) {
        return overlap
          ? { ...overlap, previousIndex: previous.index, previousTranscript: previous.transcript }
          : null;
      }
    }
    return null;
  }

  private dispatchFinal(index: number, transcript: string, confidence: number): void {
    if (this.finalizedTexts.get(index) === transcript) return;
    const overlap = this.findFinalOverlap(index, transcript);
    if (overlap?.kind === 'contained') {
      this.finalizedTexts.set(index, transcript);
      return;
    }

    let output = transcript;
    let replaces: string | undefined;
    const previousTranscript = overlap?.previousTranscript;
    const isShortCorrection =
      previousTranscript !== undefined &&
      (isShortFinalTranscript(
        previousTranscript,
        !/^\s/u.test(overlap?.delta ?? '') && overlap?.previousIndex !== index ? 3 : 4
      ) ||
        (!/^\s/u.test(overlap?.delta ?? '') &&
          hasShortFinalToken(
            previousTranscript,
            overlap?.previousIndex !== index ? 3 : 4
          )));
    if (overlap?.kind === 'extension' && isShortCorrection) {
      output = transcript;
      replaces = previousTranscript;
    } else if (overlap?.kind === 'extension') {
      output = overlap.delta;
      if (
        overlap.previousIndex !== undefined &&
        overlap.previousIndex < index &&
        !/^\s/u.test(output)
      ) {
        output = addTranscriptBoundary(overlap.previousTranscript ?? '', output);
      }
    } else {
      const previous = this.finalHistory[this.finalHistory.length - 1];
      if (previous && index > previous.index) output = addTranscriptBoundary(previous.transcript, output);
    }

    this.finalizedTexts.set(index, transcript);
    this.finalHistory.push({ index, transcript });
    if (this.finalHistory.length > 16) this.finalHistory.shift();
    if (output.trim().length === 0) return;
    this.callbacks.onResult({
      transcript: output,
      isFinal: true,
      confidence,
      ...(replaces === undefined ? {} : { replaces }),
    });
  }

  /**
   * Chrome keeps several live (non-final) results per continuous session and
   * revises/splits/re-merges them across events (seen in real fa-IR logs as
   * " دل‌های" + " گوگل" fragments 1 ms apart). Emitting one callback per
   * changed result would deliver fragments; interim consumers need the FULL
   * pending utterance, so all live results are combined per event.
   */
  private handleResult(event: SpeechRecognitionEventLike): void {
    const results = event.results;

    // Chrome can shrink the results list when re-segmenting — drop parts
    // that no longer exist.
    for (const index of this.interimParts.keys()) {
      if (index >= results.length) this.interimParts.delete(index);
    }
    this.absorbEarlierPrefixFragments(results);

    let dirty = false;
    for (let i = event.resultIndex; i < results.length; i++) {
      const result = results[i];
      if (!result) continue;
      const alternative = result[0];
      if (!alternative) continue;
      const transcript = alternative.transcript;

      // A fragment whose text an earlier result already covers is obsolete —
      // whether it is still LIVE or has now FINALIZED. Chrome's re-segmentation
      // leaves such fragments behind after a merge; without this guard the
      // fragment's own finalization committed its words a second time
      // ("beautiful day" → "beautiful day day"). A fragment that has since
      // grown past its cover is fresh content and processed normally.
      const cover = this.coveredBy.get(i);
      if (cover !== undefined) {
        if (transcriptOverlap(cover, transcript)?.kind === 'contained') {
          this.interimParts.delete(i);
          continue;
        }
        this.coveredBy.delete(i);
      }

      if (result.isFinal) {
        this.interimParts.delete(i);
        this.absorbLaterFragments(results, i, transcript);
        dirty = true;
        this.dispatchFinal(i, transcript, alternative.confidence ?? 0);
        continue;
      }

      this.absorbLaterFragments(results, i, transcript);
      if (this.interimParts.get(i) !== transcript) {
        this.interimParts.set(i, transcript);
        dirty = true;
      }
    }

    if (!dirty) return;
    const combined = this.combinedInterim();
    if (combined !== '') {
      this.callbacks.onResult({ transcript: combined, isFinal: false, confidence: 0 });
    }
  }

  /**
   * The full pending utterance: all live results concatenated in order.
   * Re-segmentation guard: Chrome can keep an OLD fragment at index N while
   * emitting a NEW fragment at index M whose text CONTAINS the old fragment's
   * words (e.g. index 0 = " hello" lingering while index 1 = " hello world").
   * Naive concatenation would emit " hello  hello world" (duplicated words).
   * Whenever a later fragment strictly contains the earlier fragment's text
   * as a leading substring (after trimming), the earlier entry is OBSOLETE —
   * drop it so each spoken word appears exactly once.
   */
  private combinedInterim(): string {
    const indices = [...this.interimParts.keys()].sort((a, b) => a - b);
    const parts = indices.map((index) => this.interimParts.get(index) ?? '');
    // Suppress stale prefix fragments: if a later fragment starts with the
    // concatenated earlier fragments, the earlier ones are obsolete.
    let prefix = '';
    const visible: string[] = [];
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]!;
      if (prefix.length > 0 && part.trimStart().startsWith(prefix.trim())) {
        // This fragment already includes everything before it — drop prefix.
        visible.length = 0;
        prefix = part;
        visible.push(part);
        continue;
      }
      prefix += part;
      visible.push(part);
    }
    return joinTranscriptParts(visible);
  }
}
