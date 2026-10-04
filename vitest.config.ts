import { defineConfig } from 'vitest/config';

/**
 * Separate config so unit tests are NOT affected by the extension Vite
 * configs (which set root: "src"). Runs jsdom DOM tests + logic tests.
 */
export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.test.ts'],
  },
});
