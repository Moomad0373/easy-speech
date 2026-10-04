# Easy speech

A personal Chrome Extension (Manifest V3) for voice typing, built for **Persian** first and
open to **every language Chrome's speech service offers** — more than 100 locales, from
Arabic and German to Vietnamese and Zulu. It supports live browser dictation and an
optional Gemini recording mode that transcribes a recorded clip before inserting it.
Dictated text is inserted **exactly at the current cursor position** — never appended
blindly, never overwriting unrelated text — with automatic recognition-session recovery
for long, continuous dictation.

> Easy speech uses the browser's speech recognition and has no extension backend, no
> server, and no telemetry. Gemini mode sends a user-submitted recording **directly from
> the user's browser to Google's Gemini API** using the user's own Google API key. There
> is no intermediary server anywhere in the request path.

## What it does

1. Click the toolbar icon → pick a language → press **Start Listening**.
2. The extension captures the caret/selection of the currently focused editable element
   (`<input>`, `<textarea>`, `contenteditable`) **before** the microphone starts.
3. **Interim transcripts are written live** into the focused element at the
   caret as you speak — a transient preview that is rewritten in place with
   every revision. When a phrase is finalized, the final transcript **replaces
   the preview** through the element's native value setter + a bubbling `input`
   event, so React/Vue/Angular controlled inputs register the change.
4. **Spoken voice commands** (on by default, toggle in ⚙️ Settings) are executed
   instead of typed: saying «ویرگول» inserts `،`, «علامت سوال» inserts `؟`,
   «خط جدید» inserts a line break, `comma` inserts `,`, `new line` breaks the
   line, and so on — see [Voice commands](#voice-commands). You can define your
   own commands on the settings page (see
   [Custom voice commands](#custom-voice-commands)).
5. **Numbers as digits (optional)** — with *Always type numbers as digits*
   enabled, spoken numbers in final transcripts become digits via a
   language-aware compound parser (`NumberTransformer`): «بیست و پنج» and
   “twenty five” → 25, «صد و بیست و سه” → 123, “two thousand and twenty six”
   → 2026. Existing digits, decimals, dates, and phone numbers are never
   touched; conversion applies to final transcripts only.
6. When Chrome ends a recognition session on its own, a fresh session starts
   automatically (with exponential backoff and give-up limits). Pressing **Stop**
   never restarts.
7. Choose **Voice Recording — Gemini 3.5 Transcribe** to record a clip, watch the
   live level meter, cancel or stop it, and submit it for a Gemini transcript
   before insertion. Add your Google API key in Settings; it stays out of the
   popup/content UI and logs.

## Supported languages

Dictation targets any language in the catalog (`SUPPORTED_LANGUAGES` in
`src/shared/constants.ts`) — the union of Chrome's own speech-demo locale list and the
community-documented additions Chrome's speech service accepts (the Arabic regional
variants, Persian, Hebrew). Persian and English lead the list because they are the
defaults; the popup and Settings pages render the full catalog with native labels
(each language shown in its own script, via `Intl.DisplayNames`).

| Recognition mode | Languages | How it is decided |
| --- | --- | --- |
| 🟢 Local (on-device) | Whatever Chrome 139+ reports installable (English, German, Japanese, … — currently 17 packs) | Queried per language at runtime: `SpeechRecognition.available({ langs, processLocally, quality: 'dictation' })` |
| ☁️ Cloud / browser-managed | Everything else — including **Persian**, which has no on-device pack | Chrome's remote speech service; the popup labels it honestly |

The resolver never assumes a language is cloud-only: the mode for every language comes
from the same runtime query (`src/content/recognition/LanguageSupport.ts`), and the
popup explains the answer — local, cloud, pack-installable, or unknown.

Two dictation features remain **Persian/English-specific** by design: the built-in
spoken-command tables («ویرگول» → `،`, "new line" → break) and the numbers-as-digits
transformer. Custom voice commands work in **every** language and are the way to add
spoken punctuation elsewhere. The Gemini transcription mode accepts the whole catalog
as a language hint, plus Automatic detection.

## Supported input types (v1)

- `<input type="text|search|email|url|tel">` — password fields are rejected unless
  explicitly enabled (`new FormControlAdapter({ allowPassword: true })`).
- `<textarea>` — multiline transcripts preserved.
- `[contenteditable]` — insertion via DOM `Range` APIs using text nodes/`<br>` only;
  spoken text is **never** parsed as HTML (no `innerHTML` of transcripts).

Google Docs is intentionally **not** supported yet (it is not a plain contenteditable).

## Project layout

```
src/
├── background/service-worker.ts   # minimal MV3 worker (toggle-dictation + cycle-language commands)
├── popup/                         # popup UI: language + start/stop + status (vanilla TS + CSS)
├── options/                       # full settings page, opened in a tab (theme, dictation,
│                                  #   page UI, bookmarks, English mode, custom voice commands, shortcut)
├── content/
│   ├── content.ts                 # wiring: targets ⇄ recognition ⇄ messaging
│   ├── StatusIndicator.ts         # floating mic badge (toggle/drag, language label)
│   ├── insertion/                 # cursor capture + text insertion
│   │   ├── InputAdapter.ts        # adapter interface + input-type rules
│   │   ├── FormControlAdapter.ts  # input/textarea (React-safe setter)
│   │   ├── ContentEditableAdapter.ts
│   │   ├── GoogleKeepAdapter.ts   # keep.google.com: input-event sync + re-anchoring
│   │   └── TargetManager.ts       # captures/validates/commits targets
│   └── recognition/
│       ├── RecognitionManager.ts  # state machine + restart policy
│       ├── LanguageSupport.ts     # availability/install/mode resolution
│       ├── NumberTransformer.ts   # optional spoken-numbers → digits (fa/en)
│       ├── voiceCommands.ts       # built-in + custom spoken punctuation/commands
│       ├── engine/SpeechEngine.ts # provider abstraction (future Whisper etc.)
│       ├── engine/WebSpeechEngine.ts
│       ├── engine/GeminiTranscribeEngine.ts
│       ├── RecordingPanel.ts       # in-page recorder + level meter
│       └── speechApi.ts
├── background/gemini.ts           # Gemini client + API-key boundary (direct to Google)
├── shared/                        # types, constants, messaging, storage, languages, theme
└── types/speech-recognition.d.ts  # minimal Web Speech API typings
tests/                             # vitest unit tests (jsdom)
```

Architecture principle: **Speech Recognition ≠ Transcript Management ≠ Cursor
Management ≠ Text Insertion ≠ UI ≠ Messaging.** A future STT provider only implements
`SpeechEngine`; a new site only implements `InputAdapter`.

## Chrome setup (load unpacked)

```bash
npm install
npm run build          # outputs dist/
```

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top right).
3. Click **Load unpacked** and select the `dist/` folder.
4. Pin the "Easy speech" action. On first Start, Chrome asks for **microphone
   permission** — allow it.
5. For Gemini mode, open Settings and enter your Google API key (create one in
   [Google AI Studio](https://aistudio.google.com/apikey); restrict it to the
   Gemini API). Press **Test key** to confirm Google accepts it before you rely
   on it. The key is kept in extension storage, is used only as a request header
   to Google, is never shown again after saving, and is never logged. Optionally
   change the Gemini model ID if your Google AI account exposes a different
   transcription model alias.

   Requests go straight to `generativelanguage.googleapis.com`. The extension
   operates no server of its own. One consequence worth stating plainly: this
   mode needs a network that can reach Google's API, and some networks and
   countries block it — there, no API key will make it work. **Voice Typing is
   unaffected and needs no key at all.**

## Development commands

```bash
npm run typecheck      # tsc --noEmit
npm test               # vitest run (unit tests, jsdom)
npm run test:watch
npm run build          # icons → typecheck → popup/SW build → content build
npm run build:popup    # vite build (popup + service worker → dist/)
npm run build:content  # IIFE content bundle → dist/content/content.js
npm run icons          # regenerate PNG icons (no dependencies)
npm run pack           # zip dist/ as the Chrome Web Store upload artifact
npm run smoke          # load dist/ in a real browser and run live checks
```

The smoke test (`scripts/smoke-test.mjs`) launches Edge (Chrome 137+ removed
`--load-extension`; Edge still supports it — override with the `VT_BROWSER`
env var) and verifies: the service worker boots, the popup/options pages
render without console errors, the popup explains itself on non-scriptable
pages, and — via a temporary test double that adds a host permission for the
local test page — the full runtime flow: content-script injection,
START/STOP recognition with a fake microphone, and the CYCLE_LANGUAGE round
trip.

## Voice commands

Spoken phrases that are executed as punctuation/formatting instead of being
typed (modeled after Voice In's command tables, `src/content/recognition/voiceCommands.ts`).
Matching is token-exact — ordinary words are never rewritten — and the live
preview shows the interpreted result before the phrase is committed. Disable
via ⚙️ Settings → *Voice commands*.

| Persian (fa-IR) | Inserts | | English (en-US) | Inserts |
| --- | --- | --- | --- | --- |
| «ویرگول» / «کاما» | `،` | | `comma` | `,` |
| «نقطه» | `.` | | `period` / `full stop` | `.` |
| «علامت سوال» | `؟` | | `question mark` | `?` |
| «علامت تعجب» | `!` | | `exclamation mark` | `!` |
| «نقطه ویرگول» | `؛` | | `semicolon` | `;` |
| «دونقطه» | `:` | | `colon` | `:` |
| «سه نقطه» | `…` | | `ellipsis` | `…` |
| «خط تیره» | `-` | | `hyphen` | `-` |
| «خط تیره بلند» | `—` | | `dash` | `—` |
| «پرانتز باز» / «پرانتز بسته» | `(` / `)` | | `open paren` / `close paren` | `(` / `)` |
| «کروشه باز» / «کروشه بسته» | `[` / `]` | | `open bracket` / `close bracket` | `[` / `]` |
| «آکولاد باز» / «آکولاد بسته» | `{` / `}` | | `open brace` / `close brace` | `{` / `}` |
| «گیومه باز» / «گیومه بسته» | `«` / `»` | | `open quote` / `close quote` | `"` / `"` |
| «ات» | `@` | | `at sign` | `@` |
| «علامت درصد» | `%` | | `percent sign` | `%` |
| «علامت شارپ» | `#` | | `hash sign` / `number sign` | `#` |
| «علامت دلار» | `$` | | `dollar sign` | `$` |
| «علامت جمع» | `+` | | `plus sign` | `+` |
| «علامت مساوی» | `=` | | `equals sign` | `=` |
| «امپرسند» | `&` | | `ampersand` | `&` |
| «ستاره» | `*` | | `asterisk` | `*` |
| «اسلش» / «بک اسلش» | `/` / `\` | | `slash` / `backslash` | `/` / `\` |
| «کمتر از» / «بیشتر از» | `<` / `>` | | `less than` / `greater than` | `<` / `>` |
| «خط جدید» / «سطر جدید» | line break | | `new line` | line break |
| «پاراگراف جدید» | paragraph break | | `new paragraph` | paragraph break |

Example: dictating «عنوان دونقطه خط جدید مقدمه ویرگول متن نقطه» produces
`عنوان:\nمقدمه، متن.`

### Custom voice commands

All settings live on a dedicated **options page** — click **⚙️ Settings** in the
popup (or `chrome://extensions` → Easy speech → Details → Extension options) and
it opens in a regular tab.

Editing works with an explicit **💾 Save settings** button: edits are held as a
draft (the status line shows *Unsaved changes*, and the page warns before a
refresh would discard them), then pressing Save writes the **complete settings
object atomically** to `chrome.storage.local`, shows **Saved ✓**, verifies the
write landed, and broadcasts the new snapshot to all injected tabs. If browser
storage is unavailable in the context the page was opened from (e.g. as a plain
web page), a red banner explains it and saving is disabled — always open the
settings via the popup button or the extension details page.

To add your own commands, open the options page and scroll to **Custom voice
commands** (then press **💾 Save settings** at the top or bottom of the page):

1. **Say this** — the phrase that triggers the command. Multi-word phrases are
   matched exactly (up to 12 words) and case-insensitively; Persian text is
   normalized (ZWNJ, Arabic yeh/kaf variants).
2. **Type this** — what gets inserted. Use `\n` for a line break and `\t` for
   a tab. Leave it empty to *mute* a phrase (the words are dropped instead of
   typed).
3. Click **＋ Add command**. Edit (✎) or delete (🗑) entries at any time.

Useful recipes (same ideas as Voice In's custom commands):

| Say this | Type this | Effect |
| --- | --- | --- |
| `eye packet` | `iPacket` | fix a common mishearing of a brand/name |
| `ایمیل من` | `you@example.com` | avoid repeating your email address |
| `phone` | `217-652-8632` | templates for repetitive data entry |
| `امضا` | `\n—\nعلی` | multi-line signature via `\n` escapes |
| `colon` | `:` | insert a symbol the engine keeps spelling out |
| `uline` | *(empty)* | mute a misheard word entirely |

Notes:

- Custom commands work in **every language** and **override** the built-in
  commands with the same phrase.
- Punctuation-only replacements (≤ 2 chars, no letters/digits) hug the previous
  word automatically; text replacements keep normal spacing.
- They are stored locally in `chrome.storage.local` (part of the extension's
  prefs — no backend, no sync) and apply to new dictation sessions as well as
  live sessions (broadcast instantly to injected tabs).
- **Bulk add**: expand *Bulk add* and paste one command per line as
  `phrase => replacement` (a bare phrase mutes the word).

### Numbers as digits

Options page → Dictation → **Always type numbers as digits** (off by default).
When enabled, a modular language-aware transformer
(`src/content/recognition/NumberTransformer.ts`) rewrites spoken number words
in **final transcripts** (interim previews stay verbatim so nothing flickers):

- Compound parsing, not regex replacement: juxtaposition («صد و بیست و سه»,
  "one hundred twenty three" → 123), scale words (هزار/میلیون/میلیارد,
  thousand/million/billion), and the و/`and` connector — which continues a
  number only while magnitudes descend, so «بین پنج و شش» ("between five and
  six") keeps its conjunction.
- Whole-word matching only, so existing digits are never converted: `25`,
  `۲۵`, `3.5`, `2026/05/01`, `217-652-8632`, `ID 45` all pass through.
- Persian «نه» is a digit only inside a larger number («نود و نه» → 99);
  standalone it means "no" and stays a word.
- Punctuation glued to a number survives («پنج هزار،» → «5000،»).
- English hyphenated compounds ("twenty-five" → 25) are supported.

### Bookmarked languages & quick switch

Options page → Dictation → **Bookmarked languages**: tick the languages you
use (Persian, English — both bookmarked by default) and pick your preferred
language. Press **Alt+Shift+L** (customizable at `chrome://extensions/shortcuts`
→ *Switch between your bookmarked dictation languages*) to cycle through them:

- The selection is persisted; if dictation is running, the session **restarts
  immediately in the new language** — no manual stop/start.
- The language name (فارسی / English) briefly appears under the floating mic
  badge, and an open popup refreshes its dropdown.
- Unbookmarking your current preferred language moves the selection to the
  first remaining bookmark.

Two ways to trigger the cycle:

- **Browser command** — `Alt+Shift+L`, customizable only at
  `chrome://extensions/shortcuts` (Chrome provides no API to reassign it).
- **Custom in-page shortcut** — Options page → Dictation → *Custom switch
  shortcut*. Click the recorder, press any combo that includes **Ctrl, Alt or
  ⌘** (e.g. `Ctrl+J`), and Save. The content script matches it on the page, so
  it works mid-dictation while a text field is focused. `Esc` cancels a
  recording, `Delete` clears the shortcut, and a warning appears if you pick
  the same combination as the browser command (Chrome would swallow it first).

### Google Keep

Dictation works in Google Keep out of the box via a dedicated site adapter
(`src/content/insertion/GoogleKeepAdapter.ts`, spec §43). Keep is a
closed-source, Closure-compiled app ("Wizy" editor) with rotating generated
class names, so the adapter keys off stable facts only: hostname + ARIA roles
+ contenteditable state — which cover the note body, the note title, and every
checklist item. The note body is Keep's newer Docs-style editor root
(`role="combobox" contenteditable="false" aria-autocomplete="list"` — not a
contenteditable div), so the adapter promotes that combobox to the insertion
target itself; titles/checklists stay plain `contenteditable="true"` textboxes.

Two Keep-specific behaviors:

- **Input-event sync**: Keep saves notes by listening to editor `input`
  events; programmatic DOM insertion doesn't fire them natively, so the
  adapter dispatches a bubbling `input` event after every insertion and live
  preview — otherwise dictated text would render but never save.
- **DOM re-normalization**: Keep rewrites editor internals while you type,
  which can detach the captured caret mid-session. Instead of failing with
  insert-failed, the adapter re-anchors the range to the live caret inside the
  same (still-connected, still-focused) editor.

## Floating mic badge & recognition states

- A small floating **mic badge** appears on the right edge of the page as soon
  as dictation becomes active in the tab (e.g. right after pressing the
  dictation shortcut, Alt+Shift+V) and then **stays** so it can be reused:
  **click it to start/stop dictation**, **drag it** anywhere on screen (the
  position is remembered), hover for the exact phase (Listening… /
  Inserting text… / Restarting…), red ring on errors. Whenever the dictation
  language changes, the language name (فارسی / English) **briefly appears
  under the badge**. Toggle the whole feature on the options page → General →
  *Show floating mic badge during dictation*.
- The recognition state machine is:
  `idle → starting → listening ⇄ processing → restarting → listening … → stopping → idle`
  with `error` reachable from any state. Hard errors (`not-allowed`, `audio-capture`,
  `service-not-allowed`, `language-not-supported`) stop everything with a
  human-readable message; `no-speech`, `network` and non-user `aborted` are treated as
  recoverable lifecycle events.

## Privacy

- No analytics or telemetry. Voice Typing keeps only the last interim/final strings
  in memory for the UI.
- Preferences are persisted via `chrome.storage.local`; the Gemini API key is
  stored separately, is never returned to the UI, and is never logged.
- Gemini mode records a clip only after the user starts it, keeps it in memory
  until submission, then sends it **directly to Google's Gemini API** with the
  user's own API key. The recording is not persisted by the extension.
- **Cloud recognition caveat:** when cloud mode is used (all Persian, fallback
  English), Chrome sends speech to the browser's remote speech service. Gemini
  mode sends the submitted recording to Google using the user's API key.
- Permissions are minimal: `storage`, `activeTab`, `scripting`, `clipboardWrite`,
  plus a single scoped host permission for the Gemini API — no `<all_urls>`, no
  background page access to unrelated sites.

## Known limitations

- Chrome-only (target: Chrome 139+ for on-device English; older versions get cloud
  English with an honest "unavailable/unknown" note).
- Gemini mode requires the user's own Google API key **and** a network that can
  reach `generativelanguage.googleapis.com`. That host is blocked on some
  networks and in some countries; where it is unreachable the mode cannot work.
  Voice Typing needs no key and is unaffected.
- No Google Docs / ChatGPT / Notion / Gmail adapters yet (generic editors only).
- Gemini recording mode currently uses inline audio and is limited to five
  minutes / 12 MB per recording.
- Gemini model availability depends on the user's Google AI account and the
  configured model ID.
- Sites that re-render the focused element mid-session cause a safe stop with a
  *"text field is no longer available"* message rather than guessing a new target.
- React portals/iframes with isolated editors may need dedicated adapters later.
- `chrome://` and Web Store pages can never be dictated into (Chrome restriction).

## Future roadmap

Site adapters (Google Docs, ChatGPT, Notion, Gmail, Slack — Google Keep is
done) · push-to-talk · voice-command *actions* (undo, delete-word, paste, open
URL) · automatic punctuation · additional languages · a local `WhisperEngine`
behind the existing `SpeechEngine` interface (the recognition layer is already
provider-agnostic).

