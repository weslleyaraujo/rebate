import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  // Relative base so the built site works on GitHub Pages under any path.
  base: './',
  plugins: [react(), tailwindcss()],
  build: {
    target: 'esnext',
  },
  worker: {
    format: 'es',
  },
  server: {
    // Allow the dev server to serve ../rebate/core.py (imported via ?raw).
    fs: {
      allow: ['..'],
    },
  },
});
