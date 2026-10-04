import { describe, expect, it } from 'vitest';
import {
  AUDIO_FILE_ACCEPT,
  AUDIO_FILE_FORMAT_HINT,
  audioFileExtension,
  base64ToBlob,
  blobToBase64,
  formatAudioFileSize,
  isSupportedAudioFile,
  MAX_AUDIO_FILE_BYTES,
  resolveAudioMimeType,
} from '../src/shared/audio';

describe('audioFileExtension', () => {
  it('reads the lowercase extension, and nothing else', () => {
    expect(audioFileExtension('voice.MP3')).toBe('mp3');
    expect(audioFileExtension('/home/me/My Note (final).m4a')).toBe('m4a');
    expect(audioFileExtension('recording')).toBe('');
    expect(audioFileExtension('.hidden')).toBe('');
    expect(audioFileExtension('trailing.')).toBe('');
  });
});

describe('resolveAudioMimeType', () => {
  it('trusts a documented declared type', () => {
    expect(resolveAudioMimeType('memo.m4a', 'audio/mp4')).toBe('audio/mp4');
    expect(resolveAudioMimeType('memo.mp3', 'audio/mpeg')).toBe('audio/mpeg');
    expect(resolveAudioMimeType('memo.wav', 'audio/x-wav')).toBe('audio/x-wav');
  });

  it('ignores codec parameters on the declared type', () => {
    expect(resolveAudioMimeType('memo.webm', 'audio/webm;codecs=opus')).toBe('audio/webm');
  });

  it('falls back to the extension when the browser reports nothing useful', () => {
    // Real picker behaviour: uncommon containers arrive with an empty type or
    // a generic one, and the type is sent to the model as part of the request.
    expect(resolveAudioMimeType('memo.m4a', '')).toBe('audio/mp4');
    expect(resolveAudioMimeType('memo.m4a', 'application/octet-stream')).toBe('audio/mp4');
    expect(resolveAudioMimeType('memo.wav', 'audio/wave')).toBe('audio/wav');
    expect(resolveAudioMimeType('memo.mp3', 'audio/mp3')).toBe('audio/mp3');
    expect(resolveAudioMimeType('memo.opus', '')).toBe('audio/ogg');
  });

  it('maps every advertised recording format', () => {
    const expected: Record<string, string> = {
      'a.mp3': 'audio/mp3',
      'a.m4a': 'audio/mp4',
      'a.mp4': 'audio/mp4',
      'a.wav': 'audio/wav',
      'a.wave': 'audio/wav',
      'a.webm': 'audio/webm',
      'a.ogg': 'audio/ogg',
      'a.oga': 'audio/ogg',
      'a.opus': 'audio/ogg',
      'a.flac': 'audio/flac',
      'a.aac': 'audio/aac',
      'a.amr': 'audio/amr',
    };
    for (const [name, mime] of Object.entries(expected)) {
      expect(resolveAudioMimeType(name, '')).toBe(mime);
    }
  });

  it('normalises a browser audio alias instead of refusing the file', () => {
    // Chrome reports .wav as audio/wave; the documented spelling is sent, and
    // the file is never rejected over a naming difference.
    expect(resolveAudioMimeType('memo.wav', 'audio/wave')).toBe('audio/wav');
    expect(resolveAudioMimeType('memo.wav', 'audio/vnd.wave')).toBe('audio/wav');
  });

  it('refuses a file the browser identifies as something other than audio', () => {
    // A video named .mp4 must not be uploaded as audio: the browser knows what
    // it is, and the request would carry a mislabelled, oversized payload.
    expect(resolveAudioMimeType('clip.mp4', 'video/mp4')).toBeNull();
    expect(resolveAudioMimeType('memo.pdf', 'application/pdf')).toBeNull();
    expect(resolveAudioMimeType('photo.mp4', 'image/png')).toBeNull();
  });

  it('passes an unrecognised audio type through for the service to judge', () => {
    // It is audio, so the extension has no reason to block it; whether the
    // transcription service supports the container is its answer to give.
    expect(resolveAudioMimeType('memo.wma', 'audio/x-ms-wma')).toBe('audio/x-ms-wma');
  });

  it('rejects anything that is not audio', () => {
    expect(resolveAudioMimeType('notes.pdf', 'application/pdf')).toBeNull();
    expect(resolveAudioMimeType('sheet.xlsx', '')).toBeNull();
    expect(resolveAudioMimeType('photo.png', 'image/png')).toBeNull();
    expect(resolveAudioMimeType('archive', '')).toBeNull();
  });
});

describe('isSupportedAudioFile', () => {
  it('separates usable recordings from other files', () => {
    expect(isSupportedAudioFile('memo.m4a', 'audio/x-m4a')).toBe(true);
    expect(isSupportedAudioFile('memo.m4a', '')).toBe(true);
    expect(isSupportedAudioFile('notes.txt', 'text/plain')).toBe(false);
  });
});

describe('AUDIO_FILE_ACCEPT', () => {
  it('filters the picker by type and by extension', () => {
    expect(AUDIO_FILE_ACCEPT).toContain('audio/*');
    for (const extension of ['.mp3', '.m4a', '.wav', '.webm', '.ogg', '.flac', '.aac']) {
      expect(AUDIO_FILE_ACCEPT).toContain(extension);
    }
    expect(AUDIO_FILE_FORMAT_HINT).toContain('MP3');
  });
});

describe('formatAudioFileSize', () => {
  it('reads as a human would expect', () => {
    expect(formatAudioFileSize(0)).toBe('0 B');
    expect(formatAudioFileSize(512)).toBe('512 B');
    expect(formatAudioFileSize(2048)).toBe('2 KB');
    expect(formatAudioFileSize(2_400_000)).toBe('2.3 MB');
    expect(formatAudioFileSize(12 * 1024 * 1024)).toBe('12 MB');
    expect(formatAudioFileSize(-1)).toBe('');
  });
});

describe('MAX_AUDIO_FILE_BYTES', () => {
  it('matches the ceiling a live recording is held to', () => {
    // One request carries one clip: uploads must not smuggle in more audio
    // than the recorder allows.
    expect(MAX_AUDIO_FILE_BYTES).toBe(12 * 1024 * 1024);
  });
});

describe('base64 audio round-trip', () => {
  it('survives the trip from the popup to the content script', async () => {
    const original = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    const blob = new Blob([original], { type: 'audio/mp4' });
    const base64 = await blobToBase64(blob);
    expect(base64).toBe(btoa(String.fromCharCode(...original)));

    const restored = base64ToBlob(base64, 'audio/mp4');
    expect(restored.type).toBe('audio/mp4');
    expect(new Uint8Array(await restored.arrayBuffer())).toEqual(original);
  });

  it('handles a clip larger than one encoding chunk', async () => {
    // The encoder works in 32 KB chunks; a real recording spans many, so a
    // single-chunk implementation would silently truncate it.
    const bytes = new Uint8Array(0x8000 * 2 + 17);
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = index % 256;
    const base64 = await blobToBase64(new Blob([bytes], { type: 'audio/webm' }));
    const restored = new Uint8Array(await base64ToBlob(base64, 'audio/webm').arrayBuffer());
    expect(restored.length).toBe(bytes.length);
    expect(restored[0]).toBe(0);
    expect(restored[bytes.length - 1]).toBe(bytes[bytes.length - 1]);
  });
});
