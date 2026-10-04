/**
 * Content-script entry point, injected on demand via chrome.scripting.
 *
 * This module owns no recognition or insertion logic itself — it only wires
 * together the target manager (cursor capture + text insertion), the
 * recognition manager (session lifecycle), and the Chrome messaging surface
 * used by the popup (spec §20, §21).
 */
import { STATUS_BROADCAST_THROTTLE_MS, DEFAULT_GEMINI_MODEL } from '../shared/constants';
import {
  broadcastStatus,
  type CycleLanguageResponse,
  type ExtensionMessage,
  type GeminiStatusResponse,
  type InstallPackResponse,
  type ModePreviewResponse,
  type SetOptionsPayload,
  type StartResponse,
  type StatusResponse,
} from '../shared/messaging';
import { DEFAULT_PREFS, loadPrefs, mergeSetOptions, savePrefs, type Prefs } from '../shared/storage';
import { base64ToBlob, MAX_AUDIO_FILE_BYTES } from '../shared/audio';
import { nextBookmarkedLanguage } from '../shared/languages';
import { matchesShortcut } from '../shared/shortcut';
import { isActiveState } from '../shared/state';
import { transcriptionSettingsFrom } from '../shared/transcription';
import type { Language, RecognitionModePreference, RecognitionStatus } from '../shared/types';
import { StatusIndicator } from './StatusIndicator';
import { ContentEditableAdapter } from './insertion/ContentEditableAdapter';
import { FormControlAdapter } from './insertion/FormControlAdapter';
import { GoogleKeepAdapter } from './insertion/GoogleKeepAdapter';
import { TargetManager } from './insertion/TargetManager';
import type { SpeechEngine } from './recognition/engine/SpeechEngine';
import { GeminiTranscribeEngine, type AudioFileUpload } from './recognition/engine/GeminiTranscribeEngine';
import { WebSpeechEngine } from './recognition/engine/WebSpeechEngine';
import { LanguageSupport } from './recognition/LanguageSupport';
import { RecognitionManager } from './recognition/RecognitionManager';

declare global {
  // Guard against double injection when executeScript runs twice in a tab.
  var __voiceTypeInjected: boolean | undefined;
}

function main(): void {
  // Track the last focused editable element so the floating badge can
  // re-use it when the badge interaction itself blurs the field. This is
  // critical for correct cursor position: clicking the overlay moves focus
  // to body in Chrome before pointerup, so document.activeElement at click
  // time is already wrong. StatusIndicator captures focus at pointerdown
  // (before blur) and passes it here; this fallback covers edge cases
  // (keyboard shortcut, touch, etc.) where pointerdown capture is unavailable.
  let lastFocusedElement: Element | null = null;
  document.addEventListener(
    'focusin',
    (event) => {
      const target = event.target as Element | null;
      if (target && target !== document.body && target !== document.documentElement) {
        // Only remember elements that could be dictation targets — avoid
        // storing the badge host itself or unrelated UI.
        lastFocusedElement = target;
      }
    },
    true
  );

  /** True when the element may anchor dictation (not body/html, not the badge). */
  function isDictatableFocus(element: Element | null): element is Element {
    if (!element || element === document.body || element === document.documentElement) {
      return false;
    }
    if (element.id === '__voice-type-status-host') return false;
    return !element.closest?.('#__voice-type-status-host');
  }

  /**
   * Resolve the element dictation should anchor to, in preference order: the
   * focus captured at pointerdown (pre-blur) by the badge, the last focused
   * editable, the current activeElement. This guarantees each spoken word is
   * inserted once at the caret the user last placed, instead of at 0 or at
   * the badge host, which previously caused duplicated words when the preview
   * was anchored at the wrong offset (especially visible with English
   * dictation via the badge, where interim previews are frequent). Shared by
   * the badge toggle and handleStart so both apply identical rules.
   */
  function resolveDictationTarget(captured: Element | null): Element | null {
    if (isDictatableFocus(captured) && captured.isConnected) return captured;
    if (isDictatableFocus(lastFocusedElement) && lastFocusedElement.isConnected) {
      return lastFocusedElement;
    }
    const active = document.activeElement;
    return isDictatableFocus(active) ? active : null;
  }

  const badge = new StatusIndicator({
    onToggle: (capturedFocus) => {
      // Badge click: exactly the popup toggle button behavior. Focus
      // resolution happens in handleStart via resolveDictationTarget.
      if (isActiveState(manager.getStatus().state)) {
        manager.stop();
        return;
      }
      void handleStart(
        prefs?.selectedLanguage ?? DEFAULT_PREFS.selectedLanguage,
        prefs?.preferredRecognitionMode ?? DEFAULT_PREFS.preferredRecognitionMode,
        capturedFocus
      );
    },
  });
  const targets = new TargetManager(
    // Site-specific adapters first — TargetManager picks the first match.
    [new FormControlAdapter(), new GoogleKeepAdapter(), new ContentEditableAdapter()]
  );

  let prefs: Prefs = { ...DEFAULT_PREFS };

  /**
   * Audio handed over by the popup for the very next engine instance (a
   * recording the user already has). Consumed by the factory below, so it can
   * never leak into a later session: an upload belongs to one start.
   */
  let pendingUpload: AudioFileUpload | null = null;

  let manager: RecognitionManager;
  manager = new RecognitionManager({
    engineFactory: (config, callbacks): SpeechEngine => {
      if (config.provider !== 'gemini') return new WebSpeechEngine(config, callbacks);
      const upload = pendingUpload;
      pendingUpload = null;
      return new GeminiTranscribeEngine(config, callbacks, {
        onStopRequested: () => manager.stop(),
        onCancelRequested: () => manager.cancel(),
        ...(upload ? { upload } : {}),
      });
    },
    targets,
    onStatus: (status) => {
      badge.update(status);
      broadcastThrottled(status);
    },
  });

  // ---- throttled status broadcasting -------------------------------------
  // Interim transcripts can be very chatty; state changes always go out
  // immediately, transcript-only updates are throttled.
  let lastBroadcastAt = 0;
  let lastState: RecognitionStatus['state'] = 'idle';
  let pendingStatus: RecognitionStatus | null = null;
  let pendingTimer: ReturnType<typeof setTimeout> | null = null;

  function broadcastThrottled(status: RecognitionStatus): void {
    const now = Date.now();
    if (status.state !== lastState || now - lastBroadcastAt >= STATUS_BROADCAST_THROTTLE_MS) {
      clearPending();
      lastBroadcastAt = now;
      lastState = status.state;
      broadcastStatus(status);
      return;
    }
    pendingStatus = status;
    if (pendingTimer === null) {
      pendingTimer = setTimeout(() => {
        pendingTimer = null;
        if (pendingStatus) {
          lastBroadcastAt = Date.now();
          lastState = pendingStatus.state;
          broadcastStatus(pendingStatus);
          pendingStatus = null;
        }
      }, STATUS_BROADCAST_THROTTLE_MS);
    }
  }

  function clearPending(): void {
    if (pendingTimer !== null) {
      clearTimeout(pendingTimer);
      pendingTimer = null;
    }
    pendingStatus = null;
  }

  // ---- message handling ----------------------------------------------------

  async function applyPrefs(next: Prefs): Promise<void> {
    prefs = next;
    badge.setEnabled(prefs.showStatusIndicator);
    manager.setAutoRestart(prefs.autoRestart);
    manager.setVoiceCommands(prefs.voiceCommands);
    manager.setCustomCommands(prefs.customCommands);
    manager.setNumbersAsDigits(prefs.numbersAsDigits);
    manager.setSelectedLanguage(prefs.selectedLanguage);
  }

  async function handleStart(
    language: Language,
    preferredMode: RecognitionModePreference,
    focusElement: Element | null = null,
    upload: AudioFileUpload | null = null
  ): Promise<StartResponse> {
    await applyPrefs(await loadPrefs());
    const provider = prefs.dictationProvider;
    if (provider === 'gemini') {
      const status = (await chrome.runtime.sendMessage({ type: 'GET_GEMINI_STATUS' })) as GeminiStatusResponse;
      if (!status?.configured) return { ok: false, reason: 'gemini-key' };
    } else if (!LanguageSupport.isSupported()) {
      return { ok: false, reason: 'error' };
    }

    const targetElement = resolveDictationTarget(focusElement);
    let capture = targets.capture(targetElement);
    if (!capture.ok && targetElement !== lastFocusedElement && lastFocusedElement?.isConnected) {
      capture = targets.capture(lastFocusedElement);
    }
    if (!capture.ok) {
      manager.reportNoTarget();
      return { ok: false, reason: 'no-target' };
    }

    if (provider === 'gemini') {
      // Handed to the engine the manager builds for this session only; the
      // factory clears it, so a plain recording afterwards is unaffected.
      pendingUpload = upload;
      manager.start(
        {
          language,
          mode: 'cloud',
          provider: 'gemini',
          geminiModel: prefs.geminiModel || DEFAULT_GEMINI_MODEL,
          transcription: transcriptionSettingsFrom(prefs),
        },
        'unknown',
        'Gemini 3.5 Transcribe'
      );
      return { ok: true, mode: 'cloud' };
    }

    const resolved = await LanguageSupport.getRecognitionMode(language, preferredMode);
    manager.start({ language, mode: resolved.mode, provider: 'voiceTyping' }, resolved.availability, resolved.note);
    return { ok: true, mode: resolved.mode };
  }

  /**
   * Rebuild the clip the user picked from the popup's base64 payload.
   * The size is re-checked here: the popup validates too, but this boundary
   * decodes the string, and decoding a hostile payload before rejecting it
   * would be the expensive way to say no.
   */
  function audioUploadFromMessage(message: {
    data: unknown;
    mimeType: unknown;
    fileName: unknown;
  }): AudioFileUpload | null {
    if (typeof message.data !== 'string' || message.data.length === 0) return null;
    if (typeof message.mimeType !== 'string' || !message.mimeType.startsWith('audio/')) return null;
    // Base64 inflates by 4/3; refuse anything past the clip ceiling before decoding.
    if (message.data.length > Math.ceil((MAX_AUDIO_FILE_BYTES * 4) / 3) + 1024) return null;
    const name = typeof message.fileName === 'string' && message.fileName.length > 0
      ? message.fileName
      : 'recording';
    try {
      return { blob: base64ToBlob(message.data, message.mimeType), name };
    } catch {
      return null;
    }
  }

  async function handleModePreview(language: Language): Promise<ModePreviewResponse> {
    if (prefs.dictationProvider === 'gemini') {
      const status = (await chrome.runtime.sendMessage({ type: 'GET_GEMINI_STATUS' })) as GeminiStatusResponse;
      return {
        ok: true,
        supported: true,
        onDeviceSupported: false,
        mode: 'cloud',
        availability: 'unknown',
        note: status?.configured ? 'Gemini 3.5 Transcribe is configured.' : 'Add a Google API key in Settings to use Gemini.',
        provider: 'gemini',
        geminiConfigured: status?.configured === true,
      };
    }
    const supported = LanguageSupport.isSupported();
    const onDeviceSupported = LanguageSupport.supportsOnDevice();
    const resolved = await LanguageSupport.getRecognitionMode(language, prefs.preferredRecognitionMode);
    return {
      ok: supported,
      supported,
      onDeviceSupported,
      mode: resolved.mode,
      availability: resolved.availability,
      note: resolved.note,
      provider: 'voiceTyping',
      geminiConfigured: false,
    };
  }

  async function handleInstall(language: Language): Promise<InstallPackResponse> {
    const installed = await LanguageSupport.installLanguagePack(language);
    const preview = await handleModePreview(language);
    return { ok: installed, preview };
  }

  /**
   * Applies a settings broadcast (options page / popup). The content script
   * is a CONSUMER of settings, never a writer: it must not persist anything
   * here, or its stale in-memory snapshot would overwrite fields the
   * broadcast didn't carry and revert the options page's saved values
   * milliseconds later (observed as "settings are not being saved").
   */
  async function handleSetOptions(options: SetOptionsPayload): Promise<StatusResponse> {
    const stored = await loadPrefs();
    const previousProvider = prefs.dictationProvider;
    const next = mergeSetOptions(stored, options);
    await applyPrefs(next);
    if (previousProvider !== next.dictationProvider && isActiveState(manager.getStatus().state)) {
      manager.cancel();
    }
    return { ok: true, status: manager.getStatus() };
  }

  /**
   * Quick language switch (spec §42): rotate through the bookmarked
   * languages, persist the choice, and restart a live session so dictation
   * continues seamlessly in the new language. This is the single source of
   * cycle logic — the service worker only forwards CYCLE_LANGUAGE here.
   */
  async function handleCycleLanguage(): Promise<CycleLanguageResponse> {
    const loaded = await loadPrefs();
    const next = nextBookmarkedLanguage(loaded.selectedLanguage, loaded.bookmarkedLanguages);
    if (next === loaded.selectedLanguage) return { ok: true, language: next };

    const nextPrefs: Prefs = { ...loaded, selectedLanguage: next };
    await applyPrefs(nextPrefs);
    await savePrefs({ selectedLanguage: next });

    if (isActiveState(manager.getStatus().state)) {
      if (prefs.dictationProvider === 'gemini') {
        manager.stop();
      } else {
        void handleStart(next, nextPrefs.preferredRecognitionMode);
      }
    } else {
      // Idle: no recognition status will follow the switch on its own, so
      // broadcast once to keep open popups in sync with the new language.
      broadcastStatus(manager.getStatus());
    }
    return { ok: true, language: next };
  }

  function handleMessage(message: ExtensionMessage): Promise<unknown> {
    switch (message.type) {
      case 'START_RECOGNITION':
        return handleStart(message.language, message.preferredMode);
      case 'START_GEMINI_RECORDING':
        return handleStart(message.language, prefs.preferredRecognitionMode);
      case 'TRANSCRIBE_AUDIO_FILE': {
        const upload = audioUploadFromMessage(message);
        if (!upload) {
          return Promise.resolve({ ok: false, reason: 'file' } satisfies StartResponse);
        }
        // Same path as a live recording from here: the transcript is committed
        // to the captured field with the usual word-boundary spacing.
        return handleStart(message.language, prefs.preferredRecognitionMode, null, upload);
      }
      case 'STOP_RECOGNITION':
        manager.stop();
        return Promise.resolve({ ok: true });
      case 'CYCLE_LANGUAGE':
        return handleCycleLanguage();
      case 'GET_STATUS':
        return Promise.resolve({ ok: true, status: manager.getStatus() } satisfies StatusResponse);
      case 'SET_OPTIONS':
        return handleSetOptions(message);
      case 'GET_MODE_PREVIEW':
        return handleModePreview(message.language);
      case 'INSTALL_LANGUAGE_PACK':
        return handleInstall(message.language);
      default:
        return Promise.resolve({ ok: false });
    }
  }

  chrome.runtime.onMessage.addListener(
    (raw: unknown, _sender, sendResponse: (response: unknown) => void) => {
      handleMessage(raw as ExtensionMessage)
        .then(sendResponse)
        .catch(() => {
          sendResponse({ ok: false } satisfies StartResponse);
        });
      return true; // keep the channel open for the async response
    }
  );

  /**
   * In-page language-switch shortcut (recorded on the Settings page and
   * delivered via SET_OPTIONS). Complements the chrome.commands binding,
   * which users can only change at chrome://extensions/shortcuts. The combo
   * always includes Ctrl/Alt/⌘ (enforced by the recorder), so it is safe to
   * match even while a text field is focused — that is exactly when users
   * switch languages mid-dictation.
   */
  window.addEventListener(
    'keydown',
    (event) => {
      const spec = prefs.languageSwitchShortcut;
      if (!spec || event.repeat || event.defaultPrevented) return;
      if (!matchesShortcut(event, spec)) return;
      event.preventDefault();
      event.stopPropagation();
      void handleCycleLanguage();
    },
    true
  );

  void loadPrefs().then(applyPrefs);
}

if (!globalThis.__voiceTypeInjected) {
  globalThis.__voiceTypeInjected = true;
  main();
}