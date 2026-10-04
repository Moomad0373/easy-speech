/**
 * Popup UI logic. The popup owns no recognition state — it sends commands to
 * the content script (which runs RecognitionManager in the page) and renders
 * status broadcasts coming back (spec §21). All settings live on the options
 * page (opened in a tab); the popup only links to it.
 */
import {
  ensureContentScript,
  getActiveTab,
  requestStatus,
  sendToTab,
  type ExtensionMessage,
  type InstallPackResponse,
  type ModePreviewResponse,
  type StartResponse,
} from '../shared/messaging';
import { isActiveState } from '../shared/state';
import { loadPrefs, savePrefs, type Prefs } from '../shared/storage';
import { languageLabel, sortedLanguageOptions } from '../shared/languages';
import { applyTheme } from '../shared/theme';
import {
  AUDIO_FILE_ACCEPT,
  AUDIO_FILE_FORMAT_HINT,
  audioFileExtension,
  blobToBase64,
  formatAudioFileSize,
  isSupportedAudioFile,
  MAX_AUDIO_FILE_BYTES,
  resolveAudioMimeType,
} from '../shared/audio';
import { GEMINI_TRANSCRIPTION_TIMEOUT_MS } from '../shared/constants';
import type {
  AvailabilityState,
  Language,
  RecognitionMode,
  RecognitionStatus,
  TranscriptionProvider,
} from '../shared/types';

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`popup is missing #${id}`);
  return node as T;
}

const providerSelect = el<HTMLSelectElement>('dictation-provider');
const languageSelect = el<HTMLSelectElement>('language');
const modeBadge = el('mode-badge');
const modeNote = el('mode-note');
const installButton = el<HTMLButtonElement>('install-pack');
const toggleButton = el<HTMLButtonElement>('toggle');
const statusLine = el('status');
const noteLine = el('note');
const statusDot = document.querySelector<HTMLElement>('.status-dot');
const errorLine = el('error');
const transcriptsBox = el<HTMLDetailsElement>('transcripts');
const interimLine = el('interim');
const finalLine = el('final');
const settingsButton = el<HTMLButtonElement>('open-settings');
const sourceSwitch = el('source-switch');
const sourceRecordTab = el<HTMLButtonElement>('source-record');
const sourceUploadTab = el<HTMLButtonElement>('source-upload');
const uploadPanel = el('upload-panel');
const fileInput = el<HTMLInputElement>('audio-file');
const dropzone = el<HTMLLabelElement>('dropzone');
const dropzoneHint = el('dropzone-hint');
const fileSummary = el('file-summary');
const fileNameLabel = el('file-name');
const fileMetaLabel = el('file-meta');
const fileClearButton = el<HTMLButtonElement>('file-clear');
const transcribeButton = el<HTMLButtonElement>('transcribe-file');

type AudioSource = 'record' | 'upload';

let prefs: Prefs | null = null;
let targetTabId: number | null = null;
toggleButton.disabled = true;

/** Which way the Gemini panel gets its audio. Session state, not a setting. */
let audioSource: AudioSource = 'record';
/** The file the user picked, validated and ready to send. */
let selectedFile: File | null = null;
let selectedFileType: string | null = null;
/** True from sending an upload until its transcript has been committed. */
let uploadBusy = false;
/** Safety net so the button can never stay stuck if a status is missed. */
let uploadBusyTimer: ReturnType<typeof setTimeout> | null = null;

const HUMAN_STATES: Record<RecognitionStatus['state'], string> = {
  idle: 'Ready',
  starting: 'Starting…',
  listening: 'Listening…',
  processing: 'Processing…',
  restarting: 'Restarting recognition…',
  error: 'Error',
  stopping: 'Stopping…',
};

function showError(message: string): void {
  errorLine.textContent = message;
  errorLine.hidden = false;
}

function hideError(): void {
  errorLine.hidden = true;
}

function describeMode(mode: RecognitionMode | null, availability: AvailabilityState): string {
  if (prefs?.dictationProvider === 'gemini') return 'Gemini 3.5 Transcribe';
  if (!availability || availability === 'unknown') return '❔ Unknown (cloud)';
  if (availability === 'available' && mode === 'local') return '🟢 Local (on-device)';
  if (availability === 'downloading') return '⏳ Pack downloading — cloud for now';
  if (availability === 'downloadable') return '🟡 Cloud (pack installable)';
  return mode === 'local' ? '🟢 Local (on-device)' : '☁️ Cloud';
}

function renderModeBadge(mode: RecognitionMode | null, availability: AvailabilityState, note: string): void {
  modeBadge.textContent = describeMode(mode, availability);
  modeNote.textContent = note;
  const installable = availability === 'downloadable' || availability === 'downloading';
  installButton.hidden = prefs?.dictationProvider === 'gemini' || !installable;
  if (installable) {
    // Name the actual pack: the button sits under whatever language is selected.
    installButton.querySelector('.install-label')!.textContent =
      `Install ${languageLabel(languageSelect.value as Language)} Language Pack`;
  }
}

function setToggleFor(state: RecognitionStatus['state']): void {
  const active = isActiveState(state);
  const recording = prefs?.dictationProvider === 'gemini';
  toggleButton.textContent = active
    ? (recording ? '■ Stop Recording' : '⏹ Stop Listening')
    : (recording ? '● Start Recording' : '🎙 Start Listening');
  toggleButton.classList.toggle('active', active);
  transcribeButton.classList.toggle('active', active && uploadBusy);
}

// ---- audio file upload ---------------------------------------------------

/** The Gemini panel offers a recording or an existing file; this swaps them. */
function renderAudioSource(): void {
  const gemini = prefs?.dictationProvider === 'gemini';
  sourceSwitch.hidden = !gemini;
  uploadPanel.hidden = !gemini || audioSource !== 'upload';
  // Only one primary action is ever live: the record button gives way to the
  // upload panel's own, so the popup never shows two competing controls.
  toggleButton.hidden = gemini && audioSource === 'upload';
  sourceRecordTab.setAttribute('aria-selected', String(audioSource === 'record'));
  sourceUploadTab.setAttribute('aria-selected', String(audioSource === 'upload'));
}

function renderSelectedFile(): void {
  const hasFile = selectedFile !== null;
  fileSummary.hidden = !hasFile;
  dropzone.hidden = hasFile;
  transcribeButton.disabled = !hasFile || uploadBusy;
  if (!hasFile || !selectedFile) return;
  fileNameLabel.textContent = selectedFile.name;
  // The extension is what the user recognises on their own file; the raw MIME
  // subtype ("x-m4a") is not.
  const format = audioFileExtension(selectedFile.name).toUpperCase() ||
    (selectedFileType ?? '').replace('audio/', '').toUpperCase();
  fileMetaLabel.textContent = [formatAudioFileSize(selectedFile.size), format]
    .filter(Boolean)
    .join(' · ');
}

/** Clears the picker after a transcription so the next file starts fresh. */
function resetSelectedFile(): void {
  selectedFile = null;
  selectedFileType = null;
  fileInput.value = '';
  renderSelectedFile();
}

function setUploadBusy(busy: boolean): void {
  uploadBusy = busy;
  if (uploadBusyTimer !== null) {
    clearTimeout(uploadBusyTimer);
    uploadBusyTimer = null;
  }
  if (busy) {
    transcribeButton.disabled = true;
    transcribeButton.querySelector('.toggle-label')!.textContent = 'Transcribing…';
    // The engine's own timeout is the real bound; this only guarantees the
    // control comes back if a status update never arrives.
    uploadBusyTimer = setTimeout(() => setUploadBusy(false), GEMINI_TRANSCRIPTION_TIMEOUT_MS + 5000);
  } else {
    transcribeButton.querySelector('.toggle-label')!.textContent = 'Transcribe file';
    renderSelectedFile();
  }
}

function acceptFile(file: File | undefined | null): void {
  if (!file) return;
  if (!isSupportedAudioFile(file.name, file.type)) {
    resetSelectedFile();
    showError(`“${file.name}” is not a supported audio file. Choose ${AUDIO_FILE_FORMAT_HINT}.`);
    return;
  }
  if (file.size === 0) {
    resetSelectedFile();
    showError('That file is empty.');
    return;
  }
  if (file.size > MAX_AUDIO_FILE_BYTES) {
    resetSelectedFile();
    showError(
      `That file is ${formatAudioFileSize(file.size)}. Please choose a file under ` +
      `${formatAudioFileSize(MAX_AUDIO_FILE_BYTES)}.`
    );
    return;
  }
  hideError();
  selectedFile = file;
  selectedFileType = resolveAudioMimeType(file.name, file.type);
  renderSelectedFile();
}

async function onTranscribeFile(): Promise<void> {
  if (!prefs || !selectedFile || uploadBusy || targetTabId === null) return;
  const file = selectedFile;
  const mimeType = selectedFileType ?? resolveAudioMimeType(file.name, file.type);
  if (!mimeType) return;
  hideError();
  setUploadBusy(true);
  try {
    await ensureContentScript(targetTabId);
    const response = await sendToTab<StartResponse>(targetTabId, {
      type: 'TRANSCRIBE_AUDIO_FILE',
      data: await blobToBase64(file),
      mimeType,
      fileName: file.name,
      language: prefs.selectedLanguage,
      model: prefs.geminiModel,
    });
    if (!response?.ok) {
      setUploadBusy(false);
      showError(
        response?.reason === 'no-target'
          ? 'Focus the text field you want the transcript in, then try again.'
          : response?.reason === 'gemini-key'
            ? 'Add a Google API key in Settings before transcribing a file.'
            : response?.reason === 'file'
              ? 'That file could not be read. Try a different recording.'
              : 'The file could not be transcribed. Please try again.'
      );
    }
    // On success the busy state is cleared by the status broadcast that
    // follows the commit; the safety timer covers a missed update.
  } catch (error) {
    setUploadBusy(false);
    showError(error instanceof Error ? error.message : String(error));
  }
}

fileInput.addEventListener('change', () => {
  acceptFile(fileInput.files?.[0]);
  // Selecting the same file twice must still register as a new choice.
  fileInput.value = '';
});

fileClearButton.addEventListener('click', () => {
  hideError();
  resetSelectedFile();
});

sourceRecordTab.addEventListener('click', () => {
  audioSource = 'record';
  renderAudioSource();
});

sourceUploadTab.addEventListener('click', () => {
  audioSource = 'upload';
  renderAudioSource();
});

transcribeButton.addEventListener('click', () => void onTranscribeFile());

// Drag and drop: the same handler as the picker, so a dropped file behaves
// exactly like a chosen one.
for (const type of ['dragenter', 'dragover'] as const) {
  dropzone.addEventListener(type, (event) => {
    event.preventDefault();
    dropzone.classList.add('is-dragover');
  });
}
for (const type of ['dragleave', 'dragend'] as const) {
  dropzone.addEventListener(type, () => dropzone.classList.remove('is-dragover'));
}
dropzone.addEventListener('drop', (event) => {
  event.preventDefault();
  dropzone.classList.remove('is-dragover');
  acceptFile(event.dataTransfer?.files?.[0]);
});

function renderStatus(status: RecognitionStatus): void {
  statusLine.textContent = `Status: ${HUMAN_STATES[status.state]}`;
  // Drives the live indicator next to the status line (presentation only).
  statusDot?.setAttribute('data-state', status.state);
  // An upload finishes when the session it started settles. A successful run
  // (idle) clears the picker so the same clip is not sent twice by accident; a
  // failed one keeps it, because retrying is what the user wants next.
  if (uploadBusy && (status.state === 'idle' || status.state === 'error')) {
    const succeeded = status.state === 'idle';
    setUploadBusy(false);
    if (succeeded) resetSelectedFile();
  }
  setToggleFor(status.state);

  // Language quick-switch (Alt+Shift+L) changes the selection outside the
  // popup — keep the dropdown and the cached prefs in sync (spec §42).
  if (status.language && prefs && status.language !== prefs.selectedLanguage) {
    prefs.selectedLanguage = status.language;
    languageSelect.value = status.language;
    void refreshPreview();
  }

  if (status.uncommittedTranscript) {
    showError(`Could not insert: “${status.uncommittedTranscript}”`);
  } else if (status.lastError) {
    showError(status.lastError.message);
  } else {
    hideError();
  }

  transcriptsBox.open = Boolean(status.interimTranscript || status.lastFinalTranscript);
  interimLine.textContent = status.interimTranscript ? `Interim: ${status.interimTranscript}` : '';
  finalLine.textContent = status.lastFinalTranscript ? `Final: ${status.lastFinalTranscript}` : '';

  // A side effect the user should know about (the clipboard was overwritten).
  // Shown only while the note is current, never as a sticky banner.
  noteLine.textContent = status.note ?? '';
  noteLine.hidden = !status.note;

  // While a session is live, the authoritative mode comes from the recognition layer.
  if (status.language && status.language === languageSelect.value) {
    renderModeBadge(status.mode, status.availability, status.modeNote);
  }
}

async function refreshPreview(): Promise<void> {
  if (!prefs) return;
  const language = prefs.selectedLanguage;
  if (targetTabId === null) {
    modeNote.textContent = 'No active tab.';
    return;
  }
  try {
    await ensureContentScript(targetTabId);
  } catch (error) {
    modeBadge.textContent = '—';
    modeNote.textContent = error instanceof Error ? error.message : String(error);
    return;
  }
  const preview = await sendToTab<ModePreviewResponse>(targetTabId, {
    type: 'GET_MODE_PREVIEW',
    language,
  });
  if (preview) renderModeBadge(preview.mode, preview.availability, preview.note);
}

async function onToggle(): Promise<void> {
  if (!prefs || toggleButton.disabled) return;
  hideError();
  if (targetTabId === null) {
    showError('No active tab.');
    return;
  }
  toggleButton.disabled = true;
  try {
    await ensureContentScript(targetTabId);
    const status = await requestStatus(targetTabId);
    if (!status) {
      showError('Could not read recognition status. Reload the page and try again.');
      return;
    }

    if (isActiveState(status.state)) {
      const response = await sendToTab<{ ok: boolean }>(targetTabId, { type: 'STOP_RECOGNITION' });
      if (!response?.ok) showError('Recognition could not be stopped. Please try again.');
      return;
    }

    const response = await sendToTab<StartResponse>(targetTabId, prefs.dictationProvider === 'gemini'
      ? { type: 'START_GEMINI_RECORDING', language: prefs.selectedLanguage, model: prefs.geminiModel }
      : { type: 'START_RECOGNITION', language: prefs.selectedLanguage, preferredMode: prefs.preferredRecognitionMode });
    if (!response?.ok) {
      showError(
        response?.reason === 'no-target'
          ? 'No supported text field is focused. Focus a text field first.'
          : response?.reason === 'gemini-key'
            ? 'Add a Google API key in Settings before using Gemini.'
            : prefs.dictationProvider === 'gemini'
              ? 'The Gemini recorder could not start.'
              : 'Recognition failed to start. Check microphone access and try again.'
      );
    }
  } catch (error) {
    showError(error instanceof Error ? error.message : String(error));
  } finally {
    toggleButton.disabled = false;
  }
}

async function onInstall(): Promise<void> {
  if (targetTabId === null) return;
  const language = languageSelect.value as Language;
  const response = await sendToTab<InstallPackResponse>(targetTabId, {
    type: 'INSTALL_LANGUAGE_PACK',
    language,
  });
  if (response) {
    renderModeBadge(response.preview.mode, response.preview.availability, response.preview.note);
    if (response.ok) {
      modeNote.textContent = `${languageLabel(language)} local speech recognition is ready.`;
    } else {
      showError('The language pack could not be installed. Cloud recognition is still available.');
    }
  }
}

async function onProviderChange(): Promise<void> {
  if (!prefs) return;
  prefs.dictationProvider = providerSelect.value as TranscriptionProvider;
  await savePrefs({ dictationProvider: prefs.dictationProvider });
  hideError();
  renderAudioSource();
  await refreshPreview();
  if (prefs.dictationProvider === 'gemini') {
    setToggleFor('idle');
  }
}

async function onLanguageChange(): Promise<void> {
  if (!prefs) return;
  prefs.selectedLanguage = languageSelect.value as Language;
  await savePrefs({ selectedLanguage: prefs.selectedLanguage });
  hideError();
  await refreshPreview();
}

/** Fills the language dropdown from the catalog (native labels, sorted). */
function populateLanguages(): void {
  for (const { code, label } of sortedLanguageOptions()) {
    const option = document.createElement('option');
    option.value = code;
    option.textContent = `${label} (${code})`;
    languageSelect.appendChild(option);
  }
}

async function init(): Promise<void> {
  prefs = await loadPrefs();
  populateLanguages();
  providerSelect.value = prefs.dictationProvider;
  languageSelect.value = prefs.selectedLanguage;
  applyTheme(prefs.theme);
  fileInput.accept = AUDIO_FILE_ACCEPT;
  dropzoneHint.textContent = `${AUDIO_FILE_FORMAT_HINT} · up to ${formatAudioFileSize(MAX_AUDIO_FILE_BYTES)} · or drop one here`;
  renderAudioSource();
  renderSelectedFile();

  providerSelect.addEventListener('change', () => void onProviderChange());
  languageSelect.addEventListener('change', () => void onLanguageChange());
  settingsButton.addEventListener('click', () => {
    // Full settings live on the options page (spec §20) — more settings are
    // coming, and a dedicated tab has room for them.
    void chrome.tabs.create({ url: chrome.runtime.getURL('options/options.html') });
    window.close();
  });
  toggleButton.addEventListener('click', () => void onToggle());
  installButton.addEventListener('click', () => void onInstall());

  // Language switches made outside the popup (Alt+Shift+L or the custom
  // in-page combo) arrive here as RECOGNITION_STATUS broadcasts carrying the
  // new language; renderStatus syncs the dropdown (spec §42).
  chrome.runtime.onMessage.addListener((raw: unknown, sender) => {
    const message = raw as ExtensionMessage;
    if (targetTabId !== null && sender.tab?.id === targetTabId && message.type === 'RECOGNITION_STATUS') {
      renderStatus(message.status);
    }
  });

  try {
    const tab = await getActiveTab();
    targetTabId = tab?.id ?? null;
    if (targetTabId === null) {
      showError('No active tab.');
      return;
    }
    await refreshPreview();
    const status = await requestStatus(targetTabId);
    if (status) renderStatus(status);
  } catch (error) {
    showError(error instanceof Error ? error.message : String(error));
  } finally {
    toggleButton.disabled = targetTabId === null;
  }
}

void init();
