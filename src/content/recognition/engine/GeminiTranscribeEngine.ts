import { DEFAULT_GEMINI_MODEL, GEMINI_TRANSCRIPTION_TIMEOUT_MS } from '../../../shared/constants';
import { blobToBase64 } from '../../../shared/audio';
import { copyToClipboard } from '../../../shared/clipboard';
import { DEFAULT_TRANSCRIPTION_SETTINGS } from '../../../shared/transcription';
import type {
  GeminiRuntimeMessage,
  GeminiTranscribeResponse,
  RecordingStoreAck,
  RecordingStoreMessage,
} from '../../../shared/messaging';
import { RecordingPanel } from '../../RecordingPanel';
import type { EngineCallbacks, EngineConfig, SpeechEngine } from './SpeechEngine';

/**
 * Base64 characters per message when saving a clip locally. Matches the
 * worker's own chunk size; kept here as a literal so the content script does
 * not have to import the store module, which is worker-only and touches
 * IndexedDB at import time.
 */
const RECORDING_CHUNK_CHARS = 512 * 1024;

/** A recording the user already has, submitted instead of a new capture. */
export interface AudioFileUpload {
  blob: Blob;
  name: string;
}

export interface GeminiTranscribeHooks {
  onStopRequested: () => void;
  onCancelRequested: () => void;
  /**
   * When set, the audio is already in hand: the engine submits it straight
   * away and never shows the recorder. The transcript still arrives through
   * onResult, so it is committed exactly like a recorded clip's.
   */
  upload?: AudioFileUpload;
}

function requestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * MediaRecorder appends codecs parameters (`audio/webm;codecs=opus`); the
 * Gemini API wants the bare audio/* type, so parameters are stripped before
 * the clip is sent. Empty string when the type is not audio.
 */
function bareMimeType(type: string): string {
  const essence = type.split(';')[0]?.trim().toLowerCase() ?? '';
  return essence.startsWith('audio/') ? essence : '';
}

function errorMessage(response: GeminiTranscribeResponse | undefined): string {
  return response?.message ?? 'Gemini could not transcribe this recording.';
}

/** "10 minutes" / "1 minute" — the wait the user is told about must be real. */
function timeoutMinutes(): number {
  return Math.round(GEMINI_TRANSCRIPTION_TIMEOUT_MS / 60_000);
}

function withTimeout<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), milliseconds);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); }
    );
  });
}

export class GeminiTranscribeEngine implements SpeechEngine {
  readonly config: EngineConfig;
  private readonly callbacks: EngineCallbacks;
  private readonly hooks: GeminiTranscribeHooks;
  private panel: RecordingPanel | null = null;
  private ended = false;
  /** A transcription request is in flight. */
  private processing = false;
  private submitGeneration = 0;

  constructor(config: EngineConfig, callbacks: EngineCallbacks, hooks: GeminiTranscribeHooks) {
    this.config = config;
    this.callbacks = callbacks;
    this.hooks = hooks;
  }

  start(): void {
    if (this.ended || this.panel) return;
    const upload = this.hooks.upload;
    if (upload) {
      // An uploaded file needs no recorder: report the session as started and
      // submit the audio right away. Status updates go nowhere (there is no
      // panel to show them on) — RecognitionManager's own state broadcasts
      // are what the popup renders, exactly as for a recorded clip.
      this.callbacks.onStart();
      void this.submit(upload.blob);
      return;
    }
    this.panel = new RecordingPanel({
      onStart: () => this.callbacks.onStart(),
      onSubmit: (blob) => void this.submit(blob),
      onCancel: () => this.cancelFromCard(),
      onError: (error) => this.fail(error instanceof Error ? error.message : 'Audio recording failed.'),
    });
    this.panel.open();
  }

  /**
   * True only while `submit()` is notifying the manager that the clip is
   * finished. That notification calls straight back into `stop()`, and the stop
   * it is reporting IS the one that ended the recording — not a second request
   * from the user. Treating it as one cancelled the session the instant the
   * recording finished: the card was destroyed and the transcript discarded.
   */
  private reportingStop = false;

  /**
   * An external stop — the toolbar toggle, the badge, or Alt+Shift+V.
   *
   * While recording it finishes the clip, exactly as pressing the orb does.
   * At any other point there is nothing to keep, so it ends the session: a stop
   * that did nothing would leave the toggle looking broken with no way back.
   */
  stop(): void {
    if (!this.panel || this.reportingStop) return;
    if (this.panel.isRecording()) {
      this.panel.stopRecording();
      return;
    }
    this.hooks.onCancelRequested();
  }

  abort(): void {
    this.ended = true;
    this.submitGeneration += 1;
    this.panel?.destroy();
    this.panel = null;
  }

  /**
   * The card's Cancel, or Escape.
   *
   * The engine is torn down here rather than being left to the round trip
   * through the manager, so a transcript already on its way can never be typed
   * after the user closed the card. The manager is still told, to settle the
   * session and clear the badge.
   */
  private cancelFromCard(): void {
    this.abort();
    this.hooks.onCancelRequested();
  }

  private async submit(blob: Blob): Promise<void> {
    if (this.processing) return;
    const generation = ++this.submitGeneration;
    this.processing = true;
    // Tell the manager the session is winding down as the clip is handed over.
    // This calls back into stop(), which must be inert for the duration.
    this.reportingStop = true;
    try {
      this.hooks.onStopRequested();
    } finally {
      this.reportingStop = false;
    }
    this.panel?.setStatus('Preparing audio…');
    let response: GeminiTranscribeResponse | undefined;
    // Written before the request goes out, so a failed or timed-out
    // transcription still leaves the user with the audio they just spoke.
    const storedId = await this.persistRecording(blob);
    try {
      const data = await blobToBase64(blob);
      this.panel?.setStatus('Sending recording to Gemini…');
      const message: GeminiRuntimeMessage = {
        type: 'TRANSCRIBE_AUDIO',
        data,
        mimeType: bareMimeType(blob.type) || 'audio/webm',
        transcription: this.config.transcription ?? DEFAULT_TRANSCRIPTION_SETTINGS,
        model: this.config.geminiModel || DEFAULT_GEMINI_MODEL,
        requestId: requestId(),
      };
      // A long clip on a slow connection legitimately takes minutes, so say
      // so rather than leaving the user wondering whether it has hung.
      this.panel?.setStatus('Waiting for Gemini — a long clip on a slow connection can take several minutes…');
      response = (await withTimeout(
        chrome.runtime.sendMessage(message),
        GEMINI_TRANSCRIPTION_TIMEOUT_MS
      )) as GeminiTranscribeResponse;
    } catch (error) {
      const minutes = timeoutMinutes();
      response = {
        ok: false,
        error: 'network',
        message: error instanceof Error && error.message === 'timeout'
          ? `Gemini did not respond within ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}.`
          : 'The transcription request could not be completed.',
      };
    }
    if (this.ended || generation !== this.submitGeneration) {
      // Cancelled while in flight. The clip stays on disk: cancelling abandons
      // the transcription, it does not say the audio was unwanted, and quietly
      // deleting someone's recording is the exact loss this feature exists to
      // prevent. It can be discarded from Settings.
      return;
    }
    if (!response?.ok || !response.text) {
      this.fail(errorMessage(response));
      return;
    }
    // The transcript goes straight into the field. An intermediate review step
    // — the transcript in a box, then a click to accept it — put a second
    // action between the user and their own text for no gain, and the card was
    // the only thing they had to click to get on with dictating.
    this.callbacks.onResult({ transcript: response.text, isFinal: true, confidence: 1 });
    // The text is already safely in the field before this runs, so a clipboard
    // that refuses the write costs the user nothing.
    void this.copyBackup(response.text);
    // Only now is the local copy redundant. Discarding before the transcript
    // exists is what would make a transient error cost the user their audio.
    if (storedId) void this.forgetRecording(storedId);
    this.finish();
  }

  /**
   * Keep a just-captured clip locally until it is transcribed, so a failure
   * costs the user a retry rather than another recording.
   *
   * Best-effort by design: if the store is unavailable the transcription still
   * goes ahead. Failing to save must never be the reason someone cannot dictate
   * at all, so every error here is swallowed and the clip is simply not
   * recoverable.
   *
   * Uploaded files are deliberately not copied — the user still has the file,
   * and holding a second copy of something they chose from disk would be a
   * privacy cost with no benefit.
   */
  private async persistRecording(blob: Blob): Promise<string | null> {
    if (this.hooks.upload) return null;
    if (typeof crypto?.randomUUID !== 'function') return null;
    const id = crypto.randomUUID();
    const createdAt = Date.now();
    const mimeType = bareMimeType(blob.type) || 'audio/webm';
    const model = this.config.geminiModel || DEFAULT_GEMINI_MODEL;

    const send = (message: RecordingStoreMessage): Promise<RecordingStoreAck> =>
      chrome.runtime.sendMessage(message) as Promise<RecordingStoreAck>;

    try {
      const begun = await send({ type: 'RECORDING_SAVE_BEGIN', id });
      if (!begun?.ok) return null;

      const data = await blobToBase64(blob);
      for (let offset = 0; offset < data.length; offset += RECORDING_CHUNK_CHARS) {
        const slice = data.slice(offset, offset + RECORDING_CHUNK_CHARS);
        const first = offset === 0;
        const ack = await send({
          type: 'RECORDING_SAVE_CHUNK',
          id,
          data: slice,
          ...(first ? { mimeType, bytes: blob.size, model, createdAt } : {}),
        });
        if (!ack?.ok) {
          await send({ type: 'RECORDING_SAVE_ABORT', id });
          return null;
        }
      }
      const committed = await send({ type: 'RECORDING_SAVE_COMMIT', id });
      return committed?.ok ? id : null;
    } catch {
      void send({ type: 'RECORDING_SAVE_ABORT', id }).catch(() => undefined);
      return null;
    }
  }

  /** Erase the local copy of a clip that has been transcribed. */
  private async forgetRecording(id: string): Promise<void> {
    try {
      await chrome.runtime.sendMessage({ type: 'RECORDING_DELETE', id } satisfies RecordingStoreMessage);
    } catch {
      // Nothing to do: the copy is only ever read by an explicit retry, and
      // Settings can clear the store. Leaking one stale clip is not worth
      // interrupting a finished dictation.
    }
  }

  /**
   * Keep a copy of the finished transcript on the clipboard.
   *
   * Dictated text that has just landed in somebody else's document is easy to
   * lose to a mis-click, a re-rendering editor, or an undo, and there is no way
   * to get it back once it is gone. The copy is strictly a backup: it happens
   * after the insertion, it never blocks it, and the user is told when it
   * worked and when it did not, because silently replacing whatever they had
   * copied would be its own surprise.
   */
  private async copyBackup(text: string): Promise<void> {
    const copied = await copyToClipboard(text);
    this.callbacks.onNote?.(
      copied ? 'Transcript copied to clipboard' : 'Could not copy to the clipboard'
    );
  }

  /**
   * A failure the user can act on.
   *
   * With a card on screen it returns to idle with the message and the
   * microphone is free again, so recording can simply be retaken in place. The
   * session is deliberately left open: closing the card on every hiccup would
   * make one dropped request cost the user the whole recording, and keeping it
   * open is what lets a retry be accepted — the manager discards results that
   * arrive while it is in an error state.
   *
   * With no card (an upload) there is nowhere to put the message, so it is
   * reported through the manager, which surfaces it on the badge and the popup
   * and then settles the session.
   */
  private fail(message: string): void {
    this.processing = false;
    if (this.panel) {
      this.panel.setError(message);
      return;
    }
    this.callbacks.onError({ code: 'gemini-error', message });
    this.finish();
  }

  /**
   * End the session and take the card off the page completely.
   *
   * `destroy()` rather than hide: the card owns a host element and a document
   * key listener, and leaving either behind after a session is what makes the
   * next one flaky — a stale card in the page and a live key handler that
   * belongs to a session that has ended.
   */
  private finish(): void {
    if (this.ended) return;
    this.ended = true;
    this.panel?.destroy();
    this.panel = null;
    this.callbacks.onEnd();
  }
}
