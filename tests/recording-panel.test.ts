import { afterEach, describe, expect, it, vi } from 'vitest';
import { RecordingPanel, type RecordingPanelOptions } from '../src/content/RecordingPanel';

afterEach(() => {
  document.getElementById('__voice-type-recording-host')?.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const SAMPLE_RATE = 48_000;

function hooks(overrides: Partial<RecordingPanelOptions> = {}): RecordingPanelOptions {
  return {
    onStart: vi.fn(),
    onSubmit: vi.fn(),
    onCancel: vi.fn(),
    onError: vi.fn(),
    ...overrides,
  };
}

/** MediaRecorder that fires a chunk on stop, the way the browser does. */
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

/**
 * Time-domain audio stub. The orb scales from an RMS figure, not a spectrum,
 * so `amplitude` is the only thing that matters: 0 is silence, 1 is a
 * full-scale sine.
 */
function stubAudio(amplitude: () => number): { advance: (ms: number) => void; analyser: () => AnalyserNode } {
  let captured: AnalyserNode | null = null;

  class FakeAnalyser {
    fftSize = 256;
    getByteTimeDomainData(data: Uint8Array<ArrayBuffer>): void {
      // 128 is the zero-crossing mid-point; +/-128 is full scale.
      const offset = amplitude() * 127;
      for (let index = 0; index < data.length; index += 1) {
        data[index] = Math.round(128 + offset * Math.sin((index / 8) * Math.PI));
      }
    }
    connect(): void {}
    disconnect(): void {}
  }

  class FakeAudioContext {
    sampleRate = SAMPLE_RATE;
    state = 'running';
    destination = {} as AudioDestinationNode;
    currentTime = 0;
    createMediaStreamSource(): { connect: () => void } { return { connect: () => {} }; }
    createAnalyser(): AnalyserNode {
      captured = new FakeAnalyser() as unknown as AnalyserNode;
      return captured;
    }
    createGain(): GainNode {
      return { gain: { value: 1 }, connect: () => {}, disconnect: () => {} } as unknown as GainNode;
    }
    resume(): Promise<void> { return Promise.resolve(); }
    close(): Promise<void> { return Promise.resolve(); }
  }

  vi.stubGlobal('AudioContext', FakeAudioContext);
  return {
    advance: (ms: number) => vi.advanceTimersByTime(ms),
    analyser: () => captured as unknown as AnalyserNode,
  };
}

interface Harness {
  panel: RecordingPanel;
  shadow: ShadowRoot;
  card: HTMLElement;
  orb: HTMLButtonElement;
  state: () => string | null;
}

async function openPanel(options: RecordingPanelOptions): Promise<Harness> {
  const tracks = [{ stop: vi.fn() }];
  const stream = { getTracks: () => tracks } as unknown as MediaStream;
  vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: vi.fn(async () => stream) },
  });
  const panel = new RecordingPanel(options);
  panel.open();
  const shadow = document.getElementById('__voice-type-recording-host')!.shadowRoot!;
  return {
    panel,
    shadow,
    card: shadow.querySelector('.card') as HTMLElement,
    orb: shadow.querySelector('.orb') as HTMLButtonElement,
    state: () => shadow.querySelector('.card')?.getAttribute('data-state') ?? null,
  };
}

describe('RecordingPanel - the approved card', () => {
  it('reproduces the design: dark card, orb, and its three states', async () => {
    const { panel, shadow, state } = await openPanel(hooks());
    // Whitespace- and semicolon-insensitive: the port is formatted, the design
    // is minified, and what is being pinned is the rule, not the punctuation.
    const css = (shadow.querySelector('style')?.textContent ?? '')
      .replace(/\s+/g, ' ')
      .replace(/\s*([{}:;,])\s*/g, '$1')
      .replace(/;}/g, '}');

    for (const token of [
      '--midnight:#0a0f1e', '--slate:#121a30', '--line:#263050',
      '--signal:#ff4d5a', '--wait:#f5b544', '--ok:#43d69a',
    ]) {
      expect(css).toContain(token);
    }
    expect(css).toContain('border-radius:24px');
    expect(css).toContain('width:min(360px,calc(100vw - 32px))');
    expect(css).toContain('padding:16px 20px 20px');
    expect(css).toContain('linear-gradient(160deg,#ff6b76,var(--signal-deep))');
    expect(css).toContain('box-shadow:0 28px 70px rgba(0,0,0,.6)');
    expect(css).toContain('font-size:46px');
    expect(css).toContain('font-weight:300');
    expect(css).toContain('font-variant-numeric:tabular-nums');
    // The glow is a recording-only affordance, so it must be gated on state.
    expect(css).toContain('.card[data-state="recording"]::before{opacity:1}');
    // The orb replaces the old bar equalizer outright.
    expect(shadow.querySelector('.bars')).toBeNull();
    expect(shadow.querySelector('.ring.a')).not.toBeNull();
    expect(shadow.querySelector('.ring.b')).not.toBeNull();
    expect(shadow.querySelector('.spin')).not.toBeNull();
    expect(shadow.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe('Voice transcription');
    expect(state()).toBe('idle');
    panel.destroy();
  });

  it('has no review step: the transcript is never shown on the card', async () => {
    // The design's fourth state — a transcript in an editable box, then a click
    // to accept it — was removed: the text goes straight into the field, so an
    // "Insert" button would only be a second click between the user and their
    // own words.
    const { panel, shadow } = await openPanel(hooks());
    expect(shadow.querySelector('.result')).toBeNull();
    expect(shadow.querySelector('.insert')).toBeNull();
    expect(shadow.querySelector('.discard')).toBeNull();
    expect(shadow.querySelector('style')?.textContent).not.toContain('data-state="done"');
    panel.destroy();
  });

  it('walks idle to recording to processing and hands the clip over on stop', async () => {
    const onStart = vi.fn();
    const onSubmit = vi.fn();
    const { panel, orb, state } = await openPanel(hooks({ onStart, onSubmit }));

    orb.click();
    await vi.waitFor(() => expect(state()).toBe('recording'));
    expect(onStart).toHaveBeenCalledOnce();
    // One control does both jobs; the icons swap rather than the button.
    expect(orb.getAttribute('aria-label')).toBe('Stop recording');

    orb.click();
    await vi.waitFor(() => expect(state()).toBe('processing'));
    // The design removed the separate "Transcribe" step: stopping submits.
    expect(onSubmit).toHaveBeenCalledOnce();
    expect(onSubmit.mock.calls[0]?.[0]).toBeInstanceOf(Blob);
    // The blob keeps the recorder's own type, codecs and all; stripping the
    // parameter is the engine's job at the request boundary, not the panel's.
    expect((onSubmit.mock.calls[0]?.[0] as Blob).type).toBe('audio/webm;codecs=opus');
    panel.destroy();
  });

  it('cancels from the close button and releases the microphone', async () => {
    const onCancel = vi.fn();
    const tracks = [{ stop: vi.fn() }];
    const stream = { getTracks: () => tracks } as unknown as MediaStream;
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: vi.fn(async () => stream) },
    });
    const panel = new RecordingPanel(hooks({ onCancel }));
    panel.open();
    const shadow = document.getElementById('__voice-type-recording-host')!.shadowRoot!;
    (shadow.querySelector('.orb') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(shadow.querySelector('.card')?.getAttribute('data-state')).toBe('recording'));

    (shadow.querySelector('.close') as HTMLButtonElement).click();
    expect(onCancel).toHaveBeenCalledOnce();
    expect(tracks[0]?.stop).toHaveBeenCalled();
    expect(shadow.querySelector('.card')?.getAttribute('data-state')).toBe('idle');
    panel.destroy();
  });

  it('returns to idle with the message when the microphone is blocked', async () => {
    const onError = vi.fn();
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: vi.fn(async () => { throw new Error('Permission denied'); }) },
    });
    const panel = new RecordingPanel(hooks({ onError }));
    panel.open();
    const shadow = document.getElementById('__voice-type-recording-host')!.shadowRoot!;
    (shadow.querySelector('.orb') as HTMLButtonElement).click();

    await vi.waitFor(() =>
      expect(shadow.querySelector('.card')?.getAttribute('data-state')).toBe('idle')
    );
    // The card must not be stuck: the orb is offered again, and the reason is
    // on screen rather than only in a console.
    const status = shadow.querySelector('.status') as HTMLElement;
    expect(status.textContent).toContain('Permission denied');
    expect(status.classList.contains('error')).toBe(true);
    expect((shadow.querySelector('.orb') as HTMLButtonElement).disabled).toBe(false);
    expect(onError).toHaveBeenCalledOnce();
    panel.destroy();
  });

  it('is fully wired on a second card, not just the first', async () => {
    // The reported failure: a card from a finished session stayed in the DOM,
    // and the next session adopted its host — so the new card's controls were
    // never wired and the orb did nothing. A second recording has to work.
    const first = await openPanel(hooks());
    first.orb.click();
    await vi.waitFor(() => expect(first.state()).toBe('recording'));
    first.panel.destroy();

    const onStart = vi.fn();
    const { panel, orb, state } = await openPanel(hooks({ onStart }));
    orb.click();
    await vi.waitFor(() => expect(state()).toBe('recording'));
    expect(onStart).toHaveBeenCalledOnce();
    panel.destroy();
  });

  it('cleans up its host so nothing is left on the page', async () => {
    const { panel } = await openPanel(hooks());
    expect(document.getElementById('__voice-type-recording-host')).not.toBeNull();
    panel.destroy();
    expect(document.getElementById('__voice-type-recording-host')).toBeNull();
  });
});

describe('RecordingPanel - keyboard shortcuts', () => {
  it('starts and stops with Space while the card holds focus', async () => {
    const onStart = vi.fn();
    const onSubmit = vi.fn();
    const { panel, orb, state } = await openPanel(hooks({ onStart, onSubmit }));
    // open() focuses the orb, which is what makes the advertised shortcut work.
    expect(orb).toBe(document.getElementById('__voice-type-recording-host')!.shadowRoot!.activeElement);

    orb.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', key: ' ', bubbles: true, composed: true }));
    await vi.waitFor(() => expect(state()).toBe('recording'));
    orb.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', key: ' ', bubbles: true, composed: true }));
    await vi.waitFor(() => expect(state()).toBe('processing'));
    expect(onSubmit).toHaveBeenCalledOnce();
    panel.destroy();
  });

  it('ignores the shortcut when focus is back in the host page', async () => {
    // The user's caret lives in a field on the page. A document-wide Space
    // handler would make the extension swallow their typing, so the card only
    // listens while it owns focus.
    const onStart = vi.fn();
    const pageField = document.createElement('textarea');
    document.body.appendChild(pageField);
    const { panel, state } = await openPanel(hooks({ onStart }));
    pageField.focus();

    document.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', key: ' ', bubbles: true, composed: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(state()).toBe('idle');
    expect(onStart).not.toHaveBeenCalled();
    pageField.remove();
    panel.destroy();
  });

  it('cancels with Escape while the card holds focus', async () => {
    const onCancel = vi.fn();
    const { panel, orb } = await openPanel(hooks({ onCancel }));
    orb.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, composed: true }));
    expect(onCancel).toHaveBeenCalledOnce();
    panel.destroy();
  });

  it('stops listening once the card is destroyed', async () => {
    const onStart = vi.fn();
    const { panel, orb } = await openPanel(hooks({ onStart }));
    panel.destroy();
    document.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', key: ' ', bubbles: true, composed: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onStart).not.toHaveBeenCalled();
  });
});

describe('RecordingPanel - the orb level', () => {
  it('scales the rings from the live audio level', async () => {
    vi.useFakeTimers();
    let amplitude = 0;
    const audio = stubAudio(() => amplitude);
    const { panel, card, orb } = await openPanel(hooks());
    orb.click();
    await vi.waitFor(() => expect(card.getAttribute('data-state')).toBe('recording'));

    audio.advance(16 * 40);
    expect(Number(card.style.getPropertyValue('--lvl'))).toBeLessThanOrEqual(0.05);

    // Speaking pushes the level up; the rings are driven entirely by this.
    amplitude = 1;
    audio.advance(16 * 60);
    const loud = Number(card.style.getPropertyValue('--lvl'));
    expect(loud).toBeGreaterThan(0.3);
    expect(loud).toBeLessThanOrEqual(1);

    // Quiet again: the level eases down rather than snapping, so the orb reads
    // as speech instead of a flickering light.
    amplitude = 0;
    audio.advance(16);
    const oneFrame = Number(card.style.getPropertyValue('--lvl'));
    expect(oneFrame).toBeLessThan(loud);

    audio.advance(16 * 200);
    expect(Number(card.style.getPropertyValue('--lvl'))).toBeLessThanOrEqual(0.01);
    panel.destroy();
  });

  it('settles the level when recording stops', async () => {
    vi.useFakeTimers();
    const audio = stubAudio(() => 1);
    const { panel, card, orb } = await openPanel(hooks());
    orb.click();
    await vi.waitFor(() => expect(card.getAttribute('data-state')).toBe('recording'));
    audio.advance(16 * 60);
    expect(Number(card.style.getPropertyValue('--lvl'))).toBeGreaterThan(0.3);

    orb.click();
    await vi.waitFor(() => expect(card.getAttribute('data-state')).toBe('processing'));
    // A finished recording must not freeze the rings mid-sentence.
    expect(Number(card.style.getPropertyValue('--lvl'))).toBe(0);
    panel.destroy();
  });

  it('analyses a short time-domain window, not a spectrum', async () => {
    vi.useFakeTimers();
    const { analyser } = stubAudio(() => 0);
    const { panel, orb } = await openPanel(hooks());
    orb.click();
    await vi.waitFor(() => expect(orb.getAttribute('aria-label')).toBe('Stop recording'));

    // The orb scales from one RMS figure; a 256-point window is the right
    // tool and a band spectrum would be describing detail the design hides.
    expect(analyser().fftSize).toBe(256);
    expect(typeof analyser().getByteTimeDomainData).toBe('function');
    panel.destroy();
  });
});

describe('RecordingPanel - timer', () => {
  it('keeps the timer visible and counting, and never announces it', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    stubAudio(() => 0);
    const { panel, shadow, orb, state } = await openPanel(hooks());
    orb.click();
    await vi.waitFor(() => expect(state()).toBe('recording'));

    const time = shadow.querySelector('.time') as HTMLElement;
    expect(time.getAttribute('role')).toBe('timer');
    expect(time.getAttribute('aria-live')).toBe('off');
    expect(time.textContent).toBe('00:00');

    await vi.advanceTimersByTimeAsync(65_000);
    expect(time.textContent).toBe('01:05');
    panel.destroy();
  });

  it('stops at the five-minute limit instead of recording forever', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    stubAudio(() => 0);
    const onError = vi.fn();
    const onSubmit = vi.fn();
    const { panel, card, orb } = await openPanel(hooks({ onError, onSubmit }));
    orb.click();
    await vi.waitFor(() => expect(card.getAttribute('data-state')).toBe('recording'));

    await vi.advanceTimersByTimeAsync(5 * 60_000 + 1000);
    // The clip is never submitted: it would be rejected anyway, and the user
    // is told why instead.
    expect(onSubmit).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledOnce();
    expect(card.getAttribute('data-state')).toBe('idle');
    panel.destroy();
  });
});
