import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Relative asset URLs so the build works under the GitHub Pages subpath (/clankworks/).
  base: './',
  server: { port: 5287, strictPort: true },
  build: { target: 'esnext' },
});
