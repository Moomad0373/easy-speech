import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

const srcDir = fileURLToPath(new URL('./src', import.meta.url));
const outDir = fileURLToPath(new URL('./dist', import.meta.url));

/**
 * Content-script build: a single self-contained IIFE bundle so it can be
 * injected on demand with chrome.scripting.executeScript({ files: [...] }).
 * Runs AFTER the main build (emptyOutDir: false) so dist is not wiped.
 */
export default defineConfig({
  root: srcDir,
  base: './',
  publicDir: 'public',
  build: {
    outDir,
    emptyOutDir: false,
    rollupOptions: {
      input: {
        content: fileURLToPath(new URL('./src/content/content.ts', import.meta.url)),
      },
      output: {
        format: 'iife',
        entryFileNames: 'content/content.js',
        inlineDynamicImports: true,
      },
    },
  },
});
