/**
 * Static wiring checks.
 *
 * These guard the seams that a browser-only bug would otherwise hide: module
 * imports, protocol constants, DOM ids referenced from the client, and the
 * overlay catalogue staying in step with the scene forms in the UI.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { CLIENT, SERVER, REQUESTABLE_SCENE_TYPES } from '../shared/protocol.js';
import { REQUESTABLE_OVERLAY_TYPES } from '../shared/overlays.js';

const rootDir = path.resolve(import.meta.dirname, '..');
const CLIENT_DIR = path.join(rootDir, 'public', 'js');
const HTML = fs.readFileSync(path.join(rootDir, 'public', 'index.html'), 'utf8');

function clientFiles() {
  return fs
    .readdirSync(CLIENT_DIR)
    .filter((file) => file.endsWith('.js'))
    .map((file) => path.join(CLIENT_DIR, file));
}

function moduleFiles() {
  const files = [];
  for (const dir of ['shared', 'server', 'public/js']) {
    for (const file of fs.readdirSync(path.join(rootDir, dir))) {
      if (file.endsWith('.js')) files.push(path.join(rootDir, dir, file));
    }
  }
  return files;
}

function exportedNames(file) {
  const source = fs.readFileSync(file, 'utf8');
  const names = new Set();
  for (const match of source.matchAll(
    /export\s+(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z0-9_$]+)/g,
  )) {
    names.add(match[1]);
  }
  for (const match of source.matchAll(/export\s*\{([^}]+)\}/g)) {
    for (const part of match[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop().trim();
      if (name) names.add(name);
    }
  }
  if (/export\s+default/.test(source)) names.add('default');
  return names;
}

test('every module import resolves to a real export', () => {
  const problems = [];
  for (const file of moduleFiles()) {
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(/import\s+([^;]+?)\s+from\s+'([^']+)'/g)) {
      const [, clause, specifier] = match;
      let target = null;
      if (specifier.startsWith('/shared/')) target = path.join(rootDir, specifier.slice(1));
      else if (specifier.startsWith('./') || specifier.startsWith('../')) {
        target = path.join(path.dirname(file), specifier);
      }
      if (!target) continue;

      if (!fs.existsSync(target)) {
        problems.push(`${path.relative(rootDir, file)} imports missing module ${specifier}`);
        continue;
      }

      const braces = /\{([^}]*)\}/.exec(clause);
      if (!braces) continue;
      const available = exportedNames(target);
      for (const part of braces[1].split(',')) {
        const name = part.trim().split(/\s+as\s+/)[0].trim();
        if (name && !available.has(name)) {
          problems.push(`${path.relative(rootDir, file)} imports '${name}' which ${specifier} does not export`);
        }
      }
    }
  }
  assert.deepEqual(problems, []);
});

test('the client only uses protocol constants the server defines', () => {
  const problems = [];
  for (const file of clientFiles()) {
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(/\b(CLIENT|SERVER)\.([A-Z_]+)\b/g)) {
      const table = match[1] === 'CLIENT' ? CLIENT : SERVER;
      if (!(match[2] in table)) {
        problems.push(`${path.basename(file)} uses ${match[1]}.${match[2]} which does not exist`);
      }
    }
  }
  assert.deepEqual(problems, []);
});

test('every DOM id the client reaches for exists in the page', () => {
  const ids = new Set([...HTML.matchAll(/id="([^"]+)"/g)].map((match) => match[1]));
  const problems = [];
  for (const file of clientFiles()) {
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(/\$\(['"]#([A-Za-z0-9_-]+)['"]\)/g)) {
      if (!ids.has(match[1])) problems.push(`${path.basename(file)} -> #${match[1]}`);
    }
    for (const match of source.matchAll(/getElementById\(['"]([A-Za-z0-9_-]+)['"]\)/g)) {
      if (!ids.has(match[1])) problems.push(`${path.basename(file)} -> #${match[1]}`);
    }
  }
  assert.deepEqual(problems, []);
});

test('the page loads assets that actually exist', () => {
  const assets = [...HTML.matchAll(/(?:src|href)="(\/[^"]+)"/g)].map((match) => match[1]);
  assert.ok(assets.length >= 2);
  for (const asset of assets) {
    assert.ok(fs.existsSync(path.join(rootDir, 'public', asset.replace(/^\//, ''))), `${asset} exists`);
  }
});

test('the scene form in the UI covers every overlay type', () => {
  const source = fs.readFileSync(path.join(CLIENT_DIR, 'app.js'), 'utf8');
  const block = /const SCENE_FIELDS = \{([\s\S]*?)\n\};/.exec(source);
  assert.ok(block, 'SCENE_FIELDS is declared in app.js');
  const keys = [...block[1].matchAll(/^\s{2}([a-z]+):\s*\[/gm)].map((match) => match[1]);
  assert.deepEqual(keys.sort(), [...REQUESTABLE_OVERLAY_TYPES].sort());
  assert.deepEqual([...REQUESTABLE_SCENE_TYPES].sort(), [...REQUESTABLE_OVERLAY_TYPES].sort());
});
