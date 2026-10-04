import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

const srcDir = fileURLToPath(new URL('./src', import.meta.url));
const outDir = fileURLToPath(new URL('./dist', import.meta.url));

/**
 * Main build: popup page + background service worker (ESM).
 * Static files (manifest.json, icons, test page) are copied from src/public.
 */
export default defineConfig({
  root: srcDir,
  base: './',
  publicDir: 'public',
  build: {
    outDir,
    emptyOutDir: true,
    rollupOptions: {
      input: {
        popup: fileURLToPath(new URL('./src/popup/popup.html', import.meta.url)),
        options: fileURLToPath(new URL('./src/options/options.html', import.meta.url)),
        'service-worker': fileURLToPath(new URL('./src/background/service-worker.ts', import.meta.url)),
      },
      output: {
        entryFileNames: (chunk) =>
          chunk.name === 'service-worker' ? 'background/service-worker.js' : 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
});
