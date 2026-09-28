import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

export async function smoke(origin, commit, release, request = fetch) {
  assert(new URL(origin).protocol === 'https:', 'Supply the deployed HTTPS origin');
  assert(commit && release, 'Supply the expected app commit and dictionary release');
  const get = async (path) => {
    const response = await request(`${origin}${path}`, {
      cache: 'no-store', signal: AbortSignal.timeout(10_000),
    });
    assert.equal(response.status, 200, path);
    return response;
  };
  const health = await (await get('/healthz')).json();
  assert.equal(health.appCommit, commit, 'Expected app commit is live');
  assert.equal(health.dictRelease, release, 'Expected dictionary release is live');
  const { cards } = await (await get('/api/words/bluff/etymologies')).json();
  assert.equal(cards.length, 2, 'Both Bluff origins');
  assert.equal(new Set(cards.map((card) => card.id)).size, 2);
  assert.notEqual(cards[0].definition, cards[1].definition);
  const shell = await get('/');
  assert.match(shell.headers.get('content-type') ?? '', /text\/html/, 'Static app shell');
  // One anonymous session/served record; no ratings are submitted.
  const batch = (await (await get('/api/feed?n=100')).json()).cards;
  assert.equal(batch.length, 100, 'Complete feed after dictionary switch');
  assert.equal(new Set(batch.map((card) => card.id)).size, 100);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Allow the first custom-domain certificate and edge deployment to propagate.
  // Each attempt is bounded; persistent failures still trigger release recovery.
  for (let attempt = 1; ; attempt++) {
    try {
      await smoke(...process.argv.slice(2));
      console.log('Expected deployment, HTTPS, both Bluffs, and a full feed passed.');
      break;
    } catch (error) {
      if (attempt >= 12) throw error;
      console.log(`Deployment check ${attempt}/12 not ready; retrying in 5 seconds.`);
      await delay(5000);
    }
  }
}
