import { spawn, spawnSync } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

const api = resolve(import.meta.dirname, '../../api');
const persist = resolve(api, '.wrangler/e2e');
const port = process.env.ETYMOLOGY_E2E_PORT ?? '8787';
const wrangler = resolve(
  import.meta.dirname,
  '../../../node_modules/.bin/wrangler',
);

await rm(persist, { recursive: true, force: true });
await mkdir(persist, { recursive: true });
const seed = spawnSync(
  wrangler,
  [
    'd1',
    'execute',
    'DICT',
    '--local',
    '--persist-to',
    persist,
    '--file',
    'fixtures/etymology-500.sql',
  ],
  { cwd: api, encoding: 'utf8' },
);
if (seed.status !== 0) {
  process.stderr.write(seed.stdout + seed.stderr);
  process.exit(seed.status ?? 1);
}
const migrated = spawnSync(
  wrangler,
  ['d1', 'migrations', 'apply', 'APP', '--local', '--persist-to', persist],
  { cwd: api, encoding: 'utf8' },
);
if (migrated.status !== 0) {
  process.stderr.write(migrated.stdout + migrated.stderr);
  process.exit(migrated.status ?? 1);
}
const wordsResult = spawnSync(
  wrangler,
  [
    'd1',
    'execute',
    'DICT',
    '--local',
    '--persist-to',
    persist,
    '--json',
    '--command',
    'SELECT id,prior FROM word',
  ],
  { cwd: api, encoding: 'utf8' },
);
if (wordsResult.status !== 0) {
  process.stderr.write(wordsResult.stdout + wordsResult.stderr);
  process.exit(wordsResult.status ?? 1);
}
const words = JSON.parse(wordsResult.stdout)[0].results;
const quote = (value) => `'${value.replaceAll("'", "''")}'`;
for (let i = 0; i < words.length; i += 100) {
  const rows = words
    .slice(i, i + 100)
    .map(
      ({ id, prior }) =>
        `(${quote(id)},0,0,${Number(prior)},${Number(prior)},0)`,
    )
    .join(',');
  const seeded = spawnSync(
    wrangler,
    [
      'd1',
      'execute',
      'APP',
      '--local',
      '--persist-to',
      persist,
      '--command',
      `INSERT INTO word_stats (card_id,likes,dislikes,prior,score,updated_at) VALUES ${rows}`,
    ],
    { cwd: api, encoding: 'utf8' },
  );
  if (seeded.status !== 0) {
    process.stderr.write(seeded.stdout + seeded.stderr);
    process.exit(seeded.status ?? 1);
  }
}
const server = spawn(
  wrangler,
  ['dev', '--ip', '127.0.0.1', '--port', port, '--persist-to', persist],
  {
    cwd: api,
    stdio: 'inherit',
  },
);
process.on('SIGINT', () => server.kill('SIGINT'));
process.on('SIGTERM', () => server.kill('SIGTERM'));
server.on('exit', (code) => process.exit(code ?? 0));
