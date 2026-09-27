import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const remote = process.argv.includes('--remote');
const startArg = process.argv.find((arg) => arg.startsWith('--after='));
const budgetArg = process.argv.find((arg) => arg.startsWith('--write-budget='));
let after = Number(startArg?.split('=')[1] ?? 0);
const budget = Number(budgetArg?.split('=')[1] ?? 50_000);
if (
  !Number.isSafeInteger(after) ||
  after < 0 ||
  !Number.isSafeInteger(budget) ||
  budget < 300 ||
  budget > 80_000
)
  throw Error('Invalid --after or --write-budget.');
const wrangler = join(
  process.cwd(),
  '..',
  '..',
  'node_modules',
  '.bin',
  'wrangler',
);
const mode = remote ? '--remote' : '--local';
let written = 0;

function execute(binding, sql, file = false) {
  const args = [
    'd1',
    'execute',
    binding,
    mode,
    '--json',
    '-y',
    file ? '--file' : '--command',
    sql,
  ];
  const result = spawnSync(wrangler, args, {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.status !== 0) throw Error(result.stderr || result.stdout);
  const start = result.stdout.lastIndexOf('\n[');
  return JSON.parse(result.stdout.slice(start < 0 ? 0 : start + 1));
}
function quote(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

for (;;) {
  const query = execute(
    'DICT',
    `SELECT shuffle,id,prior FROM word WHERE shuffle>${after} ORDER BY shuffle LIMIT 100`,
  );
  const words = query[0]?.results ?? [];
  if (!words.length) break;
  // At most 100 rows per statement, as in the release import. The actual
  // rows_written counter, including index work, guards the free daily quota.
  const now = Date.now();
  const rows = words
    .map(
      // score = BASE_RATE for unrated rows (§6.2); prior orders the fresh lane.
      ({ id, prior }) => `(${quote(id)},0,0,${Number(prior)},0.5,${now})`,
    )
    .join(',');
  const sql = `INSERT INTO word_stats (card_id,likes,dislikes,prior,score,updated_at) VALUES ${rows} ON CONFLICT(card_id) DO NOTHING;`;
  const directory = mkdtempSync(join(tmpdir(), 'etymology-seed-'));
  const path = join(directory, 'seed.sql');
  try {
    writeFileSync(path, sql);
    const result = execute('APP', path, true);
    written += result[0]?.meta?.rows_written ?? 0;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  after = words.at(-1).shuffle;
  if (written >= budget - 300) break;
}
console.log(
  JSON.stringify({
    after,
    rowsWritten: written,
    resume: `--after=${after}`,
  }),
);
