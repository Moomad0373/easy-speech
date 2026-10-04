import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FormControlAdapter } from '../src/content/insertion/FormControlAdapter';
import { TargetManager } from '../src/content/insertion/TargetManager';
import { RecognitionManager } from '../src/content/recognition/RecognitionManager';
import {
  GeminiTranscribeEngine,
  type AudioFileUpload,
} from '../src/content/recognition/engine/GeminiTranscribeEngine';
import type { SpeechEngine } from '../src/content/recognition/engine/SpeechEngine';
import { blobToBase64 } from '../src/shared/audio';
import { isActiveState } from '../src/shared/state';
import type { TranscriptionSettings } from '../src/shared/transcription';
import type { RecognitionStatus } from '../src/shared/types';

/**
 * End-to-end for "transcribe a recording I already have": a picked file goes
 * in, and the transcript comes out in the focused field — through the same
 * manager, target and insertion path a live recording uses. Only the network
 * boundary is stubbed.
 */
describe('uploading a recording the user already has', () => {
  let field: HTMLTextAreaElement;
  let manager: RecognitionManager;
  let targets: TargetManager;
  let statuses: RecognitionStatus[];
  let storageSet: ReturnType<typeof vi.fn>;

  /** Mirrors the content script: capture the field, then start the session. */
  function startSession(
    language: 'en-US' | 'fa-IR' = 'en-US',
    transcription?: TranscriptionSettings
  ): void {
    expect(targets.capture(field).ok).toBe(true);
    manager.start(
      {
        language,
        mode: 'cloud',
        provider: 'gemini',
        geminiModel: 'gemini-3.5-transcribe',
        ...(transcription ? { transcription } : {}),
      },
      'unknown',
      ''
    );
  }

  beforeEach(() => {
    field = document.createElement('textarea');
    field.value = '';
    document.body.appendChild(field);

    storageSet = vi.fn(async () => {});
    vi.stubGlobal('chrome', {
      runtime: {
        sendMessage: vi.fn(async () => ({ ok: true, text: 'the quick brown fox' })),
      },
      storage: { local: { set: storageSet, get: vi.fn(async () => ({})), remove: vi.fn(async () => {}) } },
    });

    statuses = [];
    targets = new TargetManager([new FormControlAdapter()]);
    manager = new RecognitionManager({
      engineFactory: (config, callbacks): SpeechEngine => {
        const upload: AudioFileUpload = {
          blob: new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'audio/mp4' }),
          name: 'memo.m4a',
        };
        return new GeminiTranscribeEngine(config, callbacks, {
          onStopRequested: () => manager.stop(),
          onCancelRequested: () => manager.cancel(),
          upload,
        });
      },
      targets,
      onStatus: (status) => statuses.push(status),
    });
  });

  afterEach(() => {
    field.remove();
    vi.unstubAllGlobals();
  });

  it('inserts the transcript into the focused field', async () => {
    startSession();

    await vi.waitFor(() => expect(field.value).toBe('the quick brown fox'));
    expect(manager.getStatus().lastFinalTranscript).toBe('the quick brown fox');
  });

  it('reports the session as finished, exactly like a recorded clip', async () => {
    startSession();
    await vi.waitFor(() => expect(field.value).toBe('the quick brown fox'));
    await vi.waitFor(() => expect(manager.getStatus().state).toBe('idle'));
    // It went through a live-looking lifecycle, so the popup renders it the
    // same way it renders a recording.
    expect(statuses.some((status) => isActiveState(status.state))).toBe(true);
    expect(manager.getStatus().uncommittedTranscript).toBeNull();
  });

  it('separates the transcript from the text already in the field', async () => {
    // Same word-boundary spacing as a live session: the engine pads utterances
    // with a space, and it must not glue the first word onto existing prose.
    field.value = 'Notes:';
    field.setSelectionRange(6, 6);

    startSession();

    await vi.waitFor(() => expect(field.value).toContain('the quick brown fox'));
    expect(field.value).toBe('Notes: the quick brown fox');
  });

  it('leaves the caret right after the inserted transcript', async () => {
    startSession();
    await vi.waitFor(() => expect(field.value).toBe('the quick brown fox'));
    expect(field.selectionStart).toBe('the quick brown fox'.length);
  });

  it('never writes the audio anywhere but the request', async () => {
    startSession();
    await vi.waitFor(() => expect(field.value).toBe('the quick brown fox'));

    // The picked file exists only in memory for the length of the request.
    expect(storageSet).not.toHaveBeenCalled();
    const sent = (chrome.runtime.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(sent).toMatchObject({ type: 'TRANSCRIBE_AUDIO', mimeType: 'audio/mp4' });
  });

  it('sends the very same request shape a live recording sends', async () => {
    startSession('fa-IR', { language: 'fa-IR', mode: 'smart', vocabulary: ['زیتکس', 'مهدی'] });
    await vi.waitFor(() => expect(field.value).toBe('the quick brown fox'));

    const sendMessage = chrome.runtime.sendMessage as ReturnType<typeof vi.fn>;
    expect(sendMessage).toHaveBeenCalledOnce();
    const message = sendMessage.mock.calls[0]?.[0];
    expect(Object.keys(message).sort()).toEqual(
      ['data', 'mimeType', 'model', 'requestId', 'transcription', 'type'].sort()
    );
    // The session language no longer rides along on the request: automatic
    // detection and custom vocabulary are part of the transcription settings.
    expect(message.transcription).toEqual({
      language: 'fa-IR',
      mode: 'smart',
      vocabulary: ['زیتکس', 'مهدی'],
    });
    expect(message.data).toBe(await blobToBase64(new Blob([new Uint8Array([1, 2, 3, 4])])));
  });

  it('falls back to the default transcription settings when none are supplied', async () => {
    startSession();
    await vi.waitFor(() => expect(field.value).toBe('the quick brown fox'));

    const message = (chrome.runtime.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(message.transcription).toEqual({ language: 'fa-IR', mode: 'verbatim', vocabulary: [] });
  });

  it('surfaces a transcription failure and writes nothing', async () => {
    (chrome.runtime.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false, error: 'quota', message: 'The Gemini API quota is unavailable right now.',
    });

    startSession();

    await vi.waitFor(() => expect(manager.getStatus().lastError?.code).toBe('gemini-error'));
    expect(manager.getStatus().lastError?.message).toContain('quota');
    expect(field.value).toBe('');
  });
});
