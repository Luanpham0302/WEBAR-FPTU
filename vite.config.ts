import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import basicSsl from '@vitejs/plugin-basic-ssl';

export default defineConfig({
  plugins: [react(), basicSsl()],
  optimizeDeps: {
    // Used only by tools/compile-targets.html. Listed here so the dev server
    // always has it ready; without this the page can hang on a stale cache.
    include: ['mind-ar/dist/mindar-image.prod.js'],
  },
});
