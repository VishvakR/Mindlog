import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Built into the server package and served by adapter-http at /_/ (ADR-0023).
export default defineConfig({
  base: '/_/',
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  build: { outDir: '../packages/server/dashboard', emptyOutDir: true },
  server: {
    proxy: {
      '/api': { target: 'http://localhost:8090', ws: true },
      '/health': 'http://localhost:8090',
    },
  },
});
