/**
 * Generates the Chrome Web Store graphics from the real, built extension.
 *
 * Nothing here is a mock-up drawn by hand: the popup, the Settings page, the
 * floating microphone badge and the dictated text are all the actual UI, loaded
 * from dist/ in a real browser and photographed. That matters for a store
 * listing — a screenshot that differs from the shipped extension is a
 * misrepresentation, and it is also the first thing a reviewer checks.
 *
 * How each image is produced:
 *   - The popup and Settings surfaces are captured as elements at their natural
 *     width, then placed on a branded 1280x800 canvas. Both pages are driven
 *     through a stubbed `chrome` API (installed before any page script runs) so
 *     they render a chosen state: dictation listening, an interim transcript,
 *     saved settings.
 *   - The hero image injects the real content/content.js into a plain demo page
 *     with a stubbed Web Speech API that emits a genuine Persian utterance, so
 *     the badge, the live preview and the committed text are produced by the
 *     extension's own code path rather than drawn.
 *   - The promo tiles are the store icon on the brand gradient.
 *
 * Usage: node scripts/make-store-assets.mjs   (build first: npm run build)
 * Output: store/  (screenshots 1280x800, small tile 440x280, marquee 1400x560)
 * Override the browser with the VT_BROWSER env var.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dist = path.join(root, 'dist');
const outDir = path.join(root, 'store');

if (!existsSync(path.join(dist, 'manifest.json'))) {
  console.error('dist/ not built — run `npm run build` first.');
  process.exit(1);
}

const chromeCandidates = [
  process.env.VT_BROWSER,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].filter(Boolean);
const browserPath = chromeCandidates.find((p) => existsSync(p));
if (!browserPath) {
  console.error('No Chromium-based browser found.');
  process.exit(1);
}

const { default: puppeteer } = await import('puppeteer-core');

/* Brand palette, taken from src/shared/theme.css so the canvas cannot drift
   away from the product it is advertising. */
const BRAND = {
  bg: '#f4f6fb',
  surface: '#ffffff',
  fg: '#101828',
  muted: '#6b7280',
  border: '#e2e6ef',
  accent: '#4f46e5',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A Persian sentence with a spoken number and spoken punctuation in it, so the
    screenshot shows the features rather than a bare string of words. */
const PERSIAN_FINAL = 'سلام، این یک متن آزمایشی است و بیست و پنج کلمه دارد.';
const PERSIAN_INTERIM = 'سلام، این یک متن آزمایشی است و بیست و پنج';

/**
 * A neutral compose window. Deliberately unbranded: the listing must not imply
 * a screenshot of somebody else's product.
 */
const DEMO_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<style>
  * { box-sizing: border-box; }
  body { margin: 0; font: 15px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif;
         background: ${BRAND.bg}; color: ${BRAND.fg}; padding: 52px 56px;
         display: flex; flex-direction: column; min-height: 100vh; }
  .wrap { max-width: 880px; margin: 0 auto; width: 100%; flex: 1 1 auto;
          display: flex; flex-direction: column; }
  h1 { font-size: 20px; font-weight: 650; margin: 0 0 4px; letter-spacing: -0.01em; }
  .sub { color: ${BRAND.muted}; font-size: 14px; margin: 0 0 24px; }
  .card { background: ${BRAND.surface}; border: 1px solid ${BRAND.border};
          border-radius: 14px; box-shadow: 0 1px 2px rgba(16,24,40,.05), 0 14px 36px -14px rgba(16,24,40,.20);
          overflow: hidden; }
  .row { display: flex; gap: 12px; padding: 15px 18px; border-bottom: 1px solid ${BRAND.border};
         font-size: 14px; color: ${BRAND.muted}; align-items: center; }
  .row b { color: ${BRAND.fg}; font-weight: 550; min-width: 68px; }
  textarea { width: 100%; min-height: 268px; border: 0; outline: 0; resize: none;
             padding: 20px 18px; font: 19px/2 "Vazirmatn", "Segoe UI", Tahoma, system-ui, sans-serif;
             color: ${BRAND.fg}; background: transparent; }
  .foot { display: flex; gap: 10px; padding: 14px 18px; border-top: 1px solid ${BRAND.border};
          font-size: 13px; color: ${BRAND.muted}; align-items: center; }
  .hint { margin-top: auto; padding-top: 26px; display: flex; align-items: center;
          gap: 10px; font-size: 13px; color: ${BRAND.muted}; }
  kbd { font: 600 12px/1 ui-monospace, "Cascadia Code", Consolas, monospace; color: ${BRAND.fg};
        background: ${BRAND.surface}; border: 1px solid ${BRAND.border};
        border-bottom-width: 2px; border-radius: 6px; padding: 5px 8px; }
  .demo { font-size: 11.5px; color: #9aa3b2; text-align: center; margin: 18px 0 0; }
</style></head><body>
<div class="wrap">
  <h1>New message</h1>
  <p class="sub">A plain editable field on an ordinary web page.</p>
  <div class="card">
    <div class="row"><b>To</b> recipient@example.com</div>
    <div class="row"><b>Subject</b> Dictation test</div>
    <textarea id="box" dir="rtl" spellcheck="false"></textarea>
    <div class="foot">Send &nbsp;&middot;&nbsp; Discard</div>
  </div>
  <div class="hint"><kbd>Alt</kbd><kbd>Shift</kbd><kbd>V</kbd> starts and stops dictation in this tab</div>
  <p class="demo">Demo page rendered by the store-asset generator. Not a screenshot of a third-party product.</p>
</div>
<script>window.addEventListener('load', () => document.getElementById('box').focus());</script>
</body></html>`;

/* -------------------------------------------------------------------------
 * chrome API stubs
 * ---------------------------------------------------------------------- */

/**
 * Installs the chrome stubs used by the popup and Settings pages.
 *
 * This function is handed to page.evaluateOnNewDocument, which serialises it
 * and runs it INSIDE the browser. It must therefore be entirely self-contained:
 * it can close over nothing out here, and everything it needs arrives as `state`.
 * (An earlier version referenced this file's PREFS/S constants, which do not
 * exist in the page — the stubs threw, the popup quietly fell back to its own
 * defaults, and the screenshot showed an idle dark-mode popup instead of the
 * listening state being asked for.)
 */
function installExtensionStubs(state) {
  window.chrome = {
    runtime: {
      id: 'storeasset',
      getURL: (p) => 'chrome-extension://storeasset/' + p,
      getManifest: () => ({ version: '1.0.0', name: 'Easy speech' }),
      lastError: null,
      onMessage: { addListener: () => {}, removeListener: () => {} },
      sendMessage: async (message) => {
        const type = message?.type;
        if (type === 'GET_GEMINI_STATUS') {
          return { ok: true, configured: true, model: 'gemini-3.5-transcribe' };
        }
        if (type === 'RECORDING_LIST') return { ok: true, recordings: [] };
        return { ok: true };
      },
    },
    storage: {
      local: {
        get: async (key) => {
          if (key === 'prefs') return { prefs: state.prefs };
          if (key === 'geminiApiKey') return { geminiApiKey: 'stored' };
          if (key === 'badgePosition') return { badgePosition: null };
          return {};
        },
        set: async () => {},
        remove: async () => {},
      },
    },
    tabs: {
      query: async () => [{ id: 1, active: true, url: 'https://example.com/' }],
      sendMessage: async (_tabId, message) => {
        const type = message?.type;
        if (type === 'GET_MODE_PREVIEW') {
          return {
            ok: true, supported: true, onDeviceSupported: true,
            mode: state.status?.mode ?? 'cloud',
            availability: 'unavailable',
            note: state.status?.modeNote ?? '',
            provider: 'voiceTyping', geminiConfigured: true,
          };
        }
        if (type === 'GET_STATUS') return { ok: true, status: state.status };
        if (type === 'INSTALL_LANGUAGE_PACK') {
          return {
            ok: true,
            preview: { ok: true, supported: true, mode: 'cloud', availability: 'unavailable', note: '' },
          };
        }
        return { ok: true };
      },
      create: async () => {},
    },
  };
}

/* -------------------------------------------------------------------------
 * browser
 * ---------------------------------------------------------------------- */

async function launch() {
  const profile = mkdtempSync(path.join(tmpdir(), 'voice-type-assets-'));
  const proc = spawn(browserPath, [
    '--disable-extensions-except=' + dist,
    '--load-extension=' + dist,
    '--disable-features=DisableLoadExtensionCommandLineSwitch',
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-scrollbars',
    `--user-data-dir=${profile}`,
    '--remote-debugging-port=0',
    'about:blank',
  ], { stdio: 'ignore' });

  let port = null;
  for (let i = 0; i < 40 && !port; i++) {
    const file = path.join(profile, 'DevToolsActivePort');
    if (existsSync(file)) port = readFileSync(file, 'utf8').split('\n')[0];
    else await sleep(500);
  }
  if (!port) {
    proc.kill();
    throw new Error('browser did not expose a DevTools port');
  }
  const puppet = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}` });
  await sleep(1500);
  const swTarget = puppet.targets().find((t) => t.type() === 'service_worker' && t.url().includes('service-worker.js'));
  if (!swTarget) throw new Error('extension service worker did not boot — build may be stale');
  const extensionId = new URL(swTarget.url()).host;
  return {
    puppet,
    extensionId,
    close: () => {
      puppet.disconnect().catch(() => {});
      proc.kill();
      try { rmSync(profile, { recursive: true, force: true }); } catch {}
    },
  };
}

/* -------------------------------------------------------------------------
 * compositing
 * ---------------------------------------------------------------------- */

/**
 * Places a captured PNG on a branded canvas at the store's required size.
 * Done in the browser rather than with an image library: the capture becomes a
 * data URI inside a plain page, which is then screenshotted.
 */
/**
 * Places a captured PNG on a branded canvas at the store's required size.
 *
 * `layout: 'side'` puts the copy on the left and the UI on the right, which
 * suits the narrow 320px popup. `layout: 'wide'` stacks them, which the
 * 880px-wide Settings cards need: squeezed into a 582px column their own text
 * would be scaled past readability.
 *
 * The image is fitted in JS, and the stage box is derived from the MEASURED
 * copy height while the stage is still collapsed to zero. Measuring the stage
 * instead would be circular — an unsized image lays out at its full 640x1310
 * natural size, so the stage would report "1310px available", the fit would
 * compute 1.0, and nothing would change.
 */
async function compose(puppet, { width, height, title, subtitle, shots, footNote, layout = 'side' }) {
  const page = await puppet.newPage();
  await page.setViewport({ width, height, deviceScaleFactor: 1 });

  const panels = shots
    .map((s) => `<figure class="shot"><img src="${s.uri}" alt=""></figure>`)
    .join('');

  const PAD_X = 60;
  const PAD_Y = 52;
  const GAP = 26;
  const wide = layout === 'wide';

  await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>
    * { box-sizing: border-box; }
    body { margin: 0; width: ${width}px; height: ${height}px; overflow: hidden;
           font: 15px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif; color: ${BRAND.fg};
           background:
             radial-gradient(1200px 700px at 6% -14%, #e8eaff 0%, transparent 58%),
             radial-gradient(900px 620px at 106% 110%, #e4efff 0%, transparent 55%),
             ${BRAND.bg};
           display: flex; flex-direction: column; padding: ${PAD_Y}px ${PAD_X}px; }
    .copy { flex: 0 0 auto; max-width: ${wide ? 'none' : '38ch'}; }
    .eyebrow { display: inline-block; font-size: 11.5px; font-weight: 650; letter-spacing: .10em;
               text-transform: uppercase; color: ${BRAND.accent}; background: #eceafe;
               border: 1px solid #ddd9fd; border-radius: 999px; padding: 4px 11px; margin-bottom: 14px; }
    h1 { margin: 0; font-size: ${wide ? '34px' : '38px'}; line-height: 1.1;
         letter-spacing: -0.026em; font-weight: 680; }
    .sub { margin: 12px 0 0; font-size: ${wide ? '15.5px' : '16.5px'}; color: ${BRAND.muted};
           max-width: ${wide ? '108ch' : '44ch'}; }
    .note { display: block; margin-top: 10px; font-size: 13px; color: #98a1b0; }
    .stage { flex: 0 0 auto; height: 0; overflow: hidden; margin-top: ${GAP}px;
             display: flex; align-items: center; justify-content: center; }
    .shot { margin: 0; line-height: 0; }
    .shot img { display: block; border-radius: 12px;
                box-shadow: 0 2px 4px rgba(16,24,40,.06), 0 26px 60px -18px rgba(16,24,40,.34); }
  </style></head><body>
    <div class="copy">
      <span class="eyebrow">Easy speech</span>
      <h1>${title}</h1>
      <p class="sub">${subtitle}</p>
      ${footNote ? `<span class="note">${footNote}</span>` : ''}
    </div>
    <div class="stage">${panels}</div>
  </body></html>`, { waitUntil: 'load' });

  await page.evaluate(() => Promise.all(
    Array.from(document.images).map((img) => (img.complete ? null : img.decode().catch(() => {})))
  ));

  const box = await page.evaluate((padY, gap, vh) => {
    const copy = document.querySelector('.copy');
    const stage = document.querySelector('.stage');
    stage.style.height = Math.max(0, vh - padY * 2 - copy.offsetHeight - gap) + 'px';
    return { w: stage.clientWidth, h: stage.clientHeight };
  }, PAD_Y, GAP, height);

  await page.evaluate((maxW, maxH) => {
    for (const img of document.querySelectorAll('.shot img')) {
      if (!img.naturalWidth) continue;
      const scale = Math.min(maxW / img.naturalWidth, maxH / img.naturalHeight, 1.5);
      img.style.width = Math.round(img.naturalWidth * scale) + 'px';
      img.style.height = Math.round(img.naturalHeight * scale) + 'px';
    }
  }, box.w, box.h);

  await sleep(250);
  const buffer = await page.screenshot({ type: 'png' });
  await page.close();
  return buffer;
}

/**
 * Screenshot one element of a page at its natural size.
 *
 * `state.hide` removes blocks before the shot. A Settings section can be 1500px
 * tall; fitted into an 800px canvas its own text shrinks past reading, so the
 * honest alternative is to show the part of the card the caption is about.
 */
async function capture(puppet, url, selector, state) {
  const page = await puppet.newPage();
  await page.evaluateOnNewDocument(installExtensionStubs, state);
  await page.setViewport({ width: 1280, height: 1400, deviceScaleFactor: 2 });
  await page.goto(url, { waitUntil: 'load' });
  await sleep(900);

  // Guard against the failure this harness already hit once: a stub that fails
  // to install leaves the page on its own defaults, which still *renders* and
  // would otherwise be screenshotted as if it were the requested state.
  if (state?.expect) {
    const body = (await page.evaluate(() => document.body?.innerText ?? '')).toLowerCase();
    // Case-insensitive on purpose: innerText reflects CSS text-transform, so an
    // uppercase-styled label reads back as "GOOGLE API KEY".
    const missing = state.expect.filter((t) => !body.includes(t.toLowerCase()));
    if (missing.length > 0) {
      throw new Error(`${url} did not render the requested state (missing ${JSON.stringify(missing)})`);
    }
  }

  const target = selector ? await page.$(selector) : null;
  const element = target ?? page;

  // Element screenshots capture whatever is PAINTED over the target's box, and
  // the Settings page has a sticky "Changes aren't saved / Save settings" bar.
  // Left in place it slices through the middle of every cropped card, so pin
  // anything sticky or fixed back into normal flow before the shot.
  await page.evaluate((spec) => {
    // Element screenshots capture whatever is PAINTED over the target's box, and
    // the Settings page has a sticky "Changes aren't saved / Save settings" bar.
    // Left in place it slices through the middle of every cropped card.
    for (const node of document.querySelectorAll('*')) {
      const position = getComputedStyle(node).position;
      if (position === 'sticky' || position === 'fixed') node.style.position = 'static';
    }
    for (const selector of spec?.hide ?? []) {
      for (const node of document.querySelectorAll(selector)) node.style.display = 'none';
    }
    // Trim a card down to the parts a caption is actually about: hide broadly,
    // then walk back up from what must survive and reveal every ancestor.
    // (`:nth-of-type` cannot select "the Nth .field" — it counts element type,
    // and `.howto` is a div too, so such a selector silently matches nothing.)
    const trim = spec?.trim;
    if (trim) {
      const container = document.querySelector(trim.container);
      for (const selector of trim.hide ?? []) {
        for (const node of container?.querySelectorAll(selector) ?? []) node.style.display = 'none';
      }
      for (const selector of trim.keep ?? []) {
        let node = container?.querySelector(selector);
        while (node && node !== container) {
          // Reveal the subtree as well as the node: the form's own `.field` is a
          // DESCENDANT of the form, so walking up alone would leave the form
          // empty and collapsed to nothing.
          node.style.display = '';
          for (const child of node.querySelectorAll('*')) child.style.display = '';
          node = node.parentElement;
        }
      }
    }
  }, { hide: state?.hide, trim: state?.trim });
  await sleep(120);

  const buffer = await element.screenshot({ type: 'png' });
  // A Page is not an ElementHandle and has no boundingBox(), so measure the
  // document directly when no selector narrowed the shot.
  const box = target
    ? await target.boundingBox()
    : await page.evaluate(() => {
        const el = document.body;
        return { width: el.scrollWidth, height: el.scrollHeight };
      });
  await page.close();
  return { uri: `data:image/png;base64,${buffer.toString('base64')}`, w: Math.round(box.width), h: Math.round(box.height) };
}

/* -------------------------------------------------------------------------
 * images
 * ---------------------------------------------------------------------- */

const saved = [];
function save(name, buffer) {
  writeFileSync(path.join(outDir, name), buffer);
  saved.push(name);
  console.log(`wrote store/${name}`);
}

const S = {
  listening: {
    state: 'listening',
    language: 'fa-IR',
    mode: 'cloud',
    modeNote: 'No on-device recognition for this language; using cloud (browser-managed) recognition.',
    availability: 'unavailable',
    sessionCount: 3,
    restartCount: 0,
    lastEvent: 'onresult',
    lastError: null,
    target: { kind: 'form-control', selector: '#box', connected: true },
    interimTranscript: PERSIAN_INTERIM,
    lastFinalTranscript: 'سلام، این یک متن آزمایشی است.',
    uncommittedTranscript: null,
    note: null,
    autoRestart: true,
    provider: 'voiceTyping',
  },
  ready: {
    state: 'idle', language: 'fa-IR', mode: 'cloud',
    modeNote: 'No on-device recognition for this language; using cloud (browser-managed) recognition.',
    availability: 'unavailable', sessionCount: 0, restartCount: 0, lastEvent: 'none',
    lastError: null, target: null, interimTranscript: '', lastFinalTranscript: '',
    uncommittedTranscript: null, note: null, autoRestart: true, provider: 'voiceTyping',
  },
};

const PREFS = {
  selectedLanguage: 'fa-IR',
  preferredEnglishMode: 'auto',
  autoRestart: true,
  showStatusIndicator: true,
  voiceCommands: true,
  numbersAsDigits: true,
  bookmarkedLanguages: ['fa-IR', 'en-US'],
  languageSwitchShortcut: { ctrlKey: true, key: 'j' },
  customCommands: [
    { phrase: 'امضا', replacement: '\n—\nعلی' },
    { phrase: 'phone', replacement: '217-652-8632' },
    { phrase: 'ایمیل من', replacement: 'you@example.com' },
  ],
  theme: 'light',
  dictationProvider: 'voiceTyping',
  geminiModel: 'gemini-3.5-transcribe',
  transcriptionLanguage: 'auto',
  transcriptionMode: 'verbatim',
  transcriptionVocabulary: ['Kubernetes', 'iPacket'],
};

mkdirSync(outDir, { recursive: true });

const session = await launch();
try {
  const base = `chrome-extension://${session.extensionId}`;

  // ---- 1. hero: the real content script dictating into a real field --------
  {
    const page = await session.puppet.newPage();
    await page.evaluateOnNewDocument((finalText, interimText) => {
      // Capture the content script's message listener so the generator can
      // drive it exactly as the popup would.
      const listeners = [];
      window.chrome = {
        runtime: {
          id: 'storeasset',
          onMessage: { addListener: (fn) => listeners.push(fn) },
          sendMessage: async () => ({ ok: true, configured: true }),
        },
        storage: {
          local: {
            get: async (key) => (key === 'prefs' ? { prefs: {
              selectedLanguage: 'fa-IR', voiceCommands: true, numbersAsDigits: false,
              showStatusIndicator: true, autoRestart: true, customCommands: [],
              bookmarkedLanguages: ['fa-IR', 'en-US'], preferredEnglishMode: 'auto',
              dictationProvider: 'voiceTyping',
            } } : {}),
            set: async () => {},
            remove: async () => {},
          },
        },
      };
      window.__vtDispatch = (message) =>
        new Promise((resolve) => listeners.forEach((fn) => fn(message, {}, resolve)));

      // A Web Speech API stand-in that emits one Persian utterance: an interim
      // result, then the final. The extension does the rest for real.
      class FakeRecognition {
        constructor() { this.lang = ''; this.continuous = false; this.interimResults = false; this.maxAlternatives = 1; }
        start() {
          this.onstart?.();
setTimeout(() => {
          // Shape matters: the engine reads results[i][0].transcript, so `results`
          // is a list of result-lists and each result-list carries isFinal.
          const result = (text, isFinal) => {
            const alternatives = [{ transcript: text, confidence: 0.94 }];
            alternatives.isFinal = isFinal;
            return alternatives;
          };
          this.onresult?.({ resultIndex: 0, results: [result(interimText, false)] });
          setTimeout(() => {
            this.onresult?.({ resultIndex: 0, results: [result(finalText, true)] });
          }, 500);
        }, 350);
        }
        stop() { setTimeout(() => this.onend?.(), 250); }
        abort() { this.onend?.(); }
      }
      window.SpeechRecognition = FakeRecognition;
      window.webkitSpeechRecognition = FakeRecognition;
    }, PERSIAN_FINAL, PERSIAN_INTERIM);

    await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
    await page.goto('data:text/html;charset=utf-8,' + encodeURIComponent(DEMO_PAGE), { waitUntil: 'load' });
    await page.addScriptTag({ path: path.join(dist, 'content', 'content.js') });
    await sleep(300);

    const started = await page.evaluate(async () => {
      const answer = await window.__vtDispatch({
        type: 'START_RECOGNITION', language: 'fa-IR', preferredMode: 'auto',
      });
      return answer;
    });
    if (!started?.ok) throw new Error('demo dictation did not start: ' + JSON.stringify(started));

    // Let the interim land, then screenshot while the final is being written,
    // so the caret and the committed prefix are both visible.
    await sleep(900);
    const value = await page.$eval('#box', (el) => el.value);
    if (!value || value.trim().length === 0) {
      throw new Error(`dictation produced no text (textarea=${JSON.stringify(value)})`);
    }
    await page.screenshot({ path: path.join(outDir, 'screenshot-1-dictation.png'), type: 'png' });
    saved.push('screenshot-1-dictation.png');
    console.log('wrote store/screenshot-1-dictation.png');
    await page.close();
  }

  // ---- 2. popup, mid-dictation -------------------------------------------
  {
    const shot = await capture(session.puppet, `${base}/popup/popup.html`, 'body', {
      prefs: PREFS,
      status: S.listening,
      expect: ['Listening', PERSIAN_INTERIM, 'Voice Typing'],
    });
    save('screenshot-2-popup.png', await compose(session.puppet, {
      width: 1280, height: 800,
      title: 'One click, then just talk.',
      subtitle: 'The popup reports the exact state of recognition — listening, what it has heard so far, and whether recognition is running on your device or in the cloud.',
      shots: [{ ...shot, caption: 'Live status and interim transcript' }],
      footNote: 'Easy speech works in any text field on any site. Voice Typing needs no account and no API key.',
    }));
  }

  // ---- 3-5. settings, one focused card each -------------------------------
  // Cropped to a single section rather than the whole page: the options page is
  // several thousand pixels tall, and scaled to fit 800px its own text would be
  // unreadable — which is the opposite of what a settings screenshot is for.
  const sections = [
    {
      file: 'screenshot-3-settings-dictation.png',
      selector: '#dictation',
      expect: ['Always type numbers as digits', 'Bookmarked languages'],
      title: 'Two languages, one keystroke.',
      subtitle: 'Bookmark the languages you use and switch between them with a shortcut — mid-sentence, without stopping.',
      footNote: 'On-device when Chrome can, cloud otherwise — reported honestly per language.',
    },
    {
      file: 'screenshot-4-settings-commands.png',
      selector: '#commands',
      expect: ['Custom voice commands', 'Add command'],
      title: 'Say the punctuation.',
      subtitle: 'Speak «ویرگول» or "comma" and the right mark is typed. Speak a number and it is written as a digit — «بیست و پنج» becomes 25.',
      footNote: 'Every command is yours to change, and you can add phrases of your own.',
    },
    {
      file: 'screenshot-5-settings-transcription.png',
      selector: '#transcription',
      // Keep only the credential block and the model field: the language, mode,
      // vocabulary, usage and saved-recording blocks belong to their own
      // captions and make this card unreadably tall.
      trim: {
        container: '#transcription',
        hide: ['.howto', '.field'],
        keep: ['#gemini-credential-form', '#gemini-model'],
      },
      expect: ['Google API key', 'Test key', 'Gemini model ID'],
      title: 'Bring your own key.',
      subtitle: 'Gemini mode talks to Google directly, using a key you create. Test it before you rely on it — a typo costs a click, not a lost recording.',
      footNote: 'No account, no server run by the author, nothing to sign up for beyond a Google key.',
    },
  ];

  for (const s of sections) {
    const shot = await capture(session.puppet, `${base}/options/options.html`, s.selector, {
      prefs: PREFS,
      status: S.ready,
      expect: s.expect,
      ...(s.trim ? { trim: s.trim } : {}),
    });
    save(s.file, await compose(session.puppet, {
      width: 1280, height: 800,
      layout: 'wide',
      title: s.title,
      subtitle: s.subtitle,
      shots: [shot],
      footNote: s.footNote,
    }));
  }

  // ---- promo tiles --------------------------------------------------------
  const iconUri = `data:image/png;base64,${readFileSync(path.join(dist, 'icons', 'icon128.png')).toString('base64')}`;

  async function tile(width, height, name, layout) {
    const page = await session.puppet.newPage();
    await page.setViewport({ width, height, deviceScaleFactor: 1 });
    const big = layout === 'marquee';
    await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>
      * { box-sizing: border-box; }
      body { margin: 0; width: ${width}px; height: ${height}px; overflow: hidden; color: #fff;
             font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
             background:
               radial-gradient(900px 600px at 8% 0%, #6d68f5 0%, transparent 58%),
               radial-gradient(800px 700px at 100% 100%, #2b6cf0 0%, transparent 60%),
               linear-gradient(135deg, #3b2fd6 0%, #2a1f9e 55%, #1b1470 100%);
             display: flex; ${big ? 'align-items: center; justify-content: space-between; padding: 0 76px;' : 'flex-direction: column; align-items: center; justify-content: center; padding: 30px;'} }
      .brand { display: flex; align-items: center; gap: ${big ? '22px' : '14px'}; }
      img { width: ${big ? '132px' : '78px'}; height: ${big ? '132px' : '78px'}; border-radius: ${big ? '28px' : '18px'};
            box-shadow: 0 10px 34px -8px rgba(0,0,0,.5); }
      .name { font-size: ${big ? '46px' : '27px'}; font-weight: 700; letter-spacing: -0.025em; margin: 0; }
      .tag { font-size: ${big ? '20px' : '14.5px'}; color: #dcdcfb; margin: ${big ? '12px 0 0' : '8px 0 0'}; text-align: ${big ? 'left' : 'center'}; max-width: ${big ? '30ch' : '26ch'}; }
      .langs { display: flex; gap: 10px; margin-top: ${big ? '0' : '20px'}; }
      .pill { font-size: ${big ? '17px' : '13px'}; font-weight: 600; padding: ${big ? '9px 20px' : '6px 14px'};
              border-radius: 999px; background: rgba(255,255,255,.14); border: 1px solid rgba(255,255,255,.26); }
    </style></head><body>
      <div>
        <div class="brand">
          <img src="${iconUri}" alt="">
          <div>
            <h1 class="name">Easy speech</h1>
            <p class="tag">Speak, and your words appear at the cursor — in 100+ languages.</p>
          </div>
        </div>
      </div>
      ${big ? '' : '<div class="langs"><span class="pill">فارسی</span><span class="pill">English</span></div>'}
    </body></html>`, { waitUntil: 'load' });
    await sleep(250);
    const buffer = await page.screenshot({ type: 'png' });
    await page.close();
    return buffer;
  }

  save('promo-small-440x280.png', await tile(440, 280, 'small', 'small'));
  save('promo-marquee-1400x560.png', await tile(1400, 560, 'marquee', 'marquee'));
} catch (error) {
  console.error('asset generation failed —', error?.message ?? String(error));
  process.exitCode = 1;
} finally {
  session.close();
}

console.log(`\n${saved.length} files written to store/`);
