import assert from 'node:assert/strict';

const origin = process.argv[2];
assert(origin?.startsWith('https://'), 'Supply the deployed HTTPS origin');
const health = await fetch(`${origin}/healthz`);
assert.equal(health.status, 200, 'Health check');
const response = await fetch(`${origin}/api/words/bluff/etymologies`);
assert.equal(response.status, 200);
const { cards } = await response.json();
assert.equal(cards.length, 2, 'Both Bluff origins');
assert.equal(new Set(cards.map((card) => card.id)).size, 2);
assert.notEqual(cards[0].definition, cards[1].definition);
assert.equal((await fetch(origin)).status, 200, 'Static app shell');
// Exercise active DICT + shared APP + cached pools, not just dictionary lookup.
// This creates one anonymous session/served record; it does not submit ratings.
const feed = await fetch(`${origin}/api/feed?n=100`);
assert.equal(feed.status, 200, 'Feed check');
const batch = (await feed.json()).cards;
assert.equal(batch.length, 100, 'Complete feed after dictionary switch');
assert.equal(new Set(batch.map((card) => card.id)).size, 100);
console.log('HTTPS, health, app shell, both paired Bluffs, and a full feed passed.');
