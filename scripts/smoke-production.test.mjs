import assert from 'node:assert/strict';
import test from 'node:test';
import { smoke } from './smoke-production.mjs';

function responses({ commit = 'new-commit', release = 'feed-new', count = 100, duplicate = false } = {}) {
  return async (url) => {
    const path = new URL(url).pathname;
    if (path === '/healthz') return Response.json({ appCommit: commit, dictRelease: release });
    if (path === '/api/words/bluff/etymologies') return Response.json({ cards: [
      { id: 'bluff', definition: 'pretend' }, { id: 'bluff::second', definition: 'steep bank' },
    ] });
    if (path === '/') return new Response('<html></html>', { headers: { 'Content-Type': 'text/html' } });
    return Response.json({ cards: Array.from({ length: count }, (_, i) => ({ id: duplicate ? 'same' : `card-${i}` })) });
  };
}

test('accepts a full feed from the expected deployment', async () => {
  await smoke('https://example.test', 'new-commit', 'feed-new', responses());
});

test('rejects healthy responses from an old app or dictionary', async () => {
  for (const options of [{ commit: 'old-commit' }, { release: 'feed-old' }]) {
    await assert.rejects(smoke('https://example.test', 'new-commit', 'feed-new', responses(options)), /Expected .* is live/);
  }
});

test('rejects incomplete or duplicate feeds after a switch', async () => {
  for (const options of [{ count: 10 }, { duplicate: true }]) {
    await assert.rejects(smoke('https://example.test', 'new-commit', 'feed-new', responses(options)));
  }
});
