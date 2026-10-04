/**
 * Packages dist/ as the Chrome Web Store upload artifact.
 *
 * The ZIP must contain the extension files at its ROOT (manifest.json next
 * to the zip's first level), built from the actual manifest version for the
 * filename. Uses bsdtar (ships with Windows 10+) which writes forward-slash
 * entry names; falls back to PowerShell's Compress-Archive.
 */
import { execSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dist = path.join(root, 'dist');

if (!existsSync(path.join(dist, 'manifest.json'))) {
  console.error('dist/manifest.json not found — run `npm run build` first.');
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(path.join(dist, 'manifest.json'), 'utf8'));
const out = path.join(root, `easy-speech-v${manifest.version}.zip`);
if (existsSync(out)) rmSync(out);

const entries = readdirSync(dist).map((name) => `"${name}"`).join(' ');

// On Windows, prefer System32's bsdtar explicitly: a GNU tar on PATH (e.g.
// Git Bash's) misreads the "E:\..." drive prefix as a remote host. bsdtar
// writes forward-slash entry names, which the store expects.
const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
const tar = process.platform === 'win32' ? path.join(systemRoot, 'System32', 'tar.exe') : 'tar';

try {
  // -C dist + top-level names → entries like "manifest.json", "popup/…".
  execSync(`"${tar}" -a -c -f "${out}" -C "${dist}" ${entries}`, { stdio: 'inherit' });
} catch {
  // Fallback for environments without bsdtar. Compress-Archive recurses into
  // subfolders for "dir\*" the same way.
  execSync(
    `powershell -NoProfile -ExecutionPolicy Bypass -Command` +
      ` "Compress-Archive -Path '${dist.replace(/'/g, "''")}\\*' -DestinationPath '${out.replace(/'/g, "''")}'"`,
    { stdio: 'inherit' }
  );
}

console.log(`Packaged ${out} (version ${manifest.version})`);
