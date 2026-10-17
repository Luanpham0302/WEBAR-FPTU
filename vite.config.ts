import { existsSync } from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { securityHeadersPlugin } from './src/security/securityHeaders';

export default defineConfig({
  plugins: [
    react(),
    basicSsl(),
    // Writes dist/_headers (Netlify). Set CSP_MODE=enforce to enforce the CSP.
    securityHeadersPlugin({
      env: process.env,
      publicHeadersFileExists: existsSync('public/_headers'),
    }),
  ],
  optimizeDeps: {
    // Used only by tools/compile-targets.html. Listed here so the dev server
    // always has it ready; without this the page can hang on a stale cache.
    include: ['mind-ar/dist/mindar-image.prod.js'],
  },
});
