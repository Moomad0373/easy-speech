# Agent Instructions — Voice Type (fa/en)

Voice typing Chrome extension (Manifest V3) for Persian and English dictation.
Built and verified with the Chrome team's **Modern Web Guidance** skill pack
(installed at `.zcode/skills/`).

## Chrome team instruction (always follow)

Whenever you are creating or making changes to this Chrome extension, create and
manage the `CHROMEWEBSTORE.md` file in the project root. Use the `chrome-extensions`
skill (`.zcode/skills/chrome-extensions/SKILL.md`) to learn the format of this file.
Update it whenever permissions, user-facing features, privacy posture, or versions
change — it is the single source of truth for the store listing.

## Mandatory practice

- Follow the `chrome-extensions` skill's Part 1 mandatory rules and output checklist
  for any manifest, service worker, content-script, or popup change.
- For modern web platform questions (CSS, DOM APIs, built-in AI), use the
  `modern-web-guidance` skill, or search its guides on demand:
  `npx modern-web-guidance search "<topic>"` / `npx modern-web-guidance retrieve <id>`.
- Never generate Manifest V2 code. Never inline scripts/handlers in extension HTML.

## Commands

- `npm run build` — icons + `tsc --noEmit` + both Vite passes → `dist/`
- `npm test` — vitest (jsdom), tests in `tests/`
- `npm run pack` — zips `dist/` into the Chrome Web Store upload artifact

## Architecture notes

- The service worker and popup are thin: they only inject the content script
  (`chrome.scripting`, gated by `activeTab`) and relay messages. All runtime logic
  (recognition, insertion, status) lives in the content script.
- `src/content/` owns recognition (`recognition/`) and text insertion
  (`insertion/`, adapter pattern: FormControl → GoogleKeep → ContentEditable).
- The content script is a **consumer, never a writer** of settings except the
  explicit language-cycle flow (`handleCycleLanguage`), which is the single source
  of cycle logic; the service worker only forwards `CYCLE_LANGUAGE`.
