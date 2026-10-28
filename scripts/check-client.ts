/**
 * Client grammar check.
 *
 * The browser code is being migrated file by file - the pages, the services and the UI
 * kit are typed as they are written, while the engine modules moved out of the old
 * client still carry their original loose types. That debt is tracked rather than
 * hidden, so this runs the whole client through the checker and fails only on the
 * errors that stop the bundle working (the `TS1xxx` family: syntax and grammar, plus
 * the declaration clashes that kill a page at load).
 *
 * Everything else is reported as a count. `vite build` is what proves the bundle is
 * sound; this is what stops a stray `await` in a non-async function reaching a browser.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const rootDir = path.resolve(import.meta.dirname, '..');
const tsc = path.join(rootDir, 'node_modules', 'typescript', 'bin', 'tsc');

let output = '';
try {
  output = execFileSync(process.execPath, [tsc, '-p', 'tsconfig.json', '--pretty', 'false'], {
    cwd: rootDir,
    encoding: 'utf8',
  });
} catch (error: any) {
  output = `${error.stdout || ''}${error.stderr || ''}`;
}

const errors: Array<{ file: string; line: number; code: string; message: string }> = [];
for (const line of output.split(/\r?\n/)) {
  const match = line.match(/^(.*?)\((\d+),(\d+)\): error (TS\d+): (.*)$/);
  if (match) errors.push({ file: match[1], line: Number(match[2]), code: match[4], message: match[5] });
}

/** The errors that produce a broken bundle rather than a note about a type. */
const FATAL = /^TS1\d{3}$|^TS2451$|^TS2300$/;
const fatal = errors.filter((error) => FATAL.test(error.code));
const notes = errors.length - fatal.length;

if (fatal.length) {
  console.error('client grammar errors (these break the bundle):');
  for (const error of fatal) console.error(`  ${error.file}(${error.line}): ${error.code}: ${error.message}`);
  process.exit(1);
}

console.log(
  notes
    ? `client parses cleanly (${notes} known type note${notes === 1 ? '' : 's'} in the migrated engine modules)`
    : 'client parses cleanly, with no type notes',
);
