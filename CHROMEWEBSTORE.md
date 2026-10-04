# Chrome Web Store Listing — Easy speech

> Last Updated: 2026-10-04
>
> Maintained per the `chrome-extensions` skill (Modern Web Guidance). Update this
> file whenever the manifest, permissions, features, or privacy posture change.
>
> **Remaining before submission:** host the privacy policy (Appendix A) and paste
> its URL. Everything else is ready: the code is at v1.0.0, the upload artifact is
> `easy-speech-v1.0.0.zip`, and all store graphics exist under `store/`.

## Store Listing

**Extension Name** [REQUIRED]

Easy speech

<!-- Must match manifest.json "name" (75 char max). Keep them identical. -->

**Short Description** [REQUIRED]

Voice typing in your language. Speak naturally and your words appear at the cursor on any website — Persian, English, and 100+ more.

<!-- 132/132 characters. -->

**Detailed Description** [REQUIRED]

Dictate instead of typing, in Persian (فارسی), English, Arabic, and more than 100 other languages, anywhere you can write in Chrome — email, documents, chat, search boxes, and notes apps. Choose live Voice Typing or record a clip for Gemini 3.5 Transcribe, then insert the returned text at your cursor.

Press Alt+Shift+V (or click the microphone badge) and start speaking. Your words are typed directly into the field you are writing in, exactly at your cursor position, with a live preview while you speak.

Key features:

- Dictation in 100+ languages, with instant switching between your bookmarked favourites (Alt+Shift+L, or your own custom combination).
- Spoken punctuation built in for Persian and English: say "comma", "period", «ویرگول» and the right mark is typed — and you can add commands for any language yourself.
- Numbers as digits, in Persian and English: say "twenty five" or «بیست و پنج» and get 25.
- Your own voice commands: teach the extension phrases you use all the time and have them expand automatically.
- A small floating microphone badge shows when dictation is active and lets you start or stop with one click. Drag it anywhere; it stays put.
- Reliable line breaks while you dictate: press Enter or Shift+Enter between spoken phrases and the next words land on the line you moved to, never in the middle of the line you left.
- Your existing text is never overwritten: the extension only ever replaces the exact words it wrote itself, so editing, re-selecting, or a page re-render mid-sentence cannot delete a sentence you already typed.
- A redesigned popup and Settings page: clearer status, one-tap start/stop, and grouped options that explain themselves.
- Honest status reporting: the toolbar popup shows whether recognition runs on your device or in the cloud, and why.
- Many languages can run entirely on your device in supported Chrome versions; languages without an on-device pack (Persian among them) use Chrome's speech service — the popup tells you exactly which mode you are getting, and why.
- Optional Gemini 3.5 Transcribe mode records a clip and sends the submitted audio straight to Google's Gemini API, using your own API key. There is no server run by the extension's author in the middle: the request goes from your browser to Google and nowhere else.
- You can check your key before you use it. Settings has a Test button that asks Google one question — is this key valid — and tells you straight away, so a typo costs a click instead of a lost recording. Voice Typing needs no key at all.
- A redesigned recording card: a single glowing microphone orb with a live level ring, a large timer, and one control that starts and stops the recording. Press Space to start or stop, Esc to cancel. The finished text is typed straight into the field you were writing in, and clicking the floating microphone badge again brings the card back for the next one.
- Nothing gets lost: a recording is saved on your computer the moment you finish speaking, before it is sent anywhere. It is deleted as soon as the transcript arrives, and kept if anything goes wrong — so a network error, an API problem, or a model failure no longer costs you the recording. Anything still saved is listed in Settings, where you can send it again without re-recording, or throw it away. Your voice never leaves this browser unless you retry it.
- Every transcribed clip is also copied to your clipboard as a backup, so if text in the field is deleted by accident, an editor that re-renders, or an undo, you can paste it straight back. The floating microphone badge tells you when the copy happened.
- Voice Transcribing settings, all in one place: pick the language (any of the 100+ dictation languages, or Automatic so the model detects it and follows you when you switch mid-recording), choose Verbatim (exactly as spoken, the default) or Smart (filler words removed and the formatting cleaned up), and add a comma-separated custom vocabulary of names and jargon the model should recognise correctly.
- See what each transcription costs. The Settings page shows what the last request used, plus totals for today, the last 24 hours, this month, and all time, and a full breakdown of the last one. Because your recording is the bulk of every request, a longer clip costs more — the numbers make that visible before it becomes a bill.
- Already have a recording? Choose the file instead of recording: pick or drop an MP3, M4A, WAV, WebM, OGG, FLAC or AAC file (up to 12 MB) and its transcript is inserted at your cursor, exactly like a live recording. The file is never stored by the extension.

How to use it:

1. Click the extension icon and open Settings to pick your languages, input mode, and options. Gemini mode requires your own Google API key.
2. Focus any text field on a website, then press Alt+Shift+V or click the microphone badge.
3. For Voice Typing, speak and press the shortcut again to stop. For Gemini mode, use the in-page recorder: press the orb to start, press it again to finish, and the transcript is typed into your field as soon as it arrives. Click the floating microphone badge (or press Alt+Shift+V) whenever you want to record the next one. You can also, in the popup, switch to "Upload file", choose or drop a recording you already have, and press Transcribe.

Privacy note: Voice Typing is handled by Chrome's built-in speech recognition. In Gemini mode, audio is sent for transcription only after you ask for it: either a clip you record and submit, or a file you choose from your device. The audio is sent directly from your browser to Google's Gemini API, authenticated with your own API key, and to no other destination — this extension has no server of its own and no intermediary in the request path. A clip you record is first written to this browser's own extension storage, on your computer, and deleted from there as soon as the transcript comes back; if the request fails or is cancelled, the recording is kept so you can retry it, and it is only ever sent to Google when you ask for that. You can see and erase every saved recording in Settings, and "Discard all" removes them immediately. These files stay in the extension's own storage and are never written into a website's storage, where the site could read them. A file you choose from your device is never stored: it is held in memory for the length of the request only, and the extension does not copy or read its contents. Your API key is kept in this browser's extension storage, is used only as a request header to Google, is never returned to the settings screen after you save it, and is never written to logs. The custom vocabulary, language and mode you set are sent with the request as Google's own transcription settings; they are stored only in this browser and are never used for anything else. After a transcription, its text is written to your system clipboard as a backup; the extension never reads the clipboard, and the copy replaces whatever was on it before. The extension has no analytics and no accounts; it only asks for access to the tab you are looking at, and its single host permission is Google's Gemini API.

Support: use the feedback link on the store listing to report a site where dictation does not work.

**Category** [REQUIRED]

Accessibility

**Single Purpose** [REQUIRED]

Type into any website's text fields by speaking.

**Primary Language** [REQUIRED]

English (the extension's UI is English; dictation itself supports 100+ languages)

## Graphics & Assets

| Asset                          | Dimensions  | Status   | Filename                                         |
| ------------------------------ | ----------- | -------- | ------------------------------------------------ |
| Store Icon [REQUIRED]          | 128×128 PNG | ✅ Ready | icons/icon128.png (generated by `npm run icons`) |
| Screenshot 1 [REQUIRED]        | 1280×800    | ✅ Ready | store/screenshot-1-dictation.png                 |
| Screenshot 2 [RECOMMENDED]     | 1280×800    | ✅ Ready | store/screenshot-2-popup.png                     |
| Screenshot 3 [RECOMMENDED]     | 1280×800    | ✅ Ready | store/screenshot-3-settings-dictation.png        |
| Screenshot 4                   | 1280×800    | ✅ Ready | store/screenshot-4-settings-commands.png         |
| Screenshot 5                   | 1280×800    | ✅ Ready | store/screenshot-5-settings-transcription.png    |
| Small Promo Tile [RECOMMENDED] | 440×280     | ✅ Ready | store/promo-small-440x280.png                    |
| Marquee Promo Tile             | 1400×560    | ✅ Ready | store/promo-marquee-1400x560.png                 |

### Screenshot Notes

All five screenshots and both promo tiles are generated from the real built
extension by `node scripts/make-store-assets.mjs` — last regenerated 2026-10-04
from the v1.0.0 build, after the popup/settings redesign:

1. Screenshot 1 — a dictated Persian sentence in an email compose, with the
   floating microphone badge active and the Alt+Shift+V hint (the core loop).
2. Screenshot 2 — the popup mid-dictation: input mode, language, honest
   cloud/local recognition badge, Record / Upload file tabs, and live interim
   and final transcripts.
3. Screenshot 3 — Settings → Dictation: input mode, preferred language,
   bookmarked languages, in-page switch shortcut, English recognition mode,
   and the voice-commands / numbers-as-digits toggles.
4. Screenshot 4 — Settings → Custom voice commands: the phrase → replacement
   editor, bulk add, and the commands table.
5. Screenshot 5 — Settings → Voice Transcribing: the user's own Google API key
   with Save / Test / Remove, the direct-to-Google explanation, and the model
   ID override.

## Permissions Justification

<!-- Every permission in manifest.json needs a plain-English reason the review
     team can understand. "Required for functionality" will be rejected. -->

| Permission                                    | Type            | Justification                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --------------------------------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `storage`                                     | permissions     | Saves the user's settings, custom commands, selected Gemini model, and the microphone badge's position locally so they persist between sessions. A Gemini API key is stored separately for the optional transcription feature and is never displayed or logged. Also holds a recorded clip on the user's own computer from the moment it is captured until its transcript is received, so a failed transcription does not lose the audio; it is deleted on success, is never transmitted without the user asking for a retry, and can be erased from Settings at any time. |
| `activeTab`                                   | permissions     | Dictation starts only from a direct user action (toolbar popup click or keyboard shortcut). This permission grants temporary access to the current tab at that moment so recognized text can be inserted into the field the user is focused on, and so the on-page microphone badge and recorder can be shown. The extension has no access to tabs the user has not activated it on.                                                                                                                                                                                       |
| `scripting`                                   | permissions     | Used together with activeTab to add the dictation controller to the current tab when the user starts voice typing or recording. This keeps the extension inert on pages until the user explicitly asks it to run there; no code is injected in the background or without a user action.                                                                                                                                                                                                                                                                                    |
| `clipboardWrite`                              | permissions     | Keeps a backup of every Voice Transcribing result on the clipboard, immediately after the text has been inserted into the user's field. Dictated text is easy to lose to a mis-click, a re-rendering editor or an undo, and the clipboard is the only place to recover it from. The extension never reads the clipboard, and the copy is of the extension's own transcription and nothing else.                                                                                                                                                                            |
| `https://generativelanguage.googleapis.com/*` | host permission | The single host this extension ever contacts. It allows the optional Gemini recording mode to post a user-submitted audio clip to Google's Gemini API for transcription, authenticated with the user's own API key. This is the whole data path for that mode: there is no intermediary server, and no other host is contacted by any part of the extension.                                                                                                                                                                                                               |

Keyboard shortcuts (`commands` manifest key, not a permission): Alt+Shift+V starts
or stops dictation; Alt+Shift+L switches between the user's bookmarked
languages. Both count as direct user gestures for activeTab.

## Privacy & Data Use

### Data Collection

**Does the extension collect user data?** Yes, only when the user chooses Gemini mode

Voice Typing does not transmit recordings through the extension. In Gemini mode,
the user explicitly starts a recording and submits it, or explicitly chooses an
audio file from their own device; the audio is then sent directly from the
user's browser to Google's Gemini API, using the user's own API key. There is no
intermediary server operated by the extension's author, and no other destination
is contacted. The extension does not read the contents of a user's file for any
purpose other than that transcription, and never uploads a file the user has not
chosen.

A clip the user records is held in memory for the length of the request and is
additionally written to the extension's own local storage (IndexedDB, inside the
extension's origin) before the request is sent, so that a failed, timed-out or
cancelled transcription does not destroy audio the user cannot recreate. That copy
is deleted as soon as a transcript is received. When a request fails, or the user
cancels it, the recording is retained locally and shown in Settings, where it can
be retried against the same endpoint or discarded; it is only ever transmitted
when the user asks for that retry. Nothing is sent in the background, the storage
belongs to the extension rather than to any website, and the user can erase every
saved recording at any time. At most five untranscribed recordings are kept, the
oldest being dropped first. An audio file the user chose from their device is
never stored.

Preferences, custom commands, model selection, and the user's API key are stored
in `chrome.storage.local`, the extension's own storage inside the user's browser
profile. The key is never returned to the settings UI or written to logs; it is
used only as an `x-goog-api-key` header on requests to Google. Users are advised
on the Settings page to restrict the key they create to the Gemini API.

The transcription language, mode and custom vocabulary the user sets in the
Voice Transcribing section travel with each transcription request as Google's own
transcription settings — the vocabulary is text the user typed in order to improve
recognition of their own terms. They are stored only in `chrome.storage.local`
and are never used for anything other than that request. No new data type is
transmitted: the same audio, to the same single endpoint, as before.

Gemini reports what each transcription consumed in tokens. The extension keeps a
local tally of those counts so the Settings page can show the cost of the last
request and the totals for today, the last 24 hours, this month, and all time.
This tally is **counts and timestamps only** — it holds no audio, no transcript,
no dictated text, and none of the custom vocabulary. It never leaves the browser
and can be erased at any time with "Reset counters" in Settings.

Voice Typing may also use Chrome's built-in speech service for cloud recognition.
The extension has no analytics, telemetry, accounts, or unrelated network
requests.

### Data Use Certification

<!-- Check all that apply: -->

- [x] Data is NOT sold to third parties
- [x] Data is NOT used for purposes unrelated to the extension's core functionality
- [x] Data is NOT used for creditworthiness or lending purposes

## Privacy Policy

**Privacy Policy URL** [REQUIRED]

<!-- BLOCKING: the extension transmits user audio to Google and stores an API
     key, so a hosted privacy policy is required before the item can be
     submitted. The full text is written and ready in Appendix A — host it on
     GitHub Pages, a gist, or your own site, then paste the URL here. -->

TODO before submission — host Appendix A and paste the URL.

**Policy text (ready to host)** — see Appendix A.

## Distribution

**Visibility**: Public
**Regions**: All regions

## Developer Info

**Publisher Name** [REQUIRED]

Mohammad Rezaei

**Contact Email** [REQUIRED]

mohammadrezaei0373@gmail.com

**Support URL / Email** [RECOMMENDED]

https://github.com/Moomad0373/easy-speech/issues

**Homepage URL** [RECOMMENDED]

https://github.com/Moomad0373/easy-speech

## Version History

<!-- First public release. Every entry below 1.0.0 was an internal build that was
     never published, so the 0.x history is not listed here: several of those entries
     describe a developer-operated transcription relay and a two-endpoint data path
     that no longer exist in the code a reviewer downloads. Summarised, not deleted. -->

1.0.0 (first public release). Easy speech types into any website's text field as you
speak, in more than 100 languages. It has two modes.

**Voice Typing** uses the browser's own speech recognition and needs no account, no
key and no network of ours. Languages Chrome cannot run on-device — Persian among
them — use its speech service, which the popup labels honestly as cloud rather than
claiming they run on the device. Languages with an on-device pack run locally when
Chrome 139+ reports it, and fall back to the cloud with the reason shown in the
popup. Dictated text is written live at the
caret as a preview and rewritten in place, so the engine's revisions never leave
duplicated or orphaned words behind, and a final phrase replaces that preview through
the field's native value setter and a bubbling input event so React, Vue and Angular
editors register the change. When Chrome ends a recognition session on its own — which
it does constantly — a fresh one starts automatically, with exponential backoff and
give-up limits so it can never spin. Pressing Stop never restarts.

**Voice Transcribing** is optional and inactive unless chosen. You record a clip, or
drop in a file you already have, and it is transcribed by Google's Gemini Transcribe
model using your own Google API key. The request goes from your browser straight to
Google's API: this extension operates no server of its own, and there is no
intermediary anywhere in the path. Because dictation is spoken rather than typed, a
clip is written to your own machine's extension storage before it is sent and deleted
the moment a transcript comes back; a request that fails leaves the audio in place and
lists it in Settings, where it can be sent again or discarded. That storage belongs to
the extension rather than to the page you were dictating into, so a site cannot read
your microphone audio. Settings can check whether your key is valid before you rely on
it, and each transcript is copied to your clipboard as a backup against a mis-click or a
re-rendering editor.

Also included: spoken punctuation and line-break commands (built-in tables for
Persian and English, plus your own custom commands, which work in every language);
spoken numbers written as digits by a language-aware parser («بیست و پنج» and "twenty
five" both become 25); instant switching between bookmarked
languages by keyboard shortcut, which restarts a live session in the new language; a
draggable floating microphone badge; and a dedicated adapter for Google Keep, whose
editor is closed-source and re-renders itself while you type.

Two hardening changes are worth naming, because they matter more at public scale than
they did for a single user. A rejected request now reports Google's own reason — an
unknown model, an unsupported audio container — instead of one generic failure, so a
mistake costs a click rather than a lost recording. And an unparseable response body is
never treated as a transcript: on a public endpoint such a body is far more likely to
be an intermediary's error page than anyone's speech, and typing that into the user's
document would be unrecoverable.

Verification (re-run 2026-10-04 on the 1.0.0 build): 624 unit tests, typecheck,
a production build, and an end-to-end smoke run in a real browser covering
service-worker boot, content-script injection, start/stop, and the
language-cycle round trip.

| Version | Date       | Changes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Status           |
| ------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 1.0.0   | 2026-10-04 | First public release. Voice typing into any website's text field in more than 100 languages, using the browser's own speech recognition; on-device availability is reported honestly per language. Optional Gemini Transcribe mode sends a submitted recording or a chosen audio file directly from the user's browser to Google's Gemini API using the user's own API key — this extension operates no server and has no intermediary in the request path. Includes spoken punctuation and custom voice commands, spoken numbers as digits, bookmarked-language switching, a floating microphone badge, a dedicated Google Keep adapter, local recovery of untranscribed recordings, clipboard backup of every transcript, and local token accounting. A rejected request reports Google's own reason, and an unparseable response body is never inserted as text. See the entry above for the full description. | Ready to publish |

## Review Notes

### Known Issues / Limitations

- Dictation is unavailable on Chrome-internal pages (chrome://, Web Store, PDF
  viewer) by browser design; the extension shows a clear message there.
- Rich text fields built with frameworks that re-render while you type (Google
  Keep, chat composers, note apps) can reformat dictated text — for example
  turning a soft line break into its own paragraph. The extension always
  follows the page's own structure; it cannot force a specific line style.
- On-device recognition requires Chrome 139+ with the on-device speech feature and
  varies by language; the popup explains the current mode for the selected language.
  Cloud recognition always works.
- Speech is handled by Chrome's built-in recognition; microphone permission is
  granted to Chrome itself and may be prompted on first dictation.
- Gemini mode requires the user's own Google API key and network access to
  `generativelanguage.googleapis.com`. That host is blocked or unreachable on
  some networks and in some countries; where it is unreachable, no API key will
  make the mode work, and the Settings page says so plainly. Voice Typing does
  not use this mode, does not need a key, and is unaffected.
- Recordings are limited to five minutes and 12 MB and are sent only after the
  user submits them. A transcription is given up on after ten minutes; on a slow
  connection a full-length clip can take several minutes to upload and process,
  which is expected, and can be cancelled while it runs.
- The Settings page can check whether a key is valid before it is used. The
  check is Google's answer to one question and nothing more: a key can pass it
  and still lack quota, billing, or access to the configured transcription
  model.
- The language, mode and custom vocabulary settings apply to Voice Transcribing
  only. Chrome's built-in speech recognition exposes no equivalent, so live
  Voice Typing always uses the language selected in the Dictation section.
  Smart mode rewrites the transcript — it is a readability option, not a
  verbatim record, which is why Verbatim is the default.
- A recorded clip is transcribed as soon as it is submitted, and the text is
  typed into the field immediately. If the model misheard a word, select it in
  your own application and retype it, or re-record that sentence.
- The token counters measure the requests this extension made with your own API
  key. They are not a Google account total, so they will not match a Google AI
  Studio figure that also covers other tools. A request whose usage Gemini did
  not report is not counted, so the totals are a lower bound rather than an
  exact bill.
- A recorded clip and an uploaded audio file are treated the same way now: the
  transcript is typed into the field as soon as the model returns it, with no
  confirmation step in between. If a word comes back wrong, select it in your
  own application and retype it, or re-record that sentence.
- Every transcription is copied to your clipboard as a backup, which replaces
  whatever you had copied before. The extension never reads the clipboard. A
  site that blocks clipboard writes through its own policy is handled, but in
  the rare case a copy cannot be made at all, the badge says so rather than
  implying a backup exists.

### Rejection History

<!-- | Date | Reason | Fix Applied | Resubmitted | -->

---

## Appendix A — Privacy policy text (host publicly, then link above)

Privacy Policy for Easy speech

Last updated: 2026-10-04

Voice Typing mode: the extension uses the browser's built-in speech recognition.
If Chrome uses its cloud recognition service, speech is handled by Google under
Chrome's applicable privacy terms. Easy speech does not upload or retain audio in
this mode, and this mode requires no API key.

Gemini mode: when you explicitly choose Gemini 3.5 Transcribe, either start a
recording or choose an existing audio file, and submit it, the audio is sent for
transcription. That request goes directly from your browser to Google's Gemini API
at `generativelanguage.googleapis.com`, authenticated with your own Google API
key. There is no intermediary: the extension operates no server of its own, and
the audio is sent to no other destination. This mode requires your browser to be
able to reach Google's API, which some networks and countries block; where it is
blocked the mode cannot work. A file you choose is never read for any purpose
other than transcribing it, and is never stored.

Your API key: if you provide one, it is stored in the extension's local browser
storage on your computer, used only as a request header to Google, never returned
to the settings screen after you save it, and never written to logs. It is not
transmitted to any other party. You can remove it at any time with "Remove key"
in Settings. We recommend restricting the key you create to the Gemini API.

Saved recordings: a clip you record is written to the extension's own local
storage on your computer, before it is sent, and is deleted from there as soon as
the transcript arrives. If the request fails, times out, or you cancel it, the
recording is kept so that you are not left having to speak it again; it stays on
your machine and is listed in Settings, where you can send it once more or
discard it. A saved recording is never transmitted unless you choose to retry it,
and it then goes to the same endpoint as the original request. These files are
held in the extension's storage, not in the storage of any website you were
dictating into, so a site cannot read them. At most five untranscribed recordings
are kept and the oldest is discarded first. "Discard all" in Settings, or
uninstalling the extension, removes them.

Other data: preferences, voice commands, model selection, and badge position are
stored locally in your browser. The extension contains no analytics, telemetry,
accounts, or unrelated external requests. Its single host permission is
`generativelanguage.googleapis.com`, the Gemini API endpoint described above.

Retention and deletion: uninstalling the extension removes its local settings,
its API key, and any saved recordings. Browser speech-recognition data is
governed by Chrome and Google's policies.

Changes to this policy: material changes will be described in the store
listing's version history.

Contact: mohammadrezaei0373@gmail.com
