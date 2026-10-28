/**
 * The legacy client build - temporary.
 *
 * The app is being moved to React page by page (see `vite.config.ts`, which builds
 * `src/` into `dist/`). Until that port is finished the current client still runs, and
 * this is what builds it: Vite instead of the old `tsc` script, so there is one
 * bundler in the project rather than two, and no `.mjs` scripts to run it.
 *
 * When the last page is ported, this file, `public/` and `build/` all go.
 */
import fs from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'vite';
import type { Plugin } from 'vite';

const root = import.meta.dirname;
const publicDir = path.resolve(root, 'public');

/** The client was written for Node's resolver, where `./x.js` means `./x.ts`. */
const typescriptExtensions = (): Plugin => ({
  name: 'typescript-extensions',
  resolveId(source, importer) {
    if (!importer || !source.endsWith('.js')) return null;
    // `/shared/x.js` is the shared module; `./x.js` is a neighbour of the importer.
    const base = source.startsWith('/shared/')
      ? path.resolve(root, source.slice(1))
      : path.resolve(path.dirname(importer), source);
    const beside = base.replace(/\.js$/, '.ts');
    if (fs.existsSync(beside)) return beside;
    // The engine modules have already moved to `src/lib`, where the React app imports
    // them from. The legacy client follows them there until it is gone.
    const moved = path.resolve(root, 'src', 'lib', path.basename(beside));
    return fs.existsSync(moved) ? moved : beside;
  },
});

export default defineConfig({
  // The legacy client's own directory is its root: that is where its `index.html`,
  // its stylesheet and its `/js/app.js` entry are.
  root: publicDir,
  plugins: [typescriptExtensions()],
  resolve: { alias: { '/shared': path.resolve(root, 'shared') } },
  build: {
    outDir: path.resolve(root, 'build', 'public'),
    emptyOutDir: true,
    target: 'es2022',
    rollupOptions: { input: path.join(publicDir, 'index.html') },
  },
  publicDir: false,
});
