import { afterEach, describe, expect, it, vi } from 'vitest';
import { LanguageSupport } from '../src/content/recognition/LanguageSupport';

/**
 * Mode resolution for the multi-language catalog. On-device availability is
 * per language and never guessed, so each case here pins what the resolver
 * may conclude for a given Chrome answer — including third languages the
 * resolver used to get wrong by querying en-US.
 */
function stubSpeechApi(available: (options: { langs: string[]; quality?: string }) => Promise<string>): void {
  class FakeRecognition {
    static available = vi.fn(available);
    static install = vi.fn(async () => {});
    processLocally = true;
  }
  vi.stubGlobal('SpeechRecognition', FakeRecognition);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('LanguageSupport.getRecognitionMode', () => {
  it('uses on-device recognition for any language Chrome reports available', async () => {
    stubSpeechApi(async () => 'available');
    const resolved = await LanguageSupport.getRecognitionMode('de-DE', 'auto');
    expect(resolved.mode).toBe('local');
    expect(resolved.availability).toBe('available');
  });

  it('queries the REQUESTED language, not a hardcoded one', async () => {
    const available = vi.fn(async (_options: { langs: string[]; quality?: string }) => 'available');
    stubSpeechApi(available as never);
    await LanguageSupport.getRecognitionMode('ja-JP', 'auto');
    expect(available.mock.calls[0]?.[0]?.langs).toEqual(['ja-JP']);
  });

  it('keeps a language without on-device support on cloud, stated honestly', async () => {
    stubSpeechApi(async () => 'unavailable');
    const resolved = await LanguageSupport.getRecognitionMode('fa-IR', 'auto');
    expect(resolved.mode).toBe('cloud');
    expect(resolved.availability).toBe('unavailable');
    expect(resolved.note).toContain('cloud');
  });

  it('honours a cloud-only preference without consulting availability', async () => {
    const available = vi.fn(async () => 'available');
    stubSpeechApi(available as never);
    const resolved = await LanguageSupport.getRecognitionMode('en-US', 'cloud');
    expect(resolved.mode).toBe('cloud');
    expect(resolved.availability).toBe('unknown');
    expect(available).not.toHaveBeenCalled();
  });

  it('falls back to cloud with the pack status when the language is downloadable', async () => {
    stubSpeechApi(async () => 'downloadable');
    const resolved = await LanguageSupport.getRecognitionMode('fr-FR', 'auto');
    expect(resolved.mode).toBe('cloud');
    expect(resolved.availability).toBe('downloadable');
    expect(resolved.note).toContain('install');
  });

  it('falls back to cloud when the local-only preference cannot be satisfied', async () => {
    stubSpeechApi(async () => 'unavailable');
    const resolved = await LanguageSupport.getRecognitionMode('en-US', 'local');
    expect(resolved.mode).toBe('cloud');
    expect(resolved.availability).toBe('unavailable');
    expect(resolved.note).toContain('falling back');
  });

  it('reports unknown availability as cloud rather than guessing', async () => {
    stubSpeechApi(async () => 'weird-answer');
    const resolved = await LanguageSupport.getRecognitionMode('es-ES', 'auto');
    expect(resolved.mode).toBe('cloud');
    expect(resolved.availability).toBe('unknown');
  });

  it('retries availability without the quality option when Chrome rejects it', async () => {
    const available = vi.fn(async (options: { quality?: string }) => {
      if ('quality' in options) throw new TypeError('bad option');
      return 'available';
    });
    stubSpeechApi(available as never);
    const resolved = await LanguageSupport.getRecognitionMode('it-IT', 'auto');
    expect(resolved.mode).toBe('local');
    expect(available.mock.calls[1]?.[0]).not.toHaveProperty('quality');
  });

  it('stays on cloud when the browser has no on-device API at all', async () => {
    vi.stubGlobal('SpeechRecognition', class {
      processLocally = true;
    });
    const resolved = await LanguageSupport.getRecognitionMode('de-DE', 'auto');
    expect(resolved.mode).toBe('cloud');
    expect(resolved.availability).toBe('unknown');
  });
});
