import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Only unit-test the src modules; the Playwright specs in e2e/ use a
    // different runner (@playwright/test) and must not be picked up here.
    include: ['src/**/*.test.js'],
    environment: 'node',
  },
});
