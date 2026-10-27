/**
 * Client build.
 *
 * The server and the tests run the TypeScript sources directly (Node strips the
 * types), but a browser cannot - so the client and the shared modules are
 * compiled to `build/`, together with the static assets they are served with.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const buildDir = path.join(rootDir, 'build');

execFileSync(process.execPath, [path.join(rootDir, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.build.json'], {
  cwd: rootDir,
  stdio: 'inherit',
});

const assets = ['index.html', 'styles.css'];
fs.mkdirSync(path.join(buildDir, 'public'), { recursive: true });
for (const asset of assets) {
  fs.copyFileSync(path.join(rootDir, 'public', asset), path.join(buildDir, 'public', asset));
}

console.log(`built client -> ${path.relative(rootDir, buildDir)}/public (js + ${assets.join(', ')})`);
