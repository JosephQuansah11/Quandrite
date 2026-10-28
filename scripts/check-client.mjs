/**
 * Client grammar check.
 *
 * The client bundle is built with `noCheck: true` (see `tsconfig.build.json`): the
 * browser code is being migrated file by file, so it is emitted even while its own
 * types are still being filled in. The trouble with `noCheck` is that it skips
 * *grammar* as well as types - `await` in a function that is not `async` compiles
 * happily and then breaks the whole page in the browser, which is exactly what
 * happened once.
 *
 * So this runs the client through the checker with checking on, and fails only on
 * the errors that stop the bundle working (the `TS1xxx` family: syntax and
 * grammar). The remaining type errors are reported as a count, because they are
 * known debt rather than news.
 */

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tsc = path.join(rootDir, 'node_modules', 'typescript', 'bin', 'tsc');

let output = '';
try {
  output = execFileSync(process.execPath, [tsc, '-p', 'tsconfig.client.json', '--pretty', 'false'], {
    cwd: rootDir,
    encoding: 'utf8',
  });
} catch (error) {
  output = `${error.stdout || ''}${error.stderr || ''}`;
}

const errors = [];
for (const line of output.split(/\r?\n/)) {
  const match = line.match(/^(.*?)\((\d+),(\d+)\): error (TS\d+): (.*)$/);
  if (match) errors.push({ file: match[1], line: Number(match[2]), code: match[4], message: match[5] });
}

// The errors that produce a broken bundle: the grammar family (TS1xxx) plus the
// declaration clashes TypeScript reports as types (a duplicated `const` parses fine
// and then kills the whole page, which is exactly how this check earns its keep).
const FATAL = /^TS1\d{3}$|^TS2451$|^TS2300$/;
const fatal = errors.filter((error) => FATAL.test(error.code));
const typeErrors = errors.length - fatal.length;

if (fatal.length) {
  console.error('client grammar errors (these break the bundle):');
  for (const error of fatal) {
    console.error(`  ${error.file}(${error.line}): ${error.code}: ${error.message}`);
  }
  process.exit(1);
}

console.log(
  typeErrors
    ? `client parses cleanly (${typeErrors} known type note${typeErrors === 1 ? '' : 's'} in the migrated files)`
    : 'client parses cleanly, with no type notes',
);
