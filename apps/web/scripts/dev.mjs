import { spawn, spawnSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const web = resolve(import.meta.dirname, '..');
const api = resolve(web, '../api');
const persist = resolve(api, '.wrangler/dev-v2');
const bin = resolve(web, '../../node_modules/.bin');
const wrangler = resolve(bin, 'wrangler');
const astro = resolve(bin, 'astro');

// wrangler.toml serves ../web/dist as assets and refuses to start without it.
await mkdir(resolve(web, 'dist'), { recursive: true });
await mkdir(persist, { recursive: true });

function d1(binding, args) {
  const result = spawnSync(
    wrangler,
    ['d1', 'execute', binding, '--local', '--persist-to', persist, ...args],
    { cwd: api, encoding: 'utf8' },
  );
  if (result.status !== 0) {
    process.stderr.write(result.stdout + result.stderr);
    process.exit(result.status ?? 1);
  }
  return result.stdout;
}

const tables = JSON.parse(
  d1('DICT', [
    '--json',
    '--command',
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'word'",
  ]),
);
if (tables[0].results.length === 0) {
  console.log('Seeding local D1 from fixtures/etymology-500.sql…');
  d1('DICT', ['--file', 'fixtures/etymology-500.sql']);
}

d1('DICT', ['--file', 'dictionary/search-index.sql']);

const migrated = spawnSync(
  wrangler,
  ['d1', 'migrations', 'apply', 'APP', '--local', '--persist-to', persist],
  { cwd: api, encoding: 'utf8' },
);
if (migrated.status !== 0) {
  process.stderr.write(migrated.stdout + migrated.stderr);
  process.exit(migrated.status ?? 1);
}
const statsCount = JSON.parse(
  d1('APP', [
    '--json',
    '--command',
    'SELECT COUNT(*) AS count FROM word_stats',
  ]),
)[0].results[0].count;
if (statsCount === 0) {
  console.log('Seeding local APP statistics from the card fixture…');
  const words = JSON.parse(
    d1('DICT', ['--json', '--command', 'SELECT id,prior FROM word']),
  )[0].results;
  const quote = (value) => `'${value.replaceAll("'", "''")}'`;
  for (let i = 0; i < words.length; i += 100) {
    const rows = words
      .slice(i, i + 100)
      .map(
        ({ id, prior }) =>
          `(${quote(id)},0,0,${Number(prior)},${Number(prior)},0)`,
      )
      .join(',');
    d1('APP', [
      '--command',
      `INSERT INTO word_stats (card_id,likes,dislikes,prior,score,updated_at) VALUES ${rows}`,
    ]);
  }
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
