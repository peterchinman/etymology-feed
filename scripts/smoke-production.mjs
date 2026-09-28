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
console.log('HTTPS, health, app shell, and both paired Bluffs passed.');
