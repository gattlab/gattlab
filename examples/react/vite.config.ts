import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => ({
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: './',
  plugins: [react()],
  build: {
    outDir: `dist/${mode}`,
    emptyOutDir: true,
    minify: mode === 'development' ? false : 'oxc',
    sourcemap: false,
  },
}));
