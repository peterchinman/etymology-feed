import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const origin = process.argv[2];
assert(origin?.startsWith('https://'));
assert(process.env.RESTORE_TOKEN);
assert.equal((await fetch(`${origin}/healthz`)).status, 404);
assert.equal((await fetch(origin)).status, 404);
const cookies = new Map();
async function request(path, body) {
  const response = await fetch(`${origin}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: {
      'X-Restore-Token': process.env.RESTORE_TOKEN,
      'X-Requested-With': 'fetch',
      'Content-Type': 'application/json',
      Origin: origin,
      Cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join('; '),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  for (const cookie of response.headers.getSetCookie()) {
    const pair = cookie.split(';')[0];
    const equal = pair.indexOf('=');
    cookies.set(pair.slice(0, equal), pair.slice(equal + 1));
  }
  assert.equal(response.status, 200, `${path}: ${response.status}`);
  return response.json();
}
assert.equal((await request('/healthz')).status, 'ok');
const { cards } = await request('/api/feed?n=100');
assert.equal(cards.length, 100);
assert.equal(new Set(cards.map((card) => card.id)).size, 100);
const swipe = {
  id: randomUUID(),
  cardId: cards[0].id,
  verdict: 1,
  bucket: cards[0].bucket,
  shownAt: Date.now(),
  swipedAt: Date.now(),
};
await request('/api/sync', { swipes: [swipe] });
const likes = await request('/api/me/likes');
assert(
  JSON.stringify(likes).includes(cards[0].id),
  'Restored APP accepts and returns likes',
);
assert.deepEqual((await request('/api/me')).providers, []);
console.log(
  'Private restore Worker: access gate, feed, swipe, and saved like passed.',
);
