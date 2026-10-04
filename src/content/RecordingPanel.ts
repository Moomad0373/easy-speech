import { MAX_RECORDING_BYTES, MAX_RECORDING_DURATION_MS } from '../shared/constants';

export type RecordingPanelState = 'idle' | 'recording' | 'processing';

export interface RecordingPanelOptions {
  onStart(): void;
  /** The clip is finished; hand it over to be transcribed. */
  onSubmit(blob: Blob): void;
  /** The user closed the card without a transcript. */
  onCancel(): void;
  onError(error: unknown): void;
}

/**
 * Time-domain window for the orb's level. The orb scales two rings from a
 * single RMS figure, so a short window is the right tool: a spectrum would be
 * describing detail the design does not show.
 */
const LEVEL_FFT_SIZE = 256;

/**
 * Panel markup and styles, ported from the approved design. The palette, the
 * geometry, the state rules and the motion are reproduced exactly; only the
 * host wrapper is different, because a content script renders into a shadow
 * root on an arbitrary page rather than owning a document.
 *
 * The design's fourth state — a transcript in an editable box awaiting an
 * explicit Insert — is deliberately absent. The transcript now goes straight
 * into the field, so there is nothing to review and nothing to decide; keeping
 * the markup would only be a second click between the user and their text.
 */
const PANEL_HTML = `
<style>
  :host { all: initial; }
  *, *::before, *::after { box-sizing: border-box; margin: 0; }

  .card {
    --midnight:#0a0f1e; --slate:#121a30; --raise:#1a2440; --line:#263050;
    --mist:#e9edf8; --muted:#8792b0; --dim:#485474;
    --signal:#ff4d5a; --signal-deep:#e0303f; --wait:#f5b544; --ok:#43d69a;

    position: relative;
    overflow: hidden;
    width: min(360px, calc(100vw - 32px));
    padding: 16px 20px 20px;
    border-radius: 24px;
    border: 1px solid var(--line);
    background: linear-gradient(180deg, var(--slate), var(--midnight));
    box-shadow: 0 28px 70px rgba(0,0,0,.6), inset 0 1px 0 rgba(255,255,255,.04);
    font: 13px/1.5 "Segoe UI", system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif;
    color: var(--mist);
  }

  /* glow only exists while recording: it signals "live" */
  .card::before {
    content:""; position:absolute; left:50%; top:110px; width:280px; height:280px; margin-left:-140px;
    border-radius:50%;
    background: radial-gradient(closest-side, rgba(255,77,90,.2), transparent);
    opacity:0; transition:opacity .4s; pointer-events:none;
  }
  .card[data-state="recording"]::before { opacity:1; }

  /* header */
  .head { position:relative; display:flex; align-items:center; gap:8px; }
  .dot { width:8px; height:8px; border-radius:50%; background:var(--dim); transition:background .2s; }
  .title { font-size:13px; font-weight:600; color:var(--muted); }
  .close {
    margin-left:auto; width:32px; height:32px; border:0; border-radius:50%;
    background:transparent; color:var(--muted); cursor:pointer; display:grid; place-items:center;
    transition:background .15s, color .15s;
  }
  .close:hover { background:var(--raise); color:var(--mist); }
  .close svg { width:14px; height:14px; }

  /* readout */
  .readout { position:relative; margin-top:20px; text-align:center; }
  .time {
    font-size:46px; font-weight:300; line-height:1; letter-spacing:1px;
    font-variant-numeric:tabular-nums; color:var(--muted); transition:color .2s;
  }
  .status { margin-top:8px; min-height:18px; font-size:13px; color:var(--muted); }
  .status.error { color:#ff8a91; }

  /* orb */
  .orb-wrap { position:relative; width:130px; height:130px; margin:14px auto 4px; display:grid; place-items:center; }
  .ring { position:absolute; inset:27px; border-radius:50%; opacity:0; transition:opacity .25s; }
  .ring.a { background:rgba(255,77,90,.20); transform:scale(calc(1 + var(--lvl,0) * .55)); }
  .ring.b { background:rgba(255,77,90,.10); transform:scale(calc(1.15 + var(--lvl,0) * 1.0)); }
  .orb {
    position:relative; z-index:1; width:76px; height:76px; border:0; border-radius:50%; cursor:pointer; color:#fff;
    display:grid; place-items:center;
    background:linear-gradient(160deg,#ff6b76,var(--signal-deep));
    box-shadow:0 10px 28px rgba(255,77,90,.35), inset 0 1px 0 rgba(255,255,255,.3);
    transition:transform .15s, box-shadow .2s, opacity .2s;
  }
  .orb:hover { transform:scale(1.04); }
  .orb:active { transform:scale(.97); }
  .orb:focus-visible, .btn:focus-visible, .close:focus-visible { outline:2px solid #8fb2ff; outline-offset:3px; }
  .orb svg { width:28px; height:28px; grid-area:1/1; }
  .orb .i-stop { display:none; width:22px; height:22px; }
  .spin {
    position:absolute; inset:16px; border-radius:50%;
    border:3px solid transparent; border-top-color:var(--wait);
    opacity:0; animation:rot 1s linear infinite paused;
  }

  /* keyboard hint */
  .hint { display:none; margin-top:6px; text-align:center; font-size:12px; color:var(--dim); }
  kbd { font:inherit; font-size:11px; padding:1px 6px; border:1px solid var(--line); border-radius:5px; color:var(--muted); }

  /* states */
  .card[data-state="idle"] .hint { display:block; }

  .card[data-state="recording"] .dot { background:var(--signal); animation:pulse 1.3s ease-out infinite; }
  .card[data-state="recording"] .time { color:var(--mist); }
  .card[data-state="recording"] .ring { opacity:1; }
  .card[data-state="recording"] .i-mic { display:none; }
  .card[data-state="recording"] .i-stop { display:block; }

  .card[data-state="processing"] .dot { background:var(--wait); animation:blink 1s ease-in-out infinite; }
  .card[data-state="processing"] .orb { opacity:.45; pointer-events:none; box-shadow:none; }
  .card[data-state="processing"] .spin { opacity:1; animation-play-state:running; }
  .card[data-state="processing"] .hint { display:none; }

  @keyframes pulse { 0%{box-shadow:0 0 0 0 rgba(255,77,90,.55)} 100%{box-shadow:0 0 0 8px rgba(255,77,90,0)} }
  @keyframes blink { 50%{opacity:.3} }
  @keyframes rot { to { transform:rotate(360deg) } }

  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { animation:none !important; transition:none !important; }
  }
</style>
<section class="card" data-state="idle" role="dialog" aria-label="Voice transcription">
  <div class="head">
    <span class="dot" aria-hidden="true"></span>
    <h1 class="title">Voice transcription</h1>
    <button class="close" type="button" aria-label="Cancel" title="Cancel (Esc)">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>
    </button>
  </div>

  <div class="readout">
    <div class="time" id="time" role="timer" aria-live="off">00:00</div>
    <p class="status" aria-live="polite">Tap the mic to start</p>
  </div>

  <div class="orb-wrap">
    <span class="ring b"></span><span class="ring a"></span><span class="spin"></span>
    <button class="orb" type="button" aria-label="Start recording">
      <svg class="i-mic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>
      <svg class="i-stop" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="3"/></svg>
    </button>
  </div>

  <p class="hint"><kbd>Space</kbd> start or stop &nbsp; <kbd>Esc</kbd> cancel</p>
</section>
`;

function formatDuration(milliseconds: number): string {
  const totalSeconds = Math.floor(milliseconds / 1000);
  const minutes = Math.floor(totalSeconds / 60).toString().padStart(2, '0');
  const seconds = (totalSeconds % 60).toString().padStart(2, '0');
  return `${minutes}:${seconds}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const megabytes = bytes / (1024 * 1024);
  return megabytes >= 10 || megabytes % 1 === 0
    ? `${Math.round(megabytes)} MB`
    : `${Math.round(megabytes * 10) / 10} MB`;
}

function chooseMimeType(): string {
  if (typeof MediaRecorder === 'undefined') return '';
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
  if (typeof MediaRecorder.isTypeSupported !== 'function') return '';
  return candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate)) ?? '';
}

/**
 * The floating recording card.
 *
 * Flow: idle → recording → processing. Finishing a recording hands the clip
 * over and the card waits; the transcript itself is the engine's business, and
 * by the time it arrives the card is already gone because the text has been
 * typed where the user was writing.
 */
export class RecordingPanel {
  private readonly options: RecordingPanelOptions;
  private host: HTMLDivElement | null = null;
  private shadow: ShadowRoot | null = null;
  private card: HTMLElement | null = null;
  private status: HTMLElement | null = null;
  private time: HTMLElement | null = null;
  private orb: HTMLButtonElement | null = null;
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private muteGain: GainNode | null = null;
  private timeData: Uint8Array<ArrayBuffer> | null = null;
  private animationFrame: number | null = null;
  private timerHandle: ReturnType<typeof setInterval> | null = null;
  private chunks: Blob[] = [];
  private startedAt = 0;
  private recordedBytes = 0;
  private level = 0;
  private state: RecordingPanelState = 'idle';
  /** A capture limit was hit; report it and let the user try a shorter clip. */
  private captureError: string | null = null;
  private disposed = false;

  constructor(options: RecordingPanelOptions) {
    this.options = options;
    this.ensureHost();
    this.wireEvents();
    this.setState('idle', 'Tap the mic to start');
  }

  open(): void {
    if (this.disposed) return;
    this.ensureHost();
    if (this.host) this.host.style.display = 'block';
    // Attached here, not when recording starts: Space is the shortcut that
    // STARTS the recording, so a listener that only existed mid-recording could
    // never fire the first time it is needed.
    this.attachKeyboard();
    this.orb?.focus();
  }

  isRecording(): boolean {
    return this.state === 'recording';
  }

  stopRecording(): void {
    if (this.state !== 'recording' || !this.recorder) return;
    if (this.recorder.state === 'recording') this.recorder.stop();
  }

  setStatus(message: string): void {
    if (this.status) {
      this.status.textContent = message;
      this.status.classList.remove('error');
    }
  }

  /** A failure the user can retry from: the card returns to idle, error shown. */
  setError(message: string): void {
    this.setState('idle', message);
    if (this.status) this.status.classList.add('error');
  }

  /**
   * Tear the card off the page: releases the microphone, the audio graph and
   * the document key listener, and removes the host element.
   */
  destroy(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopLevelLoop();
    this.stopTracks();
    if (this.recorder && this.recorder.state !== 'inactive') {
      try { this.recorder.stop(); } catch {}
    }
    this.recorder = null;
    this.detachKeyboard();
    this.host?.remove();
    this.host = null;
    this.shadow = null;
    this.card = null;
  }

  /**
   * The panel owns its host outright: any element left over from a previous
   * session is removed rather than adopted. A card is single-use (one
   * recording, one transcription), and its listeners are bound to this
   * instance, so adopting a previous instance's host would leave the new card's
   * orb wired to a dead session — pressing it would simply do nothing.
   */
  private ensureHost(): void {
    if (this.host?.isConnected) return;
    document.getElementById('__voice-type-recording-host')?.remove();
    this.host = document.createElement('div');
    this.host.id = '__voice-type-recording-host';
    this.host.style.cssText = 'all:initial;position:fixed;inset-inline-end:24px;bottom:24px;z-index:2147483647;display:none;';
    this.shadow = this.host.attachShadow({ mode: 'open' });
    this.shadow.innerHTML = PANEL_HTML;
    this.card = this.shadow.querySelector('.card');
    this.status = this.shadow.querySelector('.status');
    this.time = this.shadow.querySelector('.time');
    this.orb = this.shadow.querySelector('.orb');
    (document.documentElement ?? document.body).appendChild(this.host);
  }

  private wireEvents(): void {
    if (!this.host) return;
    // The card lives on top of somebody else's page: never let a click or a key
    // inside it reach the site's own handlers.
    for (const type of ['pointerdown', 'pointerup', 'click', 'mousedown', 'mouseup', 'keydown']) {
      this.host.addEventListener(type, (event) => event.stopPropagation());
    }
    this.orb?.addEventListener('click', () => {
      if (this.state === 'recording') this.stopRecording();
      else void this.startRecording();
    });
    this.shadow?.querySelector('.close')?.addEventListener('click', () => this.cancel());
  }

  /**
   * Space and Esc, as the card's hint advertises — but ONLY while the card
   * itself holds focus. The user's caret sits in a field on the host page, and
   * swallowing Space there would turn the shortcut into a typing bug. Because
   * the card focuses its orb on open, the shortcut works the moment it appears,
   * and stops the moment focus leaves.
   */
  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (!this.shadow || this.disposed) return;
    if (this.shadow.activeElement === null) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      this.cancel();
      return;
    }
    if (event.code !== 'Space') return;
    if (this.state === 'processing') return;
    event.preventDefault();
    this.orb?.click();
  };

  private attachKeyboard(): void {
    document.addEventListener('keydown', this.onKeyDown, true);
  }

  private detachKeyboard(): void {
    document.removeEventListener('keydown', this.onKeyDown, true);
  }

  private cancel(): void {
    this.reset();
    this.options.onCancel();
  }

  /** Back to a clean card, releasing the microphone if it is still open. */
  private reset(): void {
    if (this.recorder?.state === 'recording') {
      this.recorder.onstop = null;
      this.recorder.stop();
    }
    this.releaseCapture();
    if (this.time) this.time.textContent = '00:00';
    this.setState('idle', 'Tap the mic to start');
  }

  private async startRecording(): Promise<void> {
    if (this.state !== 'idle' || this.disposed) return;
    if (typeof MediaRecorder === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      const error = new Error('Audio recording is not available in this browser.');
      this.setError(error.message);
      this.options.onError(error);
      return;
    }
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = chooseMimeType();
      this.recorder = mimeType ? new MediaRecorder(this.stream, { mimeType }) : new MediaRecorder(this.stream);
      this.chunks = [];
      this.recordedBytes = 0;
      this.captureError = null;
      this.recorder.addEventListener('dataavailable', (event) => {
        if (event.data.size === 0) return;
        this.chunks.push(event.data);
        this.recordedBytes += event.data.size;
        if (this.recordedBytes > MAX_RECORDING_BYTES) {
          this.captureError = 'The recording is too large. Record a shorter clip.';
          this.stopRecording();
        }
      });
      this.recorder.addEventListener('error', () => {
        const error = new Error('The browser could not record audio.');
        this.releaseCapture();
        this.setError(error.message);
        this.options.onError(error);
      });
      this.recorder.addEventListener('stop', () => this.onCaptureStopped(mimeType));
      this.recorder.start(250);
      this.startLevelLoop(this.stream);
      this.startedAt = Date.now();
      this.timerHandle = setInterval(() => this.updateTimer(), 250);
      this.setState('recording', 'Listening… tap to stop');
      this.options.onStart();
    } catch (error) {
      this.releaseCapture();
      this.setError(error instanceof Error ? error.message : 'Microphone access was denied.');
      this.options.onError(error);
    }
  }

  private onCaptureStopped(mimeType: string): void {
    if (this.disposed) return;
    const blob = new Blob(this.chunks, { type: this.recorder?.mimeType || mimeType || 'audio/webm' });
    this.chunks = [];
    this.releaseCapture();
    if (this.captureError) {
      this.setError(this.captureError);
      this.options.onError(new Error(this.captureError));
      return;
    }
    // The design has no separate "transcribe" step: finishing the recording
    // hands the clip straight over.
    this.setState('processing', 'Transcribing…');
    this.options.onSubmit(blob);
  }

  private startLevelLoop(stream: MediaStream): void {
    const AudioContextCtor = window.AudioContext ??
      (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextCtor) return;
    try {
      this.audioContext = new AudioContextCtor();
      const source = this.audioContext.createMediaStreamSource(stream);
      this.analyser = this.audioContext.createAnalyser();
      this.analyser.fftSize = LEVEL_FFT_SIZE;
      this.timeData = new Uint8Array(new ArrayBuffer(this.analyser.fftSize));
      source.connect(this.analyser);
      // The Web Audio graph is pulled from the destination, so an analyser left
      // dangling is not guaranteed to be rendered. Routing it through a muted
      // gain keeps the data flowing without an audible echo of the mic.
      this.muteGain = this.audioContext.createGain();
      this.muteGain.gain.value = 0;
      this.analyser.connect(this.muteGain);
      this.muteGain.connect(this.audioContext.destination);
      void this.audioContext.resume();
      const draw = (): void => {
        this.renderLevel();
        if (!this.disposed && typeof requestAnimationFrame === 'function') this.animationFrame = requestAnimationFrame(draw);
      };
      draw();
    } catch {
      this.stopLevelLoop();
    }
  }

  /**
   * One frame of the orb: RMS of the time-domain window, smoothed, written to
   * `--lvl` on the card. The two rings scale from it in CSS.
   */
  private renderLevel(): void {
    const data = this.timeData;
    const analyser = this.analyser;
    if (!data || !analyser || !this.card) return;
    analyser.getByteTimeDomainData(data);
    let sum = 0;
    for (let index = 0; index < data.length; index += 1) {
      const deviation = ((data[index] ?? 128) - 128) / 128;
      sum += deviation * deviation;
    }
    const rms = Math.sqrt(sum / data.length);
    this.level = this.level * 0.75 + Math.min(1, rms * 4) * 0.25;
    this.card.style.setProperty('--lvl', this.level.toFixed(3));
  }

  private stopLevelLoop(): void {
    if (this.animationFrame !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(this.animationFrame);
    this.animationFrame = null;
    this.analyser?.disconnect();
    this.analyser = null;
    this.muteGain?.disconnect();
    this.muteGain = null;
    this.timeData = null;
    // Settle the rings so a stopped recording does not freeze mid-sentence.
    this.level = 0;
    this.card?.style.setProperty('--lvl', '0');
    const audioContext = this.audioContext;
    this.audioContext = null;
    if (audioContext) void audioContext.close().catch(() => {});
  }

  private stopTracks(): void {
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
  }

  private releaseCapture(): void {
    if (this.timerHandle !== null) clearInterval(this.timerHandle);
    this.timerHandle = null;
    this.stopLevelLoop();
    this.stopTracks();
    this.recorder = null;
  }

  private updateTimer(): void {
    if (this.time) this.time.textContent = formatDuration(Date.now() - this.startedAt);
    if (Date.now() - this.startedAt >= MAX_RECORDING_DURATION_MS) {
      this.captureError = 'The recording reached the five-minute limit.';
      this.stopRecording();
    }
  }

  private setState(state: RecordingPanelState, message?: string): void {
    this.state = state;
    this.card?.setAttribute('data-state', state);
    if (message && this.status) {
      this.status.textContent = message;
      this.status.classList.remove('error');
    }
    this.orb?.setAttribute('aria-label', state === 'recording' ? 'Stop recording' : 'Start recording');
    if (state !== 'recording') {
      if (this.timerHandle !== null) clearInterval(this.timerHandle);
      this.timerHandle = null;
      if (this.time) this.time.textContent = '00:00';
    }
  }
}
