/**
 * Live smoke test: loads dist/ as an unpacked extension in a real Chromium
 * browser (Edge by default — branded Chrome 137+ removed --load-extension).
 *
 * Phase 1 (shipped artifact): the service worker boots, the popup/options
 * pages render without console errors, and the popup shows its friendly
 * error when the extension may not run on a page (activeTab not granted).
 *
 * Phase 2 (test double = dist + host permission for the local test server,
 * harness-only): drives the real runtime flow — on-demand content-script
 * injection, START_RECOGNITION, a live status transition, the
 * CYCLE_LANGUAGE round trip (content script is the single source of cycle
 * logic), and STOP_RECOGNITION — using a fake microphone.
 *
 * Usage: node scripts/smoke-test.mjs   (build first: npm run build)
 * Override the browser with the VT_BROWSER env var.
 */
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, readFileSync as rf, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dist = path.join(root, 'dist');
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

const workspace = mkdtempSync(path.join(tmpdir(), 'voice-type-smoke-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function report(ok, label, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok || !detail ? '' : ` — ${detail}`}`);
  if (!ok) failures++;
}

const TEST_PAGE = `<!doctype html><html><body>
<textarea id="box" rows="4" cols="40"></textarea>
<script>window.addEventListener('load', () => document.getElementById('box').focus());</script>
</body></html>`;

/** Launch a browser with an unpacked extension from `extensionDir`. */
async function launch(extensionDir) {
  const profile = mkdtempSync(path.join(workspace, 'profile-'));
  const proc = spawn(browserPath, [
    '--load-extension=' + extensionDir,
    '--disable-features=DisableLoadExtensionCommandLineSwitch',
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--no-first-run',
    '--no-default-browser-check',
    `--user-data-dir=${profile}`,
    '--remote-debugging-port=0',
    'about:blank',
  ], { stdio: 'ignore' });

  let port = null;
  for (let i = 0; i < 40 && !port; i++) {
    const file = path.join(profile, 'DevToolsActivePort');
    if (existsSync(file)) port = rf(file, 'utf8').split('\n')[0];
    else await sleep(500);
  }
  if (!port) {
    proc.kill();
    throw new Error('browser did not expose a DevTools port');
  }
  const puppet = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}` });
  await sleep(1500);
  const swTarget = puppet
    .targets()
    .find((t) => t.type() === 'service_worker' && t.url().endsWith('/background/service-worker.js'));
  const worker = swTarget ? await swTarget.worker() : null;
  const extensionId = swTarget ? new URL(swTarget.url()).host : null;
  return {
    puppet,
    worker,
    extensionId,
    close: () => {
      puppet.disconnect().catch(() => {});
      proc.kill();
      try { rmSync(profile, { recursive: true, force: true }); } catch {}
    },
  };
}

const TEST_SERVER_PORT_FIELD = 'testServerPort';

try {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(TEST_PAGE);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const testUrl = `http://127.0.0.1:${server.address().port}/`;

  // ---- Phase 1: the shipped dist ------------------------------------------
  {
    const session = await launch(dist);
    try {
      report(session.worker !== null, 'service worker booted', 'no background/service-worker.js target');

      async function checkPage(file, expectText) {
        const page = await session.puppet.newPage();
        const errors = [];
        page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
        page.on('pageerror', (err) => errors.push(String(err)));
        await page.goto(`chrome-extension://${session.extensionId}/${file}`, { waitUntil: 'load' });
        await sleep(400);
        const body = await page.evaluate(() => document.body?.innerText ?? '');
        const ok = expectText.every((t) => body.includes(t)) && errors.length === 0;
        report(ok, `${file} renders`, ok ? '' : `text=${JSON.stringify(body.slice(0, 120))} errors=${JSON.stringify(errors)}`);
        await page.close();
      }

      await checkPage('popup/popup.html', ['Start Listening', 'Status:']);
      await checkPage('options/options.html', ['Settings']);

      // Error path: opened as a normal tab, the popup cannot inject the
      // content script (activeTab is only granted on real gestures) and must
      // show the friendly explanation rather than failing silently.
      const popupTab = await session.puppet.newPage();
      await popupTab.goto(`chrome-extension://${session.extensionId}/popup/popup.html`, { waitUntil: 'load' });
      await sleep(600);
      const note = await popupTab.evaluate(() => document.getElementById('mode-note')?.textContent ?? '');
      report(
        note.includes('does not allow'),
        'popup explains when a page cannot be scripted',
        JSON.stringify(note.slice(0, 160))
      );
      await popupTab.close();
    } finally {
      session.close();
    }
  }

  // ---- Phase 2: test double with a harness-only host permission -----------
  {
    const doubleDir = path.join(workspace, 'double');
    cpSync(dist, doubleDir, { recursive: true });
    const manifest = JSON.parse(readFileSync(path.join(doubleDir, 'manifest.json'), 'utf8'));
    manifest.host_permissions = ['http://127.0.0.1/*'];
    writeFileSync(path.join(doubleDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

    const session = await launch(doubleDir);
    try {
      const worker = session.worker;
      report(worker !== null, 'test double service worker booted', 'no worker target');

      const page = await session.puppet.newPage();
      await page.goto(testUrl, { waitUntil: 'load' });

      // Inject on demand (host permission covers it) and poll GET_STATUS,
      // mirroring the extension's own ensureContentScript contract.
      const injected = await worker.evaluate(async (url) => {
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (!tab) return { ok: false, why: 'tab not found' };
        const answer = await chrome.tabs.sendMessage(tab.id, { type: 'GET_STATUS' }).catch(() => null);
        if (!answer) {
          await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content/content.js'] });
          for (let i = 0; i < 80; i++) {
            const status = await chrome.tabs.sendMessage(tab.id, { type: 'GET_STATUS' }).catch(() => null);
            if (status) return { ok: true, alreadyInjected: false };
            await new Promise((r) => setTimeout(r, 25));
          }
          return { ok: false, why: 'injected but never answered GET_STATUS' };
        }
        return { ok: true, alreadyInjected: true };
      }, testUrl).catch((error) => ({ ok: false, why: String(error) }));
      report(injected.ok, 'content script injects and answers GET_STATUS', JSON.stringify(injected).slice(0, 160));

      const sendToActiveTab = (message) =>
        worker.evaluate(async (msg) => {
          const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
          return chrome.tabs.sendMessage(tab.id, msg).catch((error) => ({ ok: false, why: String(error) }));
        }, message).catch((error) => ({ ok: false, why: String(error) }));

      const started = await sendToActiveTab({
        type: 'START_RECOGNITION',
        language: 'fa-IR',
        preferredMode: 'auto',
      });
      report(started?.ok === true, 'START_RECOGNITION accepted', JSON.stringify(started));

      // The recognition pipeline must leave idle (with a fake silent mic it
      // may listen, restart, or surface a recoverable/hard error — any live
      // state proves the session machinery runs).
      const seenStates = await (async () => {
        const observed = [];
        for (let i = 0; i < 26; i++) {
          const s = await sendToActiveTab({ type: 'GET_STATUS' });
          const state = s?.status?.state;
          if (state && state !== 'idle' && !observed.includes(state)) observed.push(state);
          if (observed.length > 0) break;
          await sleep(300);
        }
        return observed;
      })();
      report(seenStates.length > 0, 'recognition leaves idle state', JSON.stringify(seenStates));

      // CYCLE_LANGUAGE is handled entirely by the content script and must
      // alternate through the default bookmarks without double-advancing.
      const cycle = await worker.evaluate(async () => {
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        const first = await chrome.tabs.sendMessage(tab.id, { type: 'CYCLE_LANGUAGE' });
        const second = await chrome.tabs.sendMessage(tab.id, { type: 'CYCLE_LANGUAGE' });
        const { prefs } = await chrome.storage.local.get('prefs');
        return { first, second, persisted: prefs?.selectedLanguage };
      }).catch((error) => ({ why: String(error) }));
      const langs = [cycle.first?.language, cycle.second?.language];
      report(
        cycle.first?.ok === true && langs[0] === 'en-US' && langs[1] === 'fa-IR' && cycle.persisted === 'fa-IR',
        'CYCLE_LANGUAGE alternates fa-IR ⇄ en-US and persists',
        JSON.stringify(cycle)
      );

      // Each cycle hot-restarts a live session; let the restart settle
      // before stopping, or the in-flight start completes after the stop and
      // the session never appears idle.
      await sleep(1500);

      const stopped = await (async () => {
        const seen = [];
        await sendToActiveTab({ type: 'STOP_RECOGNITION' });
        for (let i = 0; i < 20; i++) {
          await sleep(150);
          const s = await sendToActiveTab({ type: 'GET_STATUS' });
          const state = s?.status?.state;
          if (state && !seen.includes(state)) seen.push(state);
          if (state === 'idle') return { ok: true, seen };
        }
        return { ok: false, why: 'never returned to idle', seen };
      })();
      report(stopped.ok, 'STOP_RECOGNITION returns to idle', JSON.stringify(stopped));

      await page.close();
    } finally {
      session.close();
    }
  }

  server.close();
} catch (error) {
  failures++;
  report(false, 'smoke test crashed', error?.message ?? String(error));
} finally {
  try { rmSync(workspace, { recursive: true, force: true }); } catch {}
}
console.log(failures === 0 ? 'SMOKE TEST PASSED' : `SMOKE TEST FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
