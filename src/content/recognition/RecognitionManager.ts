import {
  HARD_ERROR_CODES,
  MAX_CONSECUTIVE_EMPTY_RESTARTS,
  MAX_RESTARTS_PER_WINDOW,
  RESTART_BACKOFF_MS,
  RESTART_WINDOW_MS,
} from '../../shared/constants';
import type {
  AvailabilityState,
  CustomVoiceCommand,
  Language,
  RecognitionErrorInfo,
  RecognitionState,
  RecognitionStatus,
  TargetSummary,
} from '../../shared/types';
import type { EngineConfig, EngineFactory, EngineResult, SpeechEngine } from './engine/SpeechEngine';
import { NumberTransformer } from './NumberTransformer';
import { applyVoiceCommands } from './voiceCommands';

export interface CommitResult {
  ok: boolean;
  error?: string;
  target: TargetSummary | null;
}

export interface TargetController {
  summary(): TargetSummary | null;
  validate(): { ok: boolean; reason?: string };
  commit(text: string): CommitResult;
  replace?(text: string, previousText: string): CommitResult;
  /** Write/replace the live interim transcript in the target (spec §14). */
  preview(text: string): { ok: boolean; reason?: string };
  /** Drop preview tracking, keeping any previewed text as real text. */
  resetPreview(): void;
}

export interface RecognitionManagerDeps {
  engineFactory: EngineFactory;
  targets: TargetController;
  onStatus: (status: RecognitionStatus) => void;
}

const HUMAN_ERROR_MESSAGES: Record<string, string> = {
  'no-speech': 'No speech detected — keep speaking.',
  'audio-capture': 'No microphone was found. Check that a microphone is connected and enabled.',
  'not-allowed': 'Microphone permission was denied for this site. Allow the microphone and try again.',
  'service-not-allowed': 'The browser blocked the speech recognition service in this context.',
  network: 'Network error while contacting the browser speech service.',
  aborted: 'Recognition was aborted.',
  'language-not-supported': 'The selected language is not supported by the browser speech service.',
  'start-failed': 'Recognition could not be started.',
  'insert-failed': 'Could not insert text at the captured cursor position.',
  'target-lost': 'The captured text field is no longer available. Dictation stopped.',
  'give-up-restarts': 'Recognition kept ending immediately, so auto-restart was stopped.',
  'give-up-window': 'Recognition restarted too many times in a short window, so it was stopped.',
  'no-target': 'No supported text field is focused. Focus a text field first.',
  'gemini-error': 'Gemini transcription failed.',
};

/**
 * State to return to after a final result was committed. A final result can
 * arrive while `stopping` (Chrome flushes the last utterance on stop()) —
 * committing it must NOT resurrect a session the user asked to stop (§5).
 */
function resumeStateAfterCommit(state: RecognitionState): RecognitionState {
  switch (state) {
    case 'starting':
    case 'stopping':
    case 'restarting':
    case 'error':
    case 'idle':
      return state;
    default:
      return 'listening';
  }
}

/**
 * Owns the recognition session lifecycle and the distinction between
 * "browser ended the session" (auto-restart when appropriate) and
 * "user explicitly stopped" (never restart). Also implements restart
 * backoff + give-up limits so we never loop forever (spec §5, §15).
 */
export class RecognitionManager {
  private state: RecognitionState = 'idle';
  private engine: SpeechEngine | null = null;
  private currentConfig: EngineConfig | null = null;
  private availability: AvailabilityState = 'unknown';
  private modeNote = '';

  /** False while the user wants dictation to continue. */
  private userRequestedStop = true;
  private autoRestart = true;

  private sessionCount = 0;
  private activeSessionId: number | null = null;
  private restartCount = 0;
  private consecutiveEmptyRestarts = 0;
  private restartTimestamps: number[] = [];
  private restartTimer: ReturnType<typeof setTimeout> | null = null;

  private gotResultThisSession = false;
  private interimTranscript = '';
  private lastFinalTranscript = '';
  private uncommittedTranscript: string | null = null;
  /** Transient message for the user; dropped as soon as it has been shown. */
  private note: string | null = null;
  private lastError: RecognitionErrorInfo | null = null;
  private lastEvent = 'none';
  private voiceCommandsEnabled = true;
  private customCommands: CustomVoiceCommand[] = [];
  private readonly numberTransformer = new NumberTransformer();
  private numbersAsDigits = false;
  private selectedLanguage: Language | null = null;

  constructor(private readonly deps: RecognitionManagerDeps) {}

  // ------------------------------------------------------------------ API

  setAutoRestart(value: boolean): void {
    this.autoRestart = value;
    this.publish();
  }

  /** Toggles spoken punctuation/formatting commands (spec §40). */
  setVoiceCommands(value: boolean): void {
    this.voiceCommandsEnabled = value;
    this.publish();
  }

  /** Installs the user-defined command list (settings page, spec §40). */
  setCustomCommands(commands: CustomVoiceCommand[]): void {
    this.customCommands = commands;
  }

  /** "Always type numbers as digits" (spec §41) — final transcripts only. */
  setNumbersAsDigits(value: boolean): void {
    this.numbersAsDigits = value;
    this.publish();
  }

  /** Syncs the preferred language for badge display (spec §42). */
  setSelectedLanguage(language: Language): void {
    this.selectedLanguage = language;
    this.publish();
  }

  getStatus(): RecognitionStatus {
    return {
      state: this.state,
      language: this.state === 'idle'
        ? this.selectedLanguage ?? this.currentConfig?.language ?? null
        : this.currentConfig?.language ?? this.selectedLanguage,
      mode: this.currentConfig?.mode ?? null,
      modeNote: this.modeNote,
      availability: this.availability,
      sessionCount: this.sessionCount,
      restartCount: this.restartCount,
      lastEvent: this.lastEvent,
      lastError: this.lastError,
      target: this.deps.targets.summary(),
      interimTranscript: this.interimTranscript,
      lastFinalTranscript: this.lastFinalTranscript,
      uncommittedTranscript: this.uncommittedTranscript,
    note: this.note,
      autoRestart: this.autoRestart,
      provider: this.currentConfig?.provider ?? 'voiceTyping',
    };
  }

  /**
   * Starts dictation. The mode/availability must already be resolved by the
   * caller (content layer) via LanguageSupport — this class is mode-agnostic.
   */
  start(config: EngineConfig, availability: AvailabilityState, modeNote: string): void {
    this.clearRestartTimer();
    const previousEngine = this.engine;
    this.engine = null;
    this.activeSessionId = null;
    try {
      previousEngine?.abort();
    } catch {
      /* previous engine already dead */
    }
    this.currentConfig = config;
    this.availability = availability;
    this.modeNote = modeNote;
    this.userRequestedStop = false;
    this.consecutiveEmptyRestarts = 0;
    this.interimTranscript = '';
    this.lastFinalTranscript = '';
    this.uncommittedTranscript = null;
    this.note = null;
    this.lastError = null;
    this.lastEvent = 'start';
    this.publish();
    this.beginSession();
  }

  /** User clicked Stop — after this, no automatic restart ever happens. */
  stop(): void {
    this.userRequestedStop = true;
    this.clearRestartTimer();
    this.lastEvent = 'stop';
    if (this.state === 'idle') {
      this.publish();
      return;
    }
    if (!this.engine) {
      this.interimTranscript = '';
      this.deps.targets.resetPreview();
      this.setState('idle');
      this.publish();
      return;
    }
    this.setState('stopping');
    try {
      this.engine?.stop();
    } catch {
      /* already dead */
    }
    this.publish();
  }

  cancel(): void {
    this.userRequestedStop = true;
    this.clearRestartTimer();
    try {
      this.engine?.abort();
    } catch {
    }
    this.engine = null;
    this.activeSessionId = null;
    this.interimTranscript = '';
    this.lastEvent = 'cancel';
    this.deps.targets.resetPreview();
    this.setState('idle');
    this.publish();
  }

  /** Start was pressed but no supported editable element is focused. */
  reportNoTarget(): void {
    this.lastError = { code: 'no-target', message: HUMAN_ERROR_MESSAGES['no-target'] };
    this.lastEvent = 'no-target';
    this.publish();
  }

  // ------------------------------------------------------------- internals

  private beginSession(): void {
    const config = this.currentConfig;
    if (!config) return;
    this.setState('starting');
    this.gotResultThisSession = false;
    this.sessionCount += 1;
    try {
      // Tag every engine callback with its session id: `manager.start()` can
      // abort a still-alive previous engine, and its late onend/onresult MUST
      // NOT act on the newer session (a stale onend used to schedule an
      // auto-restart on top of the live session → a second concurrent session
      // repeating every spoken word).
      const sessionId = this.sessionCount;
      this.activeSessionId = sessionId;
      const isStale = (): boolean => sessionId !== this.activeSessionId;
      this.engine = this.deps.engineFactory(config, {
        onStart: () => {
          if (isStale() || this.userRequestedStop) return;
          this.lastEvent = 'onstart';
          this.setState('listening');
          this.publish();
        },
        onResult: (result) => {
          if (isStale()) return;
          this.handleResult(result);
        },
        onError: (error) => {
          if (isStale()) return;
          this.handleEngineError(error.code, error.message);
        },
        onNote: (note) => {
          if (isStale()) return;
          this.note = note;
          this.publish();
        },
        onEnd: () => {
          if (isStale()) return;
          this.handleEngineEnd();
        },
      });
      this.engine.start();
    } catch {
      const failedEngine = this.engine;
      this.activeSessionId = null;
      this.engine = null;
      this.clearRestartTimer();
      try {
        failedEngine?.abort();
      } catch {}
      this.interimTranscript = '';
      this.deps.targets.resetPreview();
      this.handleEngineError('start-failed');
    }
  }

  private handleResult(result: EngineResult): void {
    this.lastEvent = 'onresult';

    // A result arriving after the session already ended (`idle` — Chrome can
    // deliver one past onend when a stop interrupts an utterance) must be
    // dropped: resetPreview already kept the pending words as ordinary text,
    // so committing or previewing now duplicates the last utterance (observed
    // when stopping via the floating badge). Results flushed DURING
    // `stopping` are still processed — they replace the live preview (see
    // the stop-flush test).
    if (this.state === 'idle' || this.state === 'error') {
      this.interimTranscript = '';
      this.publish();
      return;
    }

    if (!result.isFinal) {
      if (result.transcript.trim() === '') {
        // Blank interims carry no pending words — nothing to show or preview.
        return;
      }
      // Live dictation: write the pending text (with voice commands already
      // applied so the preview matches the final commit) into the field
      // immediately; the next interim or the final result replaces it (§14).
      const interim = this.processTranscript(result.transcript);
      if (interim.trim() === '') return;
      this.interimTranscript = interim;
      // Preview is best-effort — a failure falls back to display-only until
      // the final result commits normally.
      this.deps.targets.preview(interim);
      this.publish();
      return;
    }

    // Chrome emits empty final results at utterance boundaries (observed with
    // fa-IR sessions). They carry no words — skip them instead of running a
    // pointless commit and polluting lastFinalTranscript / backoff counters.
    if (result.transcript.trim() === '') {
      this.interimTranscript = '';
      this.publish();
      return;
    }

    const text = this.finalizeTranscript(result.transcript);
    const previousText = result.replaces === undefined ? undefined : this.finalizeTranscript(result.replaces);
    this.interimTranscript = '';
    this.gotResultThisSession = true;
    const stateBeforeCommit = this.state;
    this.setState('processing');

    const commit = previousText !== undefined && this.deps.targets.replace
      ? this.deps.targets.replace(text, previousText)
      : this.deps.targets.commit(text);
    if (commit.ok) {
      this.lastFinalTranscript = text;
      this.uncommittedTranscript = null;
    } else {
      // Never silently discard a final result (spec §37).
      this.uncommittedTranscript = text;
      this.lastError = {
        code: 'insert-failed',
        message: `${HUMAN_ERROR_MESSAGES['insert-failed']}${commit.error ? ` (${commit.error})` : ''}`,
        raw: commit.error,
      };
    }

    if (this.state === 'processing') {
      this.setState(resumeStateAfterCommit(stateBeforeCommit));
    }
    this.publish();
  }

  /**
   * Transcript pipeline for FINAL results only (spec §40, §41): voice
   * commands first, then optional spoken-number → digits conversion. Interim
   * results intentionally skip these so the live preview never flickers
   * mid-transformation.
   */
  private finalizeTranscript(text: string): string {
    const language = this.currentConfig?.language;
    if (!language) return text;
    const withCommands = this.processTranscript(text);
    return this.numbersAsDigits
      ? this.numberTransformer.transform(withCommands, language)
      : withCommands;
  }

  /** Voice-command pipeline, applied to interim AND final results (§40). */
  private processTranscript(text: string): string {
    const language = this.currentConfig?.language;
    if (!this.voiceCommandsEnabled || !language) return text;
    return applyVoiceCommands(text, language, this.customCommands);
  }

  private handleEngineError(code: string, rawMessage?: string): void {
    this.lastEvent = `onerror:${code}`;

    if (code === 'start-failed' || HARD_ERROR_CODES.has(code)) {
      // Real failure — stop and surface a human-readable message (spec §16).
      this.userRequestedStop = true;
      this.lastError = {
        code,
        message: code === 'gemini-error' && rawMessage ? rawMessage : (HUMAN_ERROR_MESSAGES[code] ?? 'Recognition failed.'),
        raw: rawMessage,
      };
      this.setState('error');
      this.publish();
      return;
    }

    // Soft errors: 'network' is worth showing; 'no-speech' and non-user
    // 'aborted' are normal parts of continuous dictation.
    if (code === 'network') {
      this.lastError = { code, message: HUMAN_ERROR_MESSAGES.network, raw: rawMessage };
      this.publish();
    }
  }

  private handleEngineEnd(): void {
    this.activeSessionId = null;
    this.engine = null;
    this.lastEvent = 'onend';

    if (this.state === 'stopping' || this.state === 'error') {
      // Graceful stop or hard failure finished. lastError stays visible.
      this.deps.targets.resetPreview();
      this.setState('idle');
      this.publish();
      return;
    }
    if (this.userRequestedStop || !this.autoRestart) {
      this.deps.targets.resetPreview();
      this.setState('idle');
      this.publish();
      return;
    }

    // Session ended while the user is still dictating — the live preview
    // stays active across the restart so mid-utterance text is not lost, and
    // the target is verified before starting the microphone again (spec §36).
    const validation = this.deps.targets.validate();
    if (!validation.ok) {
      this.lastError = { code: 'target-lost', message: HUMAN_ERROR_MESSAGES['target-lost'], raw: validation.reason };
      this.deps.targets.resetPreview();
      this.setState('error');
      this.publish();
      return;
    }

    this.scheduleRestart();
  }

  private scheduleRestart(): void {
    const now = Date.now();
    this.restartTimestamps = this.restartTimestamps.filter((t) => now - t < RESTART_WINDOW_MS);
    this.restartTimestamps.push(now);

    this.consecutiveEmptyRestarts = this.gotResultThisSession ? 0 : this.consecutiveEmptyRestarts + 1;

    if (this.consecutiveEmptyRestarts >= MAX_CONSECUTIVE_EMPTY_RESTARTS) {
      this.giveUp('give-up-restarts');
      return;
    }
    if (this.restartTimestamps.length >= MAX_RESTARTS_PER_WINDOW) {
      this.giveUp('give-up-window');
      return;
    }

    // Sessions that produced results restart quickly; empty ones back off.
    const backoffIndex = this.gotResultThisSession ? 0 : this.consecutiveEmptyRestarts - 1;
    const delay = RESTART_BACKOFF_MS[Math.min(Math.max(backoffIndex, 0), RESTART_BACKOFF_MS.length - 1)];
    this.restartCount += 1;
    this.setState('restarting');
    this.publish();

    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.userRequestedStop) {
        this.setState('idle');
        this.publish();
        return;
      }
      this.beginSession();
    }, delay);
  }

  private giveUp(code: 'give-up-restarts' | 'give-up-window'): void {
    this.userRequestedStop = true;
    this.lastError = { code, message: HUMAN_ERROR_MESSAGES[code] };
    // No restart will follow — keep the previewed text as ordinary text.
    this.deps.targets.resetPreview();
    this.setState('error');
    this.publish();
  }

  private setState(next: RecognitionState): void {
    this.state = next;
  }

  private clearRestartTimer(): void {
    if (this.restartTimer !== null) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
  }

  private publish(): void {
    this.deps.onStatus(this.getStatus());
  }
}
