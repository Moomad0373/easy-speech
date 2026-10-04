/**
 * MV3 service worker. The popup talks to the content script directly via
 * chrome.tabs messaging (see shared/messaging.ts); this worker handles
 * extension-level concerns: lifecycle logging and the toggle-dictation
 * keyboard shortcut. Recognition itself never runs here — the Web Speech API
 * must live in the page that owns the text field.
 */
import {
  ensureContentScript,
  getActiveTab,
  requestStatus,
  sendToTab,
  type ExtensionMessage,
  type GeminiRuntimeMessage,
  type RecordingListResponse,
  type RecordingRetryResponse,
  type RecordingStoreAck,
  type RecordingStoreMessage,
} from '../shared/messaging';
import { isActiveState } from '../shared/state';
import { loadPrefs, sanitizeGeminiModel } from '../shared/storage';
import { transcriptionSettingsFrom } from '../shared/transcription';
import {
  clearGeminiApiKey,
  getGeminiStatus,
  saveGeminiApiKey,
  transcribeAudio,
  verifyGeminiApiKey,
} from './gemini';
import {
  abortSave,
  appendChunk,
  beginSave,
  clearRecordings,
  commitSave,
  deleteRecording,
  getRecording,
  listRecordings,
  markAttempt,
} from './recordingStore';

/**
 * Keyboard shortcuts (default Alt+Shift+V dictation, Alt+Shift+L language
 * cycle). Chrome provides no API to assign keys programmatically — users
 * customize them at chrome://extensions/shortcuts. Pressing a commands
 * shortcut counts as an activeTab invocation, so the on-demand
 * content-script injection below is permitted.
 */
chrome.commands.onCommand.addListener((command) => {
  if (command === 'toggle-dictation') {
    void toggleDictation();
    return;
  }
  if (command === 'cycle-language') {
    void cycleLanguage();
  }
});

async function toggleDictation(): Promise<void> {
  const tab = await getActiveTab();
  if (!tab?.id) return;
  try {
    await ensureContentScript(tab.id);
  } catch {
    return; // chrome://, Web Store, PDF viewer — the extension cannot run there
  }
  const status = await requestStatus(tab.id);
  if (!status) return;

  if (isActiveState(status.state)) {
    await sendToTab(tab.id, { type: 'STOP_RECOGNITION' } satisfies ExtensionMessage);
    return;
  }
  const prefs = await loadPrefs();
  if (prefs.dictationProvider === 'gemini') {
    await sendToTab(tab.id, {
      type: 'START_GEMINI_RECORDING',
      language: prefs.selectedLanguage,
      model: prefs.geminiModel,
    } satisfies ExtensionMessage);
    return;
  }
  await sendToTab(tab.id, {
    type: 'START_RECOGNITION',
    language: prefs.selectedLanguage,
    preferredMode: prefs.preferredRecognitionMode,
  } satisfies ExtensionMessage);
}

/**
 * Cycle between the bookmarked languages (spec §42). The content script is
 * the single source of cycle logic — it also serves the in-page shortcut, and
 * it persists the new selection and hot-restarts a live session. Advancing
 * here too would double-advance: this handler re-loads the preference the
 * worker has just saved and would rotate past the intended language. The
 * worker only checks that something is bookmarked and forwards the request;
 * the content script's status broadcast keeps popups in sync afterwards.
 */
async function cycleLanguage(): Promise<void> {
  const prefs = await loadPrefs();
  if (prefs.bookmarkedLanguages.length === 0) return;

  const tab = await getActiveTab();
  if (!tab?.id) return;
  try {
    await ensureContentScript(tab.id);
  } catch {
    return; // chrome://, Web Store, PDF viewer — nothing to notify
  }
  await sendToTab(tab.id, { type: 'CYCLE_LANGUAGE' } satisfies ExtensionMessage);
}

function isGeminiRuntimeMessage(value: unknown): value is GeminiRuntimeMessage {
  if (!value || typeof value !== 'object') return false;
  const type = (value as { type?: unknown }).type;
  return type === 'GET_GEMINI_STATUS' || type === 'SET_GEMINI_API_KEY' ||
    type === 'CLEAR_GEMINI_API_KEY' || type === 'TRANSCRIBE_AUDIO' ||
    type === 'VERIFY_GEMINI_API_KEY';
}

const RECORDING_STORE_TYPES: ReadonlySet<string> = new Set([
  'RECORDING_SAVE_BEGIN',
  'RECORDING_SAVE_CHUNK',
  'RECORDING_SAVE_COMMIT',
  'RECORDING_SAVE_ABORT',
  'RECORDING_DELETE',
  'RECORDING_LIST',
  'RECORDING_CLEAR',
  'RECORDING_RETRY',
]);

/**
 * Messages that read, erase-everything, or re-send what is stored. These are
 * restricted to the extension's own pages.
 *
 * The write path is deliberately NOT restricted: capturing audio happens in the
 * content script, because the microphone belongs to the page the user is typing
 * in. A content script has to be able to put its clip in the store and take it
 * out again, and it can do no harm doing so — it can only add audio it just
 * captured and delete by id, and it can never read back a clip, list the store,
 * or make the extension re-send anything. Anything that hands audio back out is
 * an extension page only, so a page cannot use this to read the store.
 */
const EXTENSION_PAGE_ONLY_TYPES: ReadonlySet<string> = new Set([
  'RECORDING_LIST',
  'RECORDING_CLEAR',
  'RECORDING_RETRY',
]);

function isRecordingStoreMessage(value: unknown): value is RecordingStoreMessage {
  if (!value || typeof value !== 'object') return false;
  const type = (value as { type?: unknown }).type;
  return typeof type === 'string' && RECORDING_STORE_TYPES.has(type);
}

function describeError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return 'The recording store is unavailable.';
}

/**
 * Only this extension's own pages (popup, options). Pinning the sender id —
 * not just the URL scheme — means another extension's pages are rejected even
 * though their URLs are also chrome-extension://, so a hypothetical future
 * external-message listener could never be mistaken for one of ours. Edge
 * reports extension-page origins as extension://, so both schemes count as
 * long as the id is ours.
 */
function isExtensionPageSender(sender: chrome.runtime.MessageSender): boolean {
  if (sender.tab || sender.id !== chrome.runtime.id) return false;
  if (!sender.url) return true;
  return (
    sender.url.startsWith(chrome.runtime.getURL('')) ||
    sender.url.startsWith(`extension://${chrome.runtime.id}/`)
  );
}

async function handleGeminiRuntimeMessage(
  message: GeminiRuntimeMessage,
  sender: chrome.runtime.MessageSender
): Promise<unknown> {
  if (message.type === 'GET_GEMINI_STATUS') {
    if (!isExtensionPageSender(sender) && !sender.tab?.id) {
      return { ok: false, configured: false, model: '' };
    }
    const prefs = await loadPrefs();
    return getGeminiStatus(prefs.geminiModel);
  }
  if (message.type === 'SET_GEMINI_API_KEY') {
    if (!isExtensionPageSender(sender)) return { ok: false, configured: false, model: '' };
    return saveGeminiApiKey(message.apiKey);
  }
  if (message.type === 'CLEAR_GEMINI_API_KEY') {
    if (!isExtensionPageSender(sender)) return { ok: false, configured: false, model: '' };
    return clearGeminiApiKey();
  }
  if (message.type === 'VERIFY_GEMINI_API_KEY') {
    // Checking a key is a settings-page action, and the candidate key travels
    // in the message, so no content script may ask for this.
    if (!isExtensionPageSender(sender)) {
      return { ok: false, error: 'api', message: 'Only the extension can check an API key.' };
    }
    return verifyGeminiApiKey(message.apiKey);
  }
  if (!sender.tab?.id) {
    return { ok: false, error: 'api', message: 'Transcription is only available from a page tab.' };
  }
  return transcribeAudio(message);
}

/**
 * The local recording store: clips captured but not yet transcribed.
 *
 * The content script may save and delete (it captures the audio); only the
 * extension's own pages may list, clear, or retry.
 *
 * Transcription (TRANSCRIBE_AUDIO) additionally requires a tab, because it has
 * to insert the result somewhere — but a stored clip is being re-sent from the
 * Settings page, where there is nowhere to insert, so the transcript comes back
 * as text for the user to copy. That is a deliberate difference: writing a
 * recovered transcript into whatever page happened to be focused would be a
 * nasty surprise.
 */
async function handleRecordingStoreMessage(
  message: RecordingStoreMessage,
  sender: chrome.runtime.MessageSender
): Promise<unknown> {
  if (EXTENSION_PAGE_ONLY_TYPES.has(message.type) && !isExtensionPageSender(sender)) {
    return {
      ok: false,
      error: 'The recording store is only available to the extension.',
    } satisfies RecordingStoreAck;
  }

  switch (message.type) {
    case 'RECORDING_SAVE_BEGIN':
      return { ok: beginSave(message.id) } satisfies RecordingStoreAck;
    case 'RECORDING_SAVE_CHUNK':
      return {
        ok: appendChunk(message.id, message.data, message),
      } satisfies RecordingStoreAck;
    case 'RECORDING_SAVE_COMMIT': {
      const stored = await commitSave(message.id);
      return stored
        ? { ok: true } satisfies RecordingStoreAck
        : { ok: false, error: 'The recording could not be stored.' } satisfies RecordingStoreAck;
    }
    case 'RECORDING_SAVE_ABORT':
      abortSave(message.id);
      return { ok: true } satisfies RecordingStoreAck;
    case 'RECORDING_DELETE':
      await deleteRecording(message.id);
      return { ok: true } satisfies RecordingStoreAck;
    case 'RECORDING_CLEAR':
      await clearRecordings();
      return { ok: true } satisfies RecordingStoreAck;
    case 'RECORDING_LIST':
      return { ok: true, recordings: await listRecordings() } satisfies RecordingListResponse;
    case 'RECORDING_RETRY':
      return retryStoredRecording(message.id);
  }
}

/**
 * Re-send a stored clip. The transcript is returned rather than inserted, and
 * the clip is deleted only once one has actually arrived — a retry that fails
 * leaves the audio exactly where it was, with the reason recorded against it.
 */
async function retryStoredRecording(id: string): Promise<RecordingRetryResponse> {
  const stored = await getRecording(id);
  if (!stored) {
    return { ok: false, error: 'api', message: 'That recording is no longer stored.' };
  }
  const prefs = await loadPrefs();
  const model = sanitizeGeminiModel(stored.model || prefs.geminiModel);
  const result = await transcribeAudio({
    data: stored.data,
    mimeType: stored.mimeType,
    transcription: transcriptionSettingsFrom(prefs),
    model,
  });
  if (result.ok && result.text) {
    await deleteRecording(id);
    return { ok: true, text: result.text };
  }
  const message = result.message ?? 'The recording could not be transcribed.';
  const updated = await markAttempt(id, message);
  return { ok: false, error: result.error, message, attempts: updated?.attempts };
}

if (chrome.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((raw: unknown, sender, sendResponse) => {
    if (isRecordingStoreMessage(raw)) {
      void handleRecordingStoreMessage(raw, sender)
        .then(sendResponse)
        .catch((error: unknown) => {
          sendResponse({ ok: false, error: describeError(error) } satisfies RecordingStoreAck);
        });
      return true;
    }
    if (!isGeminiRuntimeMessage(raw)) return undefined;
    void handleGeminiRuntimeMessage(raw, sender).then(sendResponse).catch(() => {
      sendResponse({ ok: false, error: 'api', message: 'The transcription request failed.' });
    });
    return true;
  });
}
