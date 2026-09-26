import { spawn, spawnSync } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

const api = resolve(import.meta.dirname, '../../api');
const persist = resolve(api, '.wrangler/e2e');
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
const server = spawn(
  wrangler,
  ['dev', '--ip', '127.0.0.1', '--port', '8787', '--persist-to', persist],
  {
    cwd: api,
    stdio: 'inherit',
  },
);
process.on('SIGINT', () => server.kill('SIGINT'));
process.on('SIGTERM', () => server.kill('SIGTERM'));
server.on('exit', (code) => process.exit(code ?? 0));
