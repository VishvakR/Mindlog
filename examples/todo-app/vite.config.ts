import { defineConfig } from 'vite';

// The app talks to Mindlog through the dev server, so the browser sees one origin.
export default defineConfig({
  server: { proxy: { '/api': process.env['MINDLOG_URL'] ?? 'http://127.0.0.1:8090' } },
});
