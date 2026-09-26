import { spawn, spawnSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const web = resolve(import.meta.dirname, '..');
const api = resolve(web, '../api');
const persist = resolve(api, '.wrangler/dev');
const bin = resolve(web, '../../node_modules/.bin');
const wrangler = resolve(bin, 'wrangler');
const astro = resolve(bin, 'astro');

// wrangler.toml serves ../web/dist as assets and refuses to start without it.
await mkdir(resolve(web, 'dist'), { recursive: true });
await mkdir(persist, { recursive: true });

function d1(args) {
  const result = spawnSync(
    wrangler,
    ['d1', 'execute', 'DICT', '--local', '--persist-to', persist, ...args],
    { cwd: api, encoding: 'utf8' },
  );
  if (result.status !== 0) {
    process.stderr.write(result.stdout + result.stderr);
    process.exit(result.status ?? 1);
  }
  return result.stdout;
}

const tables = JSON.parse(
  d1([
    '--json',
    '--command',
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'word'",
  ]),
);
if (tables[0].results.length === 0) {
  console.log('Seeding local D1 from fixtures/etymology-500.sql…');
  d1(['--file', 'fixtures/etymology-500.sql']);
}

const children = [
  spawn(
    wrangler,
    ['dev', '--ip', '127.0.0.1', '--port', '8787', '--persist-to', persist],
    { cwd: api, stdio: 'inherit' },
  ),
  // --ignore-lock stops Astro auto-backgrounding itself under coding agents,
  // which would look like an exit and tear down Wrangler.
  spawn(astro, ['dev', '--ignore-lock'], { cwd: web, stdio: 'inherit' }),
];

let exiting = false;
function shutdown(code) {
  if (exiting) return;
  exiting = true;
  for (const child of children) {
    if (child.exitCode === null) child.kill('SIGTERM');
  }
  process.exitCode = code;
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
for (const child of children) {
  child.on('exit', (code) => shutdown(code ?? 0));
}
