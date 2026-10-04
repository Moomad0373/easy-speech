import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExtensionMessage } from '../src/shared/messaging';
import type { RecognitionStatus } from '../src/shared/types';

function status(overrides: Partial<RecognitionStatus> = {}): RecognitionStatus {
  return {
    state: 'idle',
    language: 'fa-IR',
    mode: 'cloud',
    modeNote: 'Cloud recognition',
    availability: 'unknown',
    sessionCount: 0,
    restartCount: 0,
    lastEvent: '',
    lastError: null,
    target: null,
    interimTranscript: '',
    lastFinalTranscript: '',
    note: null,
    uncommittedTranscript: null,
    autoRestart: true,
    ...overrides,
  };
}

function element<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

function stubChrome(initialStatus = status()) {
  const query = vi.fn(async (): Promise<Array<{ id: number }>> => [{ id: 42 }]);
  const addListener = vi.fn();
  const executeScript = vi.fn(async () => {});
  const storageSet = vi.fn(async () => {});
  const sendMessage = vi.fn(async (_tabId: number, message: ExtensionMessage): Promise<unknown> => {
    if (message.type === 'GET_STATUS') return { ok: true, status: initialStatus };
    if (message.type === 'GET_MODE_PREVIEW') {
      return { ok: true, mode: 'cloud', availability: 'unknown', note: 'Preview' };
    }
    return { ok: true };
  });
  vi.stubGlobal('chrome', {
    tabs: { query, sendMessage },
    runtime: { onMessage: { addListener } },
    scripting: { executeScript },
    storage: {
      local: {
        get: vi.fn(async () => ({ prefs: { selectedLanguage: 'fa-IR', preferredEnglishMode: 'cloud' } })),
        set: storageSet,
      },
    },
  });
  return {
    query,
    addListener,
    executeScript,
    storageSet,
    sendMessage,
    broadcast(nextStatus: RecognitionStatus, tabId?: number) {
      const listener = addListener.mock.calls[0]?.[0] as (
        message: ExtensionMessage,
        sender: { tab?: { id: number } }
      ) => void;
      listener({ type: 'RECOGNITION_STATUS', status: nextStatus }, tabId === undefined ? {} : { tab: { id: tabId } });
    },
  };
}

async function loadPopup(): Promise<void> {
  await import('../src/popup/popup');
  await vi.waitFor(() => expect(element<HTMLButtonElement>('toggle').disabled).toBe(false));
}

async function toggle(): Promise<void> {
  element<HTMLButtonElement>('toggle').click();
  await vi.waitFor(() => expect(element<HTMLButtonElement>('toggle').disabled).toBe(false));
}

beforeEach(() => {
  vi.resetModules();
  document.body.innerHTML = `
     <select id="dictation-provider"><option value="voiceTyping">Voice Typing</option><option value="gemini">Gemini</option></select>
     <select id="language"><option value="fa-IR">Persian</option><option value="en-US">English</option></select>
    <span id="mode-badge"></span>
    <p id="mode-note"></p>
    <button id="install-pack" hidden>Install</button>
    <div id="source-switch" hidden>
      <button id="source-record" aria-selected="true">Record</button>
      <button id="source-upload" aria-selected="false">Upload file</button>
    </div>
    <section id="upload-panel" hidden>
      <label id="dropzone" for="audio-file"><span id="dropzone-hint"></span><input id="audio-file" type="file" hidden /></label>
      <div id="file-summary" hidden>
        <span id="file-name"></span><span id="file-meta"></span>
        <button id="file-clear">Remove</button>
      </div>
      <button id="transcribe-file" class="toggle" disabled><span class="toggle-label">Transcribe file</span></button>
    </section>
    <button id="toggle" class="toggle">Start Listening</button>
    <p id="status">Status: Ready</p>
    <p id="note" hidden></p>
    <p id="error" hidden></p>
    <details id="transcripts"><p id="interim"></p><p id="final"></p></details>
    <button id="open-settings">Settings</button>
  `;
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe('popup tab status', () => {
  it('ignores broadcasts before the target tab is resolved and initializes from that tab', async () => {
    const ctx = stubChrome(status({ state: 'listening', lastFinalTranscript: 'Target transcript' }));
    let resolveTab!: (tabs: Array<{ id: number }>) => void;
    ctx.query.mockReturnValueOnce(new Promise((resolve) => { resolveTab = resolve; }));
    await import('../src/popup/popup');
    await vi.waitFor(() => expect(ctx.addListener).toHaveBeenCalledOnce());

    ctx.broadcast(status({ state: 'error', language: 'en-US', lastFinalTranscript: 'Other tab' }), 7);
    ctx.broadcast(status({ state: 'listening', language: 'en-US' }));
    expect(element('status').textContent).toBe('Status: Ready');
    expect(element<HTMLSelectElement>('language').value).toBe('fa-IR');
    expect(element('final').textContent).toBe('');
    expect(element<HTMLButtonElement>('toggle').disabled).toBe(true);

    resolveTab([{ id: 42 }]);
    await vi.waitFor(() => expect(element<HTMLButtonElement>('toggle').disabled).toBe(false));
    expect(element('status').textContent).toBe('Status: Listening…');
    expect(element('toggle').textContent).toContain('Stop Listening');
    expect(element('final').textContent).toBe('Final: Target transcript');
    expect(ctx.sendMessage.mock.calls.every(([tabId]) => tabId === 42)).toBe(true);
  });

  it('ignores other-tab and tabless broadcasts without changing status, language, errors or transcripts', async () => {
    const ctx = stubChrome();
    await loadPopup();
    const before = document.body.innerHTML;
    const foreign = status({
      state: 'listening',
      language: 'en-US',
      mode: 'local',
      availability: 'available',
      modeNote: 'Other mode',
      lastError: { code: 'other', message: 'Other error' },
      interimTranscript: 'Other interim',
      lastFinalTranscript: 'Other final',
      uncommittedTranscript: 'Other uncommitted',
    });
    ctx.sendMessage.mockClear();

    ctx.broadcast(foreign, 7);
    ctx.broadcast(foreign);

    expect(document.body.innerHTML).toBe(before);
    expect(ctx.sendMessage).not.toHaveBeenCalled();
    expect(ctx.storageSet).not.toHaveBeenCalled();
  });

  it('still renders the bound tab broadcasts and synchronizes language without persisting', async () => {
    const ctx = stubChrome();
    await loadPopup();
    ctx.broadcast(status({ state: 'listening', language: 'en-US', lastFinalTranscript: 'Target final' }), 42);

    expect(element('status').textContent).toBe('Status: Listening…');
    expect(element('toggle').textContent).toContain('Stop Listening');
    expect(element<HTMLSelectElement>('language').value).toBe('en-US');
    expect(element('final').textContent).toBe('Final: Target final');
    await vi.waitFor(() => expect(ctx.sendMessage).toHaveBeenCalledWith(42, {
      type: 'GET_MODE_PREVIEW', language: 'en-US',
    }));
    expect(ctx.storageSet).not.toHaveBeenCalled();
  });

  it('shows a one-off note, and hides it again when there is none', async () => {
    // The clipboard backup is a side effect the user did not ask for in that
    // moment; the popup is where they go to find out it happened.
    const ctx = stubChrome();
    await loadPopup();

    expect(element('note').hidden).toBe(true);

    ctx.broadcast(status({ state: 'idle', note: 'Transcript copied to clipboard' }), 42);
    expect(element('note').textContent).toBe('Transcript copied to clipboard');
    expect(element('note').hidden).toBe(false);

    ctx.broadcast(status({ state: 'idle', note: null }), 42);
    expect(element('note').hidden).toBe(true);
    expect(element('note').textContent).toBe('');
  });
});

describe('popup toggle', () => {
  it.each(['starting', 'listening', 'processing', 'restarting', 'stopping'] as const)(
    'stops a freshly %s target even when the displayed status is idle', async (state) => {
      const ctx = stubChrome();
      await loadPopup();
      ctx.broadcast(status({ state: 'idle', language: 'en-US' }), 7);
      ctx.sendMessage.mockClear();
      ctx.sendMessage.mockResolvedValueOnce({ ok: true, status: status() });
      ctx.sendMessage.mockResolvedValueOnce({ ok: true, status: status({ state }) });

      await toggle();

      expect(ctx.sendMessage.mock.calls).toEqual([
        [42, { type: 'GET_STATUS' }],
        [42, { type: 'GET_STATUS' }],
        [42, { type: 'STOP_RECOGNITION' }],
      ]);
    }
  );

  it.each(['idle', 'error'] as const)(
    'starts a freshly %s target despite stale listening status and foreign broadcasts', async (state) => {
      const ctx = stubChrome(status({ state: 'listening' }));
      await loadPopup();
      ctx.broadcast(status({ state: 'listening', language: 'en-US' }), 7);
      ctx.query.mockResolvedValue([{ id: 7 }]);
      ctx.sendMessage.mockClear();
      ctx.sendMessage.mockResolvedValueOnce({ ok: true, status: status({ state: 'listening' }) });
      ctx.sendMessage.mockResolvedValueOnce({ ok: true, status: status({ state }) });

      await toggle();

      expect(ctx.sendMessage.mock.calls).toEqual([
        [42, { type: 'GET_STATUS' }],
        [42, { type: 'GET_STATUS' }],
        [42, { type: 'START_RECOGNITION', language: 'fa-IR', preferredMode: 'cloud' }],
      ]);
      expect(ctx.query).toHaveBeenCalledOnce();
    }
  );

  it('does not guess a command when the fresh status request fails and permits retry', async () => {
    const ctx = stubChrome(status({ state: 'listening' }));
    await loadPopup();
    ctx.sendMessage.mockClear();
    ctx.sendMessage.mockResolvedValueOnce({ ok: true, status: status() });
    ctx.sendMessage.mockRejectedValueOnce(new Error('Tab closed'));

    await toggle();

    expect(ctx.sendMessage.mock.calls.map(([, message]) => message.type)).toEqual(['GET_STATUS', 'GET_STATUS']);
    expect(element('error').hidden).toBe(false);
    expect(element('error').textContent).toContain('Could not read recognition status');
    await toggle();
    expect(ctx.sendMessage).toHaveBeenCalledWith(42, { type: 'STOP_RECOGNITION' });
  });

  it.each(['idle', 'listening'] as const)('shows a failed command response for %s', async (state) => {
    const ctx = stubChrome(status({ state }));
    await loadPopup();
    ctx.sendMessage.mockResolvedValueOnce({ ok: true, status: status({ state }) });
    ctx.sendMessage.mockResolvedValueOnce({ ok: true, status: status({ state }) });
    ctx.sendMessage.mockRejectedValueOnce(new Error('Receiving end does not exist'));

    await toggle();

    expect(element('error').hidden).toBe(false);
    expect(element('error').textContent).toContain(state === 'idle' ? 'failed to start' : 'could not be stopped');
  });

  it('starts the Gemini recorder when recording mode is selected', async () => {
    const ctx = stubChrome();
    await loadPopup();
    const provider = element<HTMLSelectElement>('dictation-provider');
    provider.value = 'gemini';
    provider.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() => expect(ctx.storageSet).toHaveBeenCalledWith({
      prefs: expect.objectContaining({ dictationProvider: 'gemini' }),
    }));

    ctx.sendMessage.mockClear();
    ctx.sendMessage.mockResolvedValueOnce({ ok: true, status: status({ state: 'idle' }) });
    ctx.sendMessage.mockResolvedValueOnce({ ok: true, status: status({ state: 'idle' }) });
    ctx.sendMessage.mockResolvedValueOnce({ ok: true, mode: 'cloud' });
    await toggle();

    expect(ctx.sendMessage).toHaveBeenCalledWith(42, {
      type: 'START_GEMINI_RECORDING',
      language: 'fa-IR',
      model: 'gemini-3.5-transcribe',
    });
  });

  it('preserves the focused-field error for a rejected start', async () => {
    const ctx = stubChrome();
    await loadPopup();
    ctx.sendMessage.mockResolvedValueOnce({ ok: true, status: status() });
    ctx.sendMessage.mockResolvedValueOnce({ ok: true, status: status() });
    ctx.sendMessage.mockResolvedValueOnce({ ok: false, reason: 'no-target' });

    await toggle();

    expect(element('error').textContent).toContain('No supported text field is focused');
  });

  it('shows injection failures and re-enables the toggle', async () => {
    const ctx = stubChrome();
    await loadPopup();
    ctx.sendMessage.mockClear();
    ctx.sendMessage.mockRejectedValueOnce(new Error('Receiving end does not exist'));
    ctx.executeScript.mockRejectedValueOnce(new Error('Restricted page'));

    await toggle();

    expect(ctx.sendMessage).toHaveBeenCalledOnce();
    expect(element('error').hidden).toBe(false);
    expect(element('error').textContent).toContain('does not allow extensions');
  });
});

describe('popup initialization failures', () => {
  it.each(['missing', 'rejected'] as const)('handles a %s active tab without enabling commands', async (failure) => {
    const ctx = stubChrome();
    if (failure === 'missing') ctx.query.mockResolvedValue([]);
    else ctx.query.mockRejectedValue(new Error('Tab query failed'));

    await import('../src/popup/popup');

    await vi.waitFor(() => expect(element('error').hidden).toBe(false));
    expect(element('error').textContent).toBe(failure === 'missing' ? 'No active tab.' : 'Tab query failed');
    expect(element<HTMLButtonElement>('toggle').disabled).toBe(true);
    expect(ctx.sendMessage).not.toHaveBeenCalled();
  });
});

describe('popup audio file upload', () => {
  function audioFile(name: string, type: string, bytes = 64): File {
    return new File([new Uint8Array(bytes)], name, { type });
  }

  /** Selects a file the way the picker does, then dispatches `change`. */
  function chooseFile(file: File): void {
    const input = element<HTMLInputElement>('audio-file');
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function dropFile(file: File): void {
    const event = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', { value: { files: [file] } });
    element('dropzone').dispatchEvent(event);
  }

  async function selectUploadTab(): Promise<void> {
    element<HTMLButtonElement>('source-upload').click();
  }

  async function transcribe(): Promise<void> {
    element<HTMLButtonElement>('transcribe-file').click();
    // Wait for the upload message itself: ensureContentScript probes the tab
    // with GET_STATUS first, so "any call" would return before the file went
    // anywhere.
    await vi.waitFor(() => expect(ctx.sendMessage).toHaveBeenCalledWith(
      42, expect.objectContaining({ type: 'TRANSCRIBE_AUDIO_FILE' })
    ));
  }

  let ctx: ReturnType<typeof stubChrome>;

  beforeEach(async () => {
    ctx = stubChrome();
    await loadPopup();
    // The source switch only exists in Voice Recording mode.
    const provider = element<HTMLSelectElement>('dictation-provider');
    provider.value = 'gemini';
    provider.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() => expect(element('source-switch').hidden).toBe(false));
    await selectUploadTab();
    ctx.sendMessage.mockClear();
  });

  it('offers recording and file upload side by side, one action at a time', () => {
    expect(element('source-switch').hidden).toBe(false);
    expect(element('upload-panel').hidden).toBe(false);
    // The record button steps aside so the popup never shows two primaries.
    expect(element<HTMLButtonElement>('toggle').hidden).toBe(true);
    expect(element('source-upload').getAttribute('aria-selected')).toBe('true');
    expect(element('source-record').getAttribute('aria-selected')).toBe('false');

    element<HTMLButtonElement>('source-record').click();
    expect(element('upload-panel').hidden).toBe(true);
    expect(element<HTMLButtonElement>('toggle').hidden).toBe(false);
  });

  it('hides the upload option in Voice Typing mode', async () => {
    const provider = element<HTMLSelectElement>('dictation-provider');
    provider.value = 'voiceTyping';
    provider.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() => expect(element('source-switch').hidden).toBe(true));
    expect(element('upload-panel').hidden).toBe(true);
  });

  it('sends a picked file for transcription and inserts nothing locally', async () => {
    chooseFile(audioFile('voice memo.m4a', 'audio/x-m4a'));
    expect(element('file-summary').hidden).toBe(false);
    expect(element('file-name').textContent).toBe('voice memo.m4a');
    expect(element('file-meta').textContent).toContain('M4A');
    expect(element<HTMLButtonElement>('transcribe-file').disabled).toBe(false);

    await transcribe();

    expect(ctx.sendMessage).toHaveBeenCalledWith(42, {
      type: 'TRANSCRIBE_AUDIO_FILE',
      // 64 zero bytes, base64-encoded.
      data: btoa('\0'.repeat(64)),
      // The browser's own (documented) type is what travels, not the extension's.
      mimeType: 'audio/x-m4a',
      fileName: 'voice memo.m4a',
      language: 'fa-IR',
      model: 'gemini-3.5-transcribe',
    });
  });

  it('falls back to the extension when the browser reports no type', async () => {
    // A file type the OS cannot name is still a usable recording: the
    // extension decides, so an iPhone .m4a note is never refused.
    chooseFile(audioFile('memo.m4a', ''));
    await transcribe();
    expect(ctx.sendMessage).toHaveBeenCalledWith(42, expect.objectContaining({
      type: 'TRANSCRIBE_AUDIO_FILE', mimeType: 'audio/mp4', fileName: 'memo.m4a',
    }));
  });

  it('accepts a dropped file exactly like a chosen one', async () => {
    dropFile(audioFile('dropped.mp3', ''));
    expect(element('file-name').textContent).toBe('dropped.mp3');
    await transcribe();
    expect(ctx.sendMessage).toHaveBeenCalledWith(42, expect.objectContaining({
      type: 'TRANSCRIBE_AUDIO_FILE', mimeType: 'audio/mp3', fileName: 'dropped.mp3',
    }));
  });

  it('refuses a file that is not audio, before reading or sending it', () => {
    chooseFile(audioFile('notes.pdf', 'application/pdf'));
    expect(element('file-summary').hidden).toBe(true);
    expect(element<HTMLButtonElement>('transcribe-file').disabled).toBe(true);
    expect(element('error').hidden).toBe(false);
    expect(element('error').textContent).toContain('not a supported audio file');
    expect(ctx.sendMessage).not.toHaveBeenCalled();
  });

  it('refuses a file above the size ceiling', () => {
    chooseFile(audioFile('huge.wav', 'audio/wav', 13 * 1024 * 1024));
    expect(element('error').textContent).toContain('13 MB');
    expect(element<HTMLButtonElement>('transcribe-file').disabled).toBe(true);
    expect(ctx.sendMessage).not.toHaveBeenCalled();
  });

  it('refuses an empty file', () => {
    chooseFile(audioFile('empty.m4a', 'audio/mp4', 0));
    expect(element('error').textContent).toContain('empty');
    expect(ctx.sendMessage).not.toHaveBeenCalled();
  });

  it('lets the user remove a chosen file and pick another', () => {
    chooseFile(audioFile('first.mp3', 'audio/mpeg'));
    element<HTMLButtonElement>('file-clear').click();
    expect(element('file-summary').hidden).toBe(true);
    expect(element<HTMLButtonElement>('transcribe-file').disabled).toBe(true);

    chooseFile(audioFile('second.mp3', 'audio/mpeg'));
    expect(element('file-name').textContent).toBe('second.mp3');
  });

  it('shows a busy state until the transcript has been committed', async () => {
    chooseFile(audioFile('memo.webm', 'audio/webm'));
    await transcribe();
    ctx.broadcast(status({ state: 'processing' }), 42);
    // Still working: the control must stay disabled and say so.
    expect(element<HTMLButtonElement>('transcribe-file').disabled).toBe(true);
    expect(element('transcribe-file').textContent).toContain('Transcribing');

    ctx.broadcast(status({ state: 'idle', lastFinalTranscript: 'memo transcript' }), 42);
    // Settled: the file is cleared so the same clip is never sent twice by
    // accident, and the transcript is on screen.
    expect(element<HTMLButtonElement>('transcribe-file').disabled).toBe(true);
    expect(element('file-summary').hidden).toBe(true);
    expect(element('transcribe-file').textContent).toContain('Transcribe file');
    expect(element('final').textContent).toBe('Final: memo transcript');
  });

  it('releases the busy state and clears the file once the session settles', async () => {
    chooseFile(audioFile('memo.webm', 'audio/webm'));
    await transcribe();
    ctx.broadcast(status({ state: 'idle', lastFinalTranscript: 'done' }), 42);
    expect(element<HTMLButtonElement>('transcribe-file').disabled).toBe(true);

    // A fresh choice is possible once the previous one finished.
    chooseFile(audioFile('next.webm', 'audio/webm'));
    expect(element('file-name').textContent).toBe('next.webm');
    expect(element<HTMLButtonElement>('transcribe-file').disabled).toBe(false);
  });

  it('keeps the file when the attempt failed, so it can be retried', async () => {
    chooseFile(audioFile('memo.webm', 'audio/webm'));
    await transcribe();
    ctx.broadcast(status({ state: 'error', lastError: { code: 'gemini-error', message: 'No transcript.' } }), 42);

    expect(element<HTMLButtonElement>('transcribe-file').disabled).toBe(false);
    expect(element('file-summary').hidden).toBe(false);
    expect(element('error').textContent).toContain('No transcript.');
  });

  it('explains a rejected start and stops claiming to be busy', async () => {
    chooseFile(audioFile('memo.webm', 'audio/webm'));
    ctx.sendMessage.mockResolvedValueOnce({ ok: true, status: status() });
    ctx.sendMessage.mockResolvedValueOnce({ ok: false, reason: 'no-target' });

    await transcribe();

    expect(element('error').textContent).toContain('Focus the text field');
    expect(element('transcribe-file').textContent).toContain('Transcribe file');
  });

  it('surfaces a missing API key for an upload', async () => {
    chooseFile(audioFile('memo.webm', 'audio/webm'));
    ctx.sendMessage.mockResolvedValueOnce({ ok: true, status: status() });
    ctx.sendMessage.mockResolvedValueOnce({ ok: false, reason: 'gemini-key' });

    await transcribe();

    expect(element('error').textContent).toContain('Google API key');
  });

  it('advertises the supported formats on the picker', () => {
    const accept = element<HTMLInputElement>('audio-file').accept;
    expect(accept).toContain('audio/*');
    expect(accept).toContain('.mp3');
    expect(element('dropzone-hint').textContent).toContain('MP3');
    expect(element('dropzone-hint').textContent).toContain('12 MB');
  });
});
