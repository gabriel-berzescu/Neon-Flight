import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { existsSync, readdirSync } from 'node:fs';

// Every sandbox/*.html is a standalone dev page for one subsystem (terrain, aircraft, ...).
const sandboxDir = resolve(__dirname, 'sandbox');
const sandboxPages = existsSync(sandboxDir)
  ? Object.fromEntries(
      readdirSync(sandboxDir)
        .filter((f) => f.endsWith('.html'))
        .map((f) => [`sandbox/${f.replace('.html', '')}`, resolve(sandboxDir, f)]),
    )
  : {};

export default defineConfig({
  server: { host: '127.0.0.1', watch: { ignored: ['**/shots/**', '**/.cache/**'] } },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 4000,
    rollupOptions: { input: { main: resolve(__dirname, 'index.html'), ...sandboxPages } },
  },
  worker: { format: 'es' },
});
