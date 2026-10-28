/**
 * The client build.
 *
 * Vite owns everything the browser runs: `index.html` at the root, `src/` as the
 * app, `dist/` as the output the server serves. The `@shared` alias is how both the
 * browser and the server reach the modules they have in common - one file, no copy.
 */
import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const root = import.meta.dirname;
const api = process.env.QUANDRITE_API || 'http://127.0.0.1:8080';

export default defineConfig({
  root,
  // While the port is running the React app is served at `/next`, so that is where its
  // assets are asked for. It becomes `/` when it takes over the address from the
  // current client.
  base: '/next/',
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': path.resolve(root, 'shared'),
      '@': path.resolve(root, 'src'),
    },
  },
  build: { outDir: 'dist', emptyOutDir: true, target: 'es2022' },
  server: {
    port: 5173,
    // The studio needs a camera, and a browser only gives one to a secure origin:
    // https://localhost via `vite --https` (or the node server's own TLS) is the
    // way in. In development Vite serves the app and forwards the rest.
    proxy: {
      '/api': api,
      '/uploads': api,
      '/recordings': api,
      '/ws': { target: api.replace(/^http/, 'ws'), ws: true },
    },
  },
});
