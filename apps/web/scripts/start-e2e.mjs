import { spawn, spawnSync } from 'node:child_process';
import { createSign, generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve } from 'node:path';

const api = resolve(import.meta.dirname, '../../api');
const port = process.env.ETYMOLOGY_E2E_PORT ?? '8787';
const persist = resolve(api, `.wrangler/e2e-${port}`);
const oauthPort = String(Number(port) + 1);
const issuer = `http://127.0.0.1:${oauthPort}`;
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
const indexed = spawnSync(
  wrangler,
  [
    'd1',
    'execute',
    'DICT',
    '--local',
    '--persist-to',
    persist,
    '--file',
    'dictionary/search-index.sql',
  ],
  { cwd: api, encoding: 'utf8' },
);
if (indexed.status !== 0) {
  process.stderr.write(indexed.stdout + indexed.stderr);
  process.exit(indexed.status ?? 1);
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
// The small fixture fits in one SQL statement. Starting Wrangler for every
// hundred rows dominated local server setup time.
const rows = words
  .map(({ id, prior }) => `(${quote(id)},0,0,${Number(prior)},0.5,0)`)
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
const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
});
const keys = {
  keys: [
    {
      ...publicKey.export({ format: 'jwk' }),
      kid: 'e2e',
      alg: 'RS256',
      use: 'sig',
    },
  ],
};
const pendingCodes = new Map();
const reply = (response, status, body) => {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
};
const signToken = (nonce) => {
  const encode = (value) =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  const head = encode({ alg: 'RS256', typ: 'JWT', kid: 'e2e' });
  const payload = encode({
    iss: issuer,
    sub: 'test-account',
    aud: 'etymology-e2e',
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
    nonce,
    email: 'reader@example.test',
    email_verified: true,
    name: 'Test Reader',
  });
  const input = `${head}.${payload}`;
  const signature = createSign('RSA-SHA256')
    .update(input)
    .sign(privateKey)
    .toString('base64url');
  return `${input}.${signature}`;
};
const oauth = createServer(async (request, response) => {
  const url = new URL(request.url, issuer);
  if (url.pathname === '/.well-known/openid-configuration')
    return reply(response, 200, {
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      userinfo_endpoint: `${issuer}/userinfo`,
      jwks_uri: `${issuer}/jwks`,
      response_types_supported: ['code'],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['RS256'],
      scopes_supported: ['openid', 'email', 'profile'],
    });
  if (url.pathname === '/jwks') return reply(response, 200, keys);
  if (url.pathname === '/authorize') {
    const callback = new URL(url.searchParams.get('redirect_uri'));
    if (
      callback.origin !== `http://127.0.0.1:${port}` ||
      callback.pathname !== '/auth/callback/mock'
    )
      return reply(response, 400, { error: 'invalid_redirect_uri' });
    const code = randomUUID();
    pendingCodes.set(code, url.searchParams.get('nonce'));
    callback.searchParams.set('code', code);
    callback.searchParams.set('state', url.searchParams.get('state') ?? '');
    response.writeHead(302, { Location: callback.toString() });
    return response.end();
  }
  if (url.pathname === '/token' && request.method === 'POST') {
    let body = '';
    for await (const chunk of request) body += chunk;
    const code = new URLSearchParams(body).get('code');
    if (!code || !pendingCodes.has(code))
      return reply(response, 400, { error: 'invalid_grant' });
    const nonce = pendingCodes.get(code);
    pendingCodes.delete(code);
    return reply(response, 200, {
      access_token: 'mock-access',
      id_token: signToken(nonce),
      token_type: 'Bearer',
      expires_in: 3600,
    });
  }
  if (url.pathname === '/userinfo')
    return reply(response, 200, {
      sub: 'test-account',
      email: 'reader@example.test',
      email_verified: true,
      name: 'Test Reader',
    });
  return reply(response, 404, { error: 'not_found' });
});
await new Promise((resolve) =>
  oauth.listen(Number(oauthPort), '127.0.0.1', resolve),
);
const server = spawn(
  wrangler,
  [
    'dev',
    '--ip',
    '127.0.0.1',
    '--port',
    port,
    '--inspector-port',
    String(Number(port) + 2),
    '--persist-to',
    persist,
    '--var',
    `MOCK_OAUTH_ISSUER:${issuer}`,
    '--var',
    'BETTER_AUTH_SECRET:e2e-only-secret-at-least-thirty-two-characters',
    '--var',
    `BETTER_AUTH_URL:http://127.0.0.1:${port}`,
  ],
  {
    cwd: api,
    stdio: 'inherit',
  },
);
process.on('SIGINT', () => {
  server.kill('SIGINT');
  oauth.close();
});
process.on('SIGTERM', () => {
  server.kill('SIGTERM');
  oauth.close();
});
server.on('exit', (code) => {
  oauth.close();
  process.exit(code ?? 0);
});
