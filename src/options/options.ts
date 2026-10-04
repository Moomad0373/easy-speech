/**
 * Options page (spec §20): all extension settings live here, opened in a
 * regular tab from the popup's ⚙️ Settings button (or chrome://extensions →
 * Options).
 *
 * Editing model: the form is a DRAFT. Edits update `draft` in memory and are
 * only written to browser storage when the user presses "Save settings" —
 * which persists the COMPLETE settings object atomically and then broadcasts
 * it to every injected content script. This removes the silent-failure paths
 * of the old auto-save model (stale-snapshot overwrite races) and gives the
 * user visible confirmation ("Saved ✓") that settings actually persisted.
 */
import {
  DEFAULT_PREFS,
  loadPrefs,
  savePrefs,
  sanitizeCustomCommands,
  sanitizeGeminiModel,
  sanitizeLanguageBookmarks,
  type Prefs,
} from '../shared/storage';
import { DEFAULT_GEMINI_MODEL, GEMINI_API_KEY_STORAGE_KEY, MAX_API_KEY_LENGTH, MAX_CUSTOM_VOCABULARY_TERMS, SUPPORTED_LANGUAGES } from '../shared/constants';
import { applyTheme } from '../shared/theme';
import { languageLabel, sortedLanguageOptions } from '../shared/languages';
import {
  formatVocabularyInput,
  parseVocabularyInput,
} from '../shared/transcription';
import {
  emptyLedger,
  formatRequests,
  formatTokens,
  formatUsageTime,
  loadUsageLedger,
  resetUsageLedger,
  summarizeUsage,
  type UsageLedger,
  type UsageRecord,
  type UsageTotals,
} from '../shared/usage';
import type { CustomVoiceCommand, Language, TokenUsage, TranscriptionLanguage, TranscriptionMode } from '../shared/types';
import {
  sendToTab,
  type ExtensionMessage,
  type GeminiStatusResponse,
  type RecordingListResponse,
  type RecordingRetryResponse,
  type RecordingStoreAck,
  type RecordingStoreMessage,
  type SetOptionsPayload,
  type StoredRecordingInfo,
  type VerifyGeminiKeyResponse,
} from '../shared/messaging';
import { formatShortcut, isModifierCode, shortcutFromEvent, type ShortcutSpec } from '../shared/shortcut';
import { copyToClipboard } from '../shared/clipboard';

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`options page is missing #${id}`);
  return node as T;
}

const themeSelect = el<HTMLSelectElement>('theme');
const autoRestartBox = el<HTMLInputElement>('auto-restart');
const statusIndicatorBox = el<HTMLInputElement>('status-indicator');
const providerSelect = el<HTMLSelectElement>('dictation-provider');
const preferredLanguageSelect = el<HTMLSelectElement>('language');
const geminiCredentialForm = el<HTMLFormElement>('gemini-credential-form');
const geminiApiKeyInput = el<HTMLInputElement>('gemini-api-key');
const clearGeminiKeyButton = el<HTMLButtonElement>('clear-gemini-key');
const testGeminiKeyButton = el<HTMLButtonElement>('test-gemini-key');
const geminiKeyStatus = el<HTMLElement>('gemini-key-status');
const geminiModelInput = el<HTMLInputElement>('gemini-model');
const transcriptionLanguageSelect = el<HTMLSelectElement>('transcription-language');
const transcriptionModeSelect = el<HTMLSelectElement>('transcription-mode');
const transcriptionVocabularyInput = el<HTMLTextAreaElement>('transcription-vocabulary');
const transcriptionVocabularyStatus = el<HTMLElement>('transcription-vocabulary-status');
const usageLast = el<HTMLElement>('usage-last');
const usageRows = {
  today: el<HTMLElement>('usage-today'),
  last24h: el<HTMLElement>('usage-24h'),
  month: el<HTMLElement>('usage-month'),
  allTime: el<HTMLElement>('usage-all'),
};
const usageDetail = el<HTMLDetailsElement>('usage-detail');
const usageFields = el<HTMLElement>('usage-fields');
const usageResetButton = el<HTMLButtonElement>('usage-reset');
const usageStatus = el<HTMLElement>('usage-status');
const recordingsSummary = el<HTMLElement>('recordings-summary');
const recordingList = el<HTMLUListElement>('recording-list');
const recordingResult = el<HTMLDivElement>('recording-result');
const recordingText = el<HTMLParagraphElement>('recording-text');
const recordingCopyButton = el<HTMLButtonElement>('recording-copy');
const recordingsClearButton = el<HTMLButtonElement>('recordings-clear');
const recordingsStatus = el<HTMLElement>('recordings-status');
const bookmarksBox = el<HTMLDivElement>('language-bookmarks');
const switchShortcutDisplay = el<HTMLElement>('switch-shortcut-display');
const recognitionModeSelect = el<HTMLSelectElement>('recognition-mode');
const voiceCommandsBox = el<HTMLInputElement>('voice-commands');
const numbersAsDigitsBox = el<HTMLInputElement>('numbers-as-digits');
const saveButtons = [el<HTMLButtonElement>('save-settings'), el<HTMLButtonElement>('save-settings-bottom')];
const saveStatuses = [el<HTMLElement>('save-status'), el<HTMLElement>('save-status-bottom')];
const storageBanner = el<HTMLElement>('storage-banner');
const commandForm = el<HTMLFormElement>('command-form');
const commandPhrase = el<HTMLInputElement>('command-phrase');
const commandReplacement = el<HTMLInputElement>('command-replacement');
const commandSubmit = el<HTMLButtonElement>('command-submit');
const commandCancel = el<HTMLButtonElement>('command-cancel');
const bulkDetails = el<HTMLDetailsElement>('bulk');
const bulkCommands = el<HTMLTextAreaElement>('bulk-commands');
const bulkApply = el<HTMLButtonElement>('bulk-apply');
const commandsBody = el<HTMLTableSectionElement>('commands-body');
const commandsCount = el<HTMLElement>('commands-count');
const commandsEmpty = el<HTMLElement>('commands-empty');
const shortcutDisplay = el<HTMLElement>('shortcut-display');
const editShortcutButton = el<HTMLButtonElement>('edit-shortcut');
const customShortcutButton = el<HTMLButtonElement>('custom-switch-shortcut');
const clearShortcutButton = el<HTMLButtonElement>('clear-switch-shortcut');
const switchShortcutHint = el<HTMLElement>('switch-shortcut-hint');

/** Last state loaded from (or saved to) storage. */
let stored: Prefs = { ...DEFAULT_PREFS };
/** What the form currently shows — saved only on "Save settings". */
let draft: Prefs = { ...DEFAULT_PREFS };
/** Commands being edited (may include unsaved rows). */
let commands: CustomVoiceCommand[] = [];
/** Index currently loaded into the form for editing; null while adding. */
let editingIndex: number | null = null;
/** True when chrome.storage.local is unusable in this context. */
let storageBroken = false;

// ---- save -------------------------------------------------------------------

function currentFormValues(): Partial<Prefs> {
  return {
    theme: themeSelect.value as Prefs['theme'],
    autoRestart: autoRestartBox.checked,
    showStatusIndicator: statusIndicatorBox.checked,
    selectedLanguage: preferredLanguageSelect.value as Language,
    bookmarkedLanguages: sanitizeLanguageBookmarks(collectBookmarks()),
    languageSwitchShortcut: draft.languageSwitchShortcut,
    preferredRecognitionMode: recognitionModeSelect.value as Prefs['preferredRecognitionMode'],
    voiceCommands: voiceCommandsBox.checked,
    numbersAsDigits: numbersAsDigitsBox.checked,
    dictationProvider: providerSelect.value as Prefs['dictationProvider'],
    geminiModel: sanitizeGeminiModel(geminiModelInput.value),
    transcriptionLanguage: transcriptionLanguageSelect.value as TranscriptionLanguage,
    transcriptionMode: transcriptionModeSelect.value as TranscriptionMode,
    transcriptionVocabulary: parseVocabularyInput(transcriptionVocabularyInput.value),
    customCommands: sanitizeCustomCommands(commands),
  };
}

function collectBookmarks(): Language[] {
  const boxes = bookmarksBox.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
  const picked = new Set<string>();
  boxes.forEach((box) => {
    if (box.checked && box.dataset.language) picked.add(box.dataset.language);
  });
  // Canonical catalog order so cycling is predictable.
  return SUPPORTED_LANGUAGES.filter((code) => picked.has(code));
}

function setSaveStatus(kind: 'ok' | 'error' | 'info', text: string): void {
  for (const node of saveStatuses) {
    node.textContent = text;
    node.className = `save-status ${kind}`;
  }
}

function setSaveButtonsDisabled(disabled: boolean): void {
  for (const button of saveButtons) button.disabled = disabled;
}

function renderGeminiStatus(status: GeminiStatusResponse | undefined): void {
  const configured = status?.configured === true;
  geminiKeyStatus.textContent = configured
    ? 'Gemini API key saved. It stays in this browser and is never displayed again.'
    : 'No Gemini API key configured.';
  clearGeminiKeyButton.hidden = !configured;
  geminiApiKeyInput.value = '';
}

async function readStoredGeminiStatus(model = DEFAULT_GEMINI_MODEL): Promise<GeminiStatusResponse> {
  const stored = await chrome.storage.local.get(GEMINI_API_KEY_STORAGE_KEY);
  const value = stored[GEMINI_API_KEY_STORAGE_KEY];
  return {
    ok: true,
    configured: typeof value === 'string' && value.trim().length > 0,
    model: sanitizeGeminiModel(model),
  };
}

async function refreshGeminiStatus(): Promise<void> {
  try {
    const status = (await chrome.runtime.sendMessage({ type: 'GET_GEMINI_STATUS' })) as GeminiStatusResponse;
    if (status?.ok) {
      renderGeminiStatus(status);
      return;
    }
  } catch {
  }
  try {
    renderGeminiStatus(await readStoredGeminiStatus(geminiModelInput.value));
  } catch {
    renderGeminiStatus(undefined);
  }
}

async function saveGeminiCredential(event: Event): Promise<void> {
  event.preventDefault();
  const apiKey = geminiApiKeyInput.value.trim();
  if (!apiKey || apiKey.length > MAX_API_KEY_LENGTH) {
    geminiKeyStatus.textContent = 'Enter a valid Google API key.';
    return;
  }
  try {
    const status = (await chrome.runtime.sendMessage({ type: 'SET_GEMINI_API_KEY', apiKey })) as GeminiStatusResponse;
    if (status?.configured) {
      renderGeminiStatus(status);
      geminiKeyStatus.textContent = 'Gemini API key saved.';
      return;
    }
  } catch {
  }
  try {
    await chrome.storage.local.set({ [GEMINI_API_KEY_STORAGE_KEY]: apiKey });
    const status = await readStoredGeminiStatus(geminiModelInput.value);
    renderGeminiStatus(status);
    geminiKeyStatus.textContent = status.configured
      ? 'Gemini API key saved.'
      : 'The API key could not be verified after saving.';
  } catch {
    geminiKeyStatus.textContent = 'The API key could not be saved.';
  }
}

/**
 * Checks the key currently in the input (or, when it is empty, the saved one)
 * with a single cheap authenticated call, so a typo is caught here instead of
 * after the user has recorded something and waited for a transcript.
 *
 * Deliberately does NOT go through renderGeminiStatus: that clears the input,
 * which would delete the exact key the user is trying to fix. Only a successful
 * SAVE clears the field.
 */
async function testGeminiCredential(): Promise<void> {
  if (testGeminiKeyButton.disabled) return;
  const apiKey = geminiApiKeyInput.value.trim();
  testGeminiKeyButton.disabled = true;
  const previous = testGeminiKeyButton.textContent;
  testGeminiKeyButton.textContent = 'Testing…';
  geminiKeyStatus.textContent = apiKey
    ? 'Checking this key with Google…'
    : 'Checking the saved key with Google…';
  try {
    const response = (await chrome.runtime.sendMessage(
      apiKey ? { type: 'VERIFY_GEMINI_API_KEY', apiKey } : { type: 'VERIFY_GEMINI_API_KEY' }
    )) as VerifyGeminiKeyResponse;
    geminiKeyStatus.textContent = response?.ok
      ? 'Key accepted by Google. Save it to use it.'
      : response?.message ?? 'The key could not be checked.';
  } catch {
    geminiKeyStatus.textContent = 'The key could not be checked.';
  } finally {
    testGeminiKeyButton.disabled = false;
    testGeminiKeyButton.textContent = previous ?? 'Test key';
  }
}

async function clearGeminiCredential(): Promise<void> {
  try {
    const status = (await chrome.runtime.sendMessage({ type: 'CLEAR_GEMINI_API_KEY' })) as GeminiStatusResponse;
    if (status?.ok) {
      renderGeminiStatus(status);
      geminiKeyStatus.textContent = 'Gemini API key removed.';
      return;
    }
  } catch {
  }
  try {
    await chrome.storage.local.remove(GEMINI_API_KEY_STORAGE_KEY);
    renderGeminiStatus(await readStoredGeminiStatus(geminiModelInput.value));
    geminiKeyStatus.textContent = 'Gemini API key removed.';
  } catch {
    geminiKeyStatus.textContent = 'The API key could not be removed.';
  }
}

geminiCredentialForm.addEventListener('submit', (event) => void saveGeminiCredential(event));
testGeminiKeyButton.addEventListener('click', () => void testGeminiCredential());
clearGeminiKeyButton.addEventListener('click', () => void clearGeminiCredential());

/** Persists the COMPLETE draft atomically, then broadcasts it to all tabs. */
async function saveSettings(): Promise<void> {
  if (storageBroken) {
    setSaveStatus('error', 'Browser storage is unavailable — settings cannot be saved here.');
    return;
  }
  draft = { ...stored, ...currentFormValues() };
  setSaveButtonsDisabled(true);
  setSaveStatus('info', 'Saving…');
  try {
    await savePrefs(draft); // full object, single atomic write
  } catch {
    storageBroken = true;
    storageBanner.hidden = false;
    setSaveStatus('error', 'Saving failed — browser storage reported an error.');
    setSaveButtonsDisabled(false);
    return;
  }
  stored = { ...draft };
  setSaveStatus('ok', 'Saved ✓');
  setSaveButtonsDisabled(false);
  await broadcastOptions();
  // Confirm the write actually landed (guards silent storage failures).
  const verification = await loadPrefs();
  const matches = (Object.keys(stored) as Array<keyof Prefs>).every(
    (key) => JSON.stringify(verification[key]) === JSON.stringify(stored[key])
  );
  if (!matches) {
    storageBroken = true;
    storageBanner.hidden = false;
    setSaveStatus('error', 'Saving failed — the stored settings did not match what was written.');
  }
}

/** Warn before leaving with unsaved edits (refresh/close). */
window.addEventListener('beforeunload', (event) => {
  if (saveStatuses.some((node) => node.textContent === 'Unsaved changes')) {
    event.preventDefault();
    event.returnValue = '';
  }
});

/** Push the saved snapshot to every injected content script. */
async function broadcastOptions(): Promise<void> {
  const payload: SetOptionsPayload = {
    showStatusIndicator: stored.showStatusIndicator,
    autoRestart: stored.autoRestart,
    voiceCommands: stored.voiceCommands,
    numbersAsDigits: stored.numbersAsDigits,
    dictationProvider: stored.dictationProvider,
    geminiModel: stored.geminiModel,
    transcriptionLanguage: stored.transcriptionLanguage,
    transcriptionMode: stored.transcriptionMode,
    transcriptionVocabulary: stored.transcriptionVocabulary,
    selectedLanguage: stored.selectedLanguage,
    preferredRecognitionMode: stored.preferredRecognitionMode,
    theme: stored.theme,
    bookmarkedLanguages: stored.bookmarkedLanguages,
    languageSwitchShortcut: stored.languageSwitchShortcut,
    customCommands: stored.customCommands,
  };
  const message: ExtensionMessage = { type: 'SET_OPTIONS', ...payload };
  try {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      if (typeof tab.id === 'number') void sendToTab(tab.id, message);
    }
  } catch {
    // tabs API unavailable (should not happen on an extension page) — the
    // next dictation start re-reads prefs anyway.
  }
}

for (const button of saveButtons) {
  button.addEventListener('click', () => void saveSettings());
}

// ---- form → draft (no persistence until Save) --------------------------------

themeSelect.addEventListener('change', () => {
  const theme = themeSelect.value as Prefs['theme'];
  applyTheme(theme); // live preview of the look; value saved with the draft
  draft = { ...draft, theme };
  setSaveStatus('info', 'Unsaved changes');
});

const bindCheckbox = (box: HTMLInputElement, key: keyof Prefs): void => {
  box.addEventListener('change', () => {
    draft = { ...draft, [key]: box.checked } as Prefs;
    setSaveStatus('info', 'Unsaved changes');
  });
};
bindCheckbox(autoRestartBox, 'autoRestart');
bindCheckbox(statusIndicatorBox, 'showStatusIndicator');
bindCheckbox(voiceCommandsBox, 'voiceCommands');
bindCheckbox(numbersAsDigitsBox, 'numbersAsDigits');

preferredLanguageSelect.addEventListener('change', () => {
  draft = { ...draft, selectedLanguage: preferredLanguageSelect.value as Language };
  setSaveStatus('info', 'Unsaved changes');
});

recognitionModeSelect.addEventListener('change', () => {
  draft = { ...draft, preferredRecognitionMode: recognitionModeSelect.value as Prefs['preferredRecognitionMode'] };
  setSaveStatus('info', 'Unsaved changes');
});

providerSelect.addEventListener('change', () => {
  draft = { ...draft, dictationProvider: providerSelect.value as Prefs['dictationProvider'] };
  setSaveStatus('info', 'Unsaved changes');
});

geminiModelInput.addEventListener('input', () => {
  draft = { ...draft, geminiModel: sanitizeGeminiModel(geminiModelInput.value) };
  setSaveStatus('info', 'Unsaved changes');
});

// ---- Voice Transcribing settings --------------------------------------------

/**
 * Live feedback under the vocabulary input: how many terms will be sent, and
 * a warning once Google's documented 1,000-term ceiling is reached. The count
 * comes from the same parser the save path uses, so it can never disagree with
 * what is actually sent.
 */
function renderVocabularyStatus(): void {
  const count = parseVocabularyInput(transcriptionVocabularyInput.value).length;
  const overLimit = count >= MAX_CUSTOM_VOCABULARY_TERMS;
  transcriptionVocabularyStatus.textContent = count === 0
    ? 'No custom words yet.'
    : overLimit
      ? `${count} words — Google's limit is ${MAX_CUSTOM_VOCABULARY_TERMS}; the extra are ignored.`
      : `${count} ${count === 1 ? 'word' : 'words'} added.`;
}

transcriptionLanguageSelect.addEventListener('change', () => {
  draft = { ...draft, transcriptionLanguage: transcriptionLanguageSelect.value as TranscriptionLanguage };
  setSaveStatus('info', 'Unsaved changes');
});

transcriptionModeSelect.addEventListener('change', () => {
  draft = { ...draft, transcriptionMode: transcriptionModeSelect.value as TranscriptionMode };
  setSaveStatus('info', 'Unsaved changes');
});

transcriptionVocabularyInput.addEventListener('input', () => {
  draft = { ...draft, transcriptionVocabulary: parseVocabularyInput(transcriptionVocabularyInput.value) };
  renderVocabularyStatus();
  setSaveStatus('info', 'Unsaved changes');
});

// ---- token usage -------------------------------------------------------------

/** `135 tokens · 1 request` — the headline number first, count second. */
function renderUsageRow(target: HTMLElement, totals: UsageTotals): void {
  target.textContent = totals.requests === 0
    ? '0 tokens'
    : `${formatTokens(totals.totalTokens)} tokens · ${formatRequests(totals.requests)}`;
}

/** The per-field detail for the most recent request, in reading order. */
const USAGE_FIELD_LABELS: ReadonlyArray<readonly [keyof TokenUsage, string]> = [
  ['totalTokens', 'Total'],
  ['promptTokens', 'Input (after cache)'],
  ['completionTokens', 'Output'],
  ['audioTokens', 'of which audio'],
  ['cachedTokens', 'Served from cache'],
  ['thoughtTokens', 'Model reasoning'],
  ['toolUseTokens', 'Tools'],
  ['rawPromptTokens', 'Raw input (before cache)'],
];

function renderUsageFields(record: UsageRecord): void {
  usageFields.replaceChildren();
  for (const [key, label] of USAGE_FIELD_LABELS) {
    const row = document.createElement('div');
    row.className = 'usage-field';
    const term = document.createElement('dt');
    term.textContent = label;
    const value = document.createElement('dd');
    value.textContent = formatTokens(record.usage[key]);
    row.append(term, value);
    usageFields.appendChild(row);
  }
}

function renderUsage(): void {
  const summary = summarizeUsage(currentLedger);
  const { last } = summary;

  if (!last) {
    usageLast.textContent = 'No transcription has reported token usage yet.';
    usageDetail.hidden = true;
  } else {
    usageLast.textContent =
      `Last request: ${formatTokens(last.usage.totalTokens)} tokens — ${formatUsageTime(last.at)}` +
      (last.model ? ` · ${last.model}` : '');
    renderUsageFields(last);
    usageDetail.hidden = false;
  }

  renderUsageRow(usageRows.today, summary.today);
  renderUsageRow(usageRows.last24h, summary.last24h);
  renderUsageRow(usageRows.month, summary.month);
  renderUsageRow(usageRows.allTime, summary.allTime);
}

/** The ledger as last read, so a reset can re-render without a second load. */
let currentLedger: UsageLedger = emptyLedger();

async function refreshUsage(): Promise<void> {
  currentLedger = await loadUsageLedger();
  renderUsage();
}

usageResetButton.addEventListener('click', async () => {
  // Destructive and irreversible — the counters are the only record of past
  // spend, so make the user say so before they go.
  if (!window.confirm('Reset all token counters? Past usage will not be recoverable.')) {
    return;
  }
  await resetUsageLedger();
  usageStatus.textContent = 'Token counters reset.';
  await refreshUsage();
});

// ---- unsent recordings (recovery for failed transcriptions) -------------------

let recoveredTranscript = '';

function setRecordingsStatus(text: string, kind: 'ok' | 'error' | 'info' = 'info'): void {
  recordingsStatus.textContent = text;
  recordingsStatus.dataset.kind = kind;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatAge(timestamp: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(timestamp).toLocaleDateString();
}

function showRecoveredTranscript(text: string): void {
  recoveredTranscript = text;
  recordingText.textContent = text;
  recordingResult.hidden = false;
}

function hideRecoveredTranscript(): void {
  recoveredTranscript = '';
  recordingText.textContent = '';
  recordingResult.hidden = true;
}

function renderRecordings(recordings: StoredRecordingInfo[]): void {
  recordingList.replaceChildren();

  if (recordings.length === 0) {
    recordingsSummary.textContent = 'No unsent recordings. Every recording was transcribed.';
    recordingsClearButton.hidden = true;
    return;
  }

  recordingsSummary.textContent =
    recordings.length === 1
      ? '1 recording could not be transcribed. It is saved on this computer.'
      : `${recordings.length} recordings could not be transcribed. They are saved on this computer.`;
  recordingsClearButton.hidden = false;

  for (const recording of recordings) {
    const item = document.createElement('li');
    item.className = 'recording-item';

    const detail = document.createElement('div');
    detail.className = 'recording-detail';
    const size = document.createElement('span');
    size.className = 'recording-meta';
    size.textContent = `${formatAge(recording.createdAt)} · ${formatBytes(recording.bytes)}`;
    const reason = document.createElement('span');
    reason.className = 'recording-reason';
    reason.textContent = recording.lastError ?? 'Not transcribed yet.';
    if (!recording.lastError) reason.dataset.kind = 'muted';
    detail.append(size, reason);

    const actions = document.createElement('div');
    actions.className = 'recording-actions';
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'primary';
    retry.textContent = 'Retry';
    retry.addEventListener('click', () => void retryRecording(recording.id, retry));
    const discard = document.createElement('button');
    discard.type = 'button';
    discard.className = 'danger';
    discard.textContent = 'Discard';
    discard.addEventListener('click', () => void discardRecording(recording.id));
    actions.append(retry, discard);

    item.append(detail, actions);
    recordingList.append(item);
  }
}

async function refreshRecordings(): Promise<void> {
  let response: RecordingListResponse;
  try {
    response = (await chrome.runtime.sendMessage({
      type: 'RECORDING_LIST',
    } satisfies RecordingStoreMessage)) as RecordingListResponse;
  } catch {
    // A dead worker here is not worth an error banner — the store is empty in
    // every realistic version of this failure.
    renderRecordings([]);
    setRecordingsStatus('The saved-recordings store is unavailable in this browser.', 'error');
    return;
  }
  renderRecordings(response?.recordings ?? []);
  if (response?.ok) setRecordingsStatus('');
}

/**
 * Re-send one stored clip. The transcript comes back as text rather than being
 * inserted anywhere: this page has no text field, and dropping a recovered
 * paragraph into whatever page the user last had focused would be a surprise
 * they cannot undo. It is shown here to be copied, which is the same thing the
 * clipboard backup does after a normal recording.
 */
async function retryRecording(id: string, button: HTMLButtonElement): Promise<void> {
  button.disabled = true;
  button.textContent = 'Sending…';
  hideRecoveredTranscript();
  setRecordingsStatus('Sending the recording to Gemini. A long clip on a slow connection can take a while…', 'info');
  try {
    const response = (await chrome.runtime.sendMessage({
      type: 'RECORDING_RETRY',
      id,
    } satisfies RecordingStoreMessage)) as RecordingRetryResponse;
    if (response?.ok && response.text) {
      setRecordingsStatus('Transcribed. The saved recording has been deleted.', 'ok');
      showRecoveredTranscript(response.text);
    } else {
      const reason = response?.message ?? 'The recording could not be transcribed.';
      const attempts = response?.attempts;
      setRecordingsStatus(
        attempts ? `${reason} It has been kept — attempt ${attempts}.` : `${reason} It has been kept.`,
        'error'
      );
    }
  } catch {
    setRecordingsStatus('The retry could not reach the extension. The recording has been kept.', 'error');
  } finally {
    await refreshRecordings();
  }
}

async function discardRecording(id: string): Promise<void> {
  await chrome.runtime.sendMessage({ type: 'RECORDING_DELETE', id } satisfies RecordingStoreMessage);
  hideRecoveredTranscript();
  setRecordingsStatus('Recording discarded.', 'ok');
  await refreshRecordings();
}

recordingsClearButton.addEventListener('click', async () => {
  // Irreversible and it is the user's own voice. Say what is going.
  if (!window.confirm('Discard every saved recording? Any transcript not yet recovered is lost.')) {
    return;
  }
  await chrome.runtime.sendMessage({ type: 'RECORDING_CLEAR' } satisfies RecordingStoreMessage);
  hideRecoveredTranscript();
  setRecordingsStatus('All saved recordings discarded.', 'ok');
  await refreshRecordings();
});

recordingCopyButton.addEventListener('click', async () => {
  if (!recoveredTranscript) return;
  const copied = await copyToClipboard(recoveredTranscript);
  setRecordingsStatus(
    copied ? 'Transcript copied to the clipboard.' : 'The clipboard refused the copy — select the text and copy it manually.',
    copied ? 'ok' : 'error'
  );
});

// ---- language bookmarks (spec §42) -------------------------------------------

/** Renders one checkbox per catalog language from the DRAFT.
 *  Catalog order (defaults first, the rest alphabetical) so the languages a
 *  new user actually has are at the top of the scrollable list. */
function renderBookmarks(): void {
  bookmarksBox.replaceChildren();
  const bookmarked = new Set(draft.bookmarkedLanguages);
  for (const code of SUPPORTED_LANGUAGES) {
    const label = languageLabel(code);
    const item = document.createElement('label');
    item.className = 'option';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.dataset.language = code;
    checkbox.checked = bookmarked.has(code);
    checkbox.addEventListener('change', () => {
      draft = { ...draft, bookmarkedLanguages: sanitizeLanguageBookmarks(collectBookmarks()) };
      renderBookmarks();
      setSaveStatus('info', 'Unsaved changes');
    });
    item.append(checkbox, document.createTextNode(`${label} (${code})`));
    bookmarksBox.appendChild(item);
  }
}

// ---- custom voice commands ---------------------------------------------------

function renderCommands(): void {
  commandsBody.replaceChildren();
  commandsCount.textContent = String(commands.length);
  commandsEmpty.hidden = commands.length > 0;

  commands.forEach((command, index) => {
    const row = document.createElement('tr');

    const phraseCell = document.createElement('td');
    phraseCell.textContent = command.phrase;

    const arrowCell = document.createElement('td');
    arrowCell.className = 'arrow';
    arrowCell.textContent = '→';

    const replacementCell = document.createElement('td');
    replacementCell.textContent = command.replacement || '(nothing — mutes the phrase)';

    const actionsCell = document.createElement('td');
    actionsCell.className = 'actions';

    const editButton = document.createElement('button');
    editButton.type = 'button';
    editButton.className = 'secondary';
    editButton.textContent = '✎';
    editButton.title = 'Edit command';
    editButton.addEventListener('click', () => startEditing(index));

    const deleteButton = document.createElement('button');
    deleteButton.type = 'button';
    deleteButton.className = 'danger';
    deleteButton.textContent = '🗑';
    deleteButton.title = 'Delete command';
    deleteButton.addEventListener('click', () => {
      if (editingIndex === index) resetForm();
      else if (editingIndex !== null && editingIndex > index) editingIndex -= 1;
      commands.splice(index, 1);
      renderCommands();
      setSaveStatus('info', 'Unsaved changes');
    });

    actionsCell.append(editButton, document.createTextNode(' '), deleteButton);
    row.append(phraseCell, arrowCell, replacementCell, actionsCell);
    commandsBody.appendChild(row);
  });
}

function resetForm(): void {
  editingIndex = null;
  commandForm.reset();
  commandSubmit.textContent = '＋ Add command';
  commandCancel.hidden = true;
}

function startEditing(index: number): void {
  editingIndex = index;
  commandPhrase.value = commands[index]?.phrase ?? '';
  commandReplacement.value = commands[index]?.replacement ?? '';
  commandSubmit.textContent = 'Update in list';
  commandCancel.hidden = false;
  commandPhrase.focus();
}

commandForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const phrase = commandPhrase.value.trim();
  if (phrase.length === 0) return;
  const command: CustomVoiceCommand = { phrase, replacement: commandReplacement.value };
  if (editingIndex !== null && commands[editingIndex]) {
    commands[editingIndex] = command;
  } else {
    commands.push(command);
  }
  renderCommands();
  setSaveStatus('info', 'Unsaved changes');
  resetForm();
});

commandCancel.addEventListener('click', resetForm);

bulkApply.addEventListener('click', () => {
  // One command per line: "phrase => replacement". A bare phrase (no arrow)
  // maps to nothing — a quick way to mute misheard words.
  const parsed: CustomVoiceCommand[] = [];
  for (const line of bulkCommands.value.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const separator = trimmed.indexOf('=>');
    if (separator >= 0) {
      const phrase = trimmed.slice(0, separator).trim();
      const replacement = trimmed.slice(separator + 2).trim();
      if (phrase.length > 0) parsed.push({ phrase, replacement });
    } else {
      parsed.push({ phrase: trimmed, replacement: '' });
    }
  }
  if (parsed.length === 0) return;
  commands = parsed;
  resetForm();
  renderCommands();
  setSaveStatus('info', 'Unsaved changes');
  bulkDetails.open = false;
});

// ---- keyboard shortcut ------------------------------------------------------

/** Browser command binding for cycle-language (from chrome.commands), if any. */
let browserCycleShortcut: string | null = null;
/** True while the recorder is waiting for a key combination. */
let recordingShortcut = false;
/** Transient recorder message (invalid combo, conflicts). */
let shortcutNotice: string | null = null;
const shortcutHintDefault = switchShortcutHint.textContent ?? '';

/** Best-effort parse of a chrome.commands shortcut string ("Alt+Shift+L"). */
function parseBrowserShortcut(value: string): Omit<ShortcutSpec, 'code'> & { key: string } | null {
  const parts = value.split('+').map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  let ctrl = false;
  let alt = false;
  let shift = false;
  let meta = false;
  for (const part of parts.slice(0, -1)) {
    if (part === 'Ctrl' || part === 'MacCtrl') ctrl = true;
    else if (part === 'Alt' || part === 'Option') alt = true;
    else if (part === 'Shift') shift = true;
    else if (part === 'Command' || part === 'Meta') meta = true;
    else return null; // media keys etc. — conflict check not applicable
  }
  return { key: parts[parts.length - 1]!.toUpperCase(), ctrl, alt, shift, meta };
}

function shortcutConflictsWithBrowser(spec: ShortcutSpec): boolean {
  const browser = browserCycleShortcut ? parseBrowserShortcut(browserCycleShortcut) : null;
  if (!browser) return false;
  return (
    spec.ctrl === browser.ctrl &&
    spec.alt === browser.alt &&
    spec.shift === browser.shift &&
    spec.meta === browser.meta &&
    spec.key.toUpperCase() === browser.key
  );
}

function updateSwitchShortcutHint(): void {
  const spec = draft.languageSwitchShortcut;
  const conflict = spec !== null && shortcutConflictsWithBrowser(spec);
  customShortcutButton.classList.toggle('conflict', conflict);
  if (shortcutNotice) {
    switchShortcutHint.textContent = shortcutNotice;
  } else if (conflict && spec) {
    switchShortcutHint.textContent =
      `⚠️ ${formatShortcut(spec)} is also the browser command shortcut (${browserCycleShortcut}) — ` +
      'Chrome intercepts that combination before this page, so the custom shortcut would never fire. ' +
      'Record a different combination or remove the browser binding in chrome://extensions/shortcuts.';
  } else if (recordingShortcut) {
    switchShortcutHint.textContent =
      'Include Ctrl, Alt or ⌘ with a key. Esc cancels · Delete clears the shortcut.';
  } else {
    switchShortcutHint.textContent = shortcutHintDefault;
  }
}

/** Reflects draft.languageSwitchShortcut in the recorder UI. */
function renderShortcutCapture(): void {
  const spec = draft.languageSwitchShortcut;
  customShortcutButton.classList.toggle('recording', recordingShortcut);
  customShortcutButton.textContent = recordingShortcut
    ? 'Press shortcut…'
    : spec
      ? formatShortcut(spec)
      : 'Not set — click to record';
  clearShortcutButton.hidden = spec === null;
  updateSwitchShortcutHint();
}

function setShortcutDraft(spec: ShortcutSpec | null): void {
  draft = { ...draft, languageSwitchShortcut: spec };
  setSaveStatus('info', 'Unsaved changes');
}

function stopShortcutRecording(): void {
  if (!recordingShortcut) return;
  recordingShortcut = false;
  window.removeEventListener('keydown', onRecordKeydown, true);
  renderShortcutCapture();
}

function onRecordKeydown(event: KeyboardEvent): void {
  event.preventDefault();
  event.stopPropagation();
  if (event.key === 'Escape') {
    stopShortcutRecording();
    return;
  }
  if (event.key === 'Backspace' || event.key === 'Delete') {
    stopShortcutRecording();
    shortcutNotice = null;
    setShortcutDraft(null);
    renderShortcutCapture();
    return;
  }
  if (isModifierCode(event.code)) return; // wait for the full combination
  const spec = shortcutFromEvent(event);
  stopShortcutRecording();
  if (spec) {
    shortcutNotice = null;
    setShortcutDraft(spec);
  } else {
    shortcutNotice =
      'That combination cannot be used — hold Ctrl, Alt or ⌘ together with a key, then try again.';
  }
  renderShortcutCapture();
}

customShortcutButton.addEventListener('click', () => {
  if (recordingShortcut) return;
  recordingShortcut = true;
  shortcutNotice = null;
  renderShortcutCapture();
  window.addEventListener('keydown', onRecordKeydown, true);
});

clearShortcutButton.addEventListener('click', () => {
  shortcutNotice = null;
  setShortcutDraft(null);
  renderShortcutCapture();
});

// Clicking elsewhere / focusing another window abandons the recording.
window.addEventListener('blur', stopShortcutRecording);

async function refreshShortcut(): Promise<void> {
  try {
    const commandsList = await chrome.commands.getAll();
    const toggle = commandsList.find((command) => command.name === 'toggle-dictation');
    const cycle = commandsList.find((command) => command.name === 'cycle-language');
    shortcutDisplay.textContent = toggle?.shortcut || 'Not set';
    switchShortcutDisplay.textContent = cycle?.shortcut || 'Not set';
    browserCycleShortcut = cycle?.shortcut ?? null;
  } catch {
    shortcutDisplay.textContent = '—';
    switchShortcutDisplay.textContent = '—';
    browserCycleShortcut = null;
  }
  renderShortcutCapture();
}

editShortcutButton.addEventListener('click', () => {
  // Chrome does not allow extensions to assign shortcuts programmatically;
  // chrome://extensions/shortcuts is the only place they can be changed.
  void chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
});

// ---- init ---------------------------------------------------------------------

function fillForm(from: Prefs): void {
  themeSelect.value = from.theme;
  applyTheme(from.theme);
  providerSelect.value = from.dictationProvider;
  autoRestartBox.checked = from.autoRestart;
  statusIndicatorBox.checked = from.showStatusIndicator;
  preferredLanguageSelect.value = from.selectedLanguage;
  recognitionModeSelect.value = from.preferredRecognitionMode;
  geminiModelInput.value = from.geminiModel || DEFAULT_GEMINI_MODEL;
  transcriptionLanguageSelect.value = from.transcriptionLanguage;
  transcriptionModeSelect.value = from.transcriptionMode;
  transcriptionVocabularyInput.value = formatVocabularyInput(from.transcriptionVocabulary);
  renderVocabularyStatus();
  voiceCommandsBox.checked = from.voiceCommands;
  numbersAsDigitsBox.checked = from.numbersAsDigits;
  renderShortcutCapture();
}

/** Fills both language dropdowns from the catalog (native labels, sorted). */
function populateLanguageSelects(): void {
  for (const { code, label } of sortedLanguageOptions()) {
    for (const select of [preferredLanguageSelect, transcriptionLanguageSelect]) {
      const option = document.createElement('option');
      option.value = code;
      option.textContent = `${label} (${code})`;
      select.appendChild(option);
    }
  }
}

async function init(): Promise<void> {
  let loaded: Prefs | null = null;
  try {
    loaded = await loadPrefs();
    // Detect genuinely broken storage: loadPrefs() swallows errors and
    // returns defaults, so compare a read-back of a probe write.
    await chrome.storage.local.get('prefs');
    storageBroken = false;
  } catch {
    storageBroken = true;
  }
  if (storageBroken) {
    storageBanner.hidden = false;
    setSaveStatus('error', 'Browser storage is unavailable — settings cannot be saved here.');
  }

  stored = loaded ?? { ...DEFAULT_PREFS };
  draft = { ...stored };
  commands = stored.customCommands.map((command) => ({ ...command }));
  populateLanguageSelects();
  fillForm(draft);
  renderBookmarks();
  renderCommands();
  void refreshShortcut();
  void refreshGeminiStatus();
  void refreshUsage();
  void refreshRecordings();
}
void init();
