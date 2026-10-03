import type { Card } from '@etymology-feed/shared/card';
import { hc } from 'hono/client';
import type { AppType } from '../../../api/src/index';
import { ensureAnonymousSession } from './auth';
import { getServed, getSettings } from './local';

let pendingKnown: string[] | undefined;

function takeKnownChunk(): string[] {
  if (!pendingKnown?.length) return [];
  const chunk: string[] = [];
  let length = 2;
  while (pendingKnown.length) {
    const word = pendingKnown[0];
    const cost = encodeURIComponent(JSON.stringify(word)).length + 3;
    if (length + cost > 6000 && chunk.length) break;
    chunk.push(word);
    pendingKnown.shift();
    length += cost;
  }
  return chunk;
}

export async function fetchCards(): Promise<Card[]> {
  const newSession = await ensureAnonymousSession();
  if (newSession && pendingKnown === undefined)
    pendingKnown = (await getServed()).slice(-30_000);
  const client = hc<AppType>(window.location.origin);
  const { includeProperNouns } = await getSettings();
  const knownChunk = takeKnownChunk();
  const known = knownChunk.length ? JSON.stringify(knownChunk) : undefined;
  const response = await client.api.feed.$get({
    query: {
      n: '100',
      includeProperNouns: String(includeProperNouns) as 'true' | 'false',
      ...(known ? { known } : {}),
    },
  });
  if (!response.ok) {
    pendingKnown?.unshift(...knownChunk);
    throw new Error(`The feed returned ${response.status}.`);
  }
  const result = await response.json();
  if (!('cards' in result)) throw new Error('The feed response has no cards.');
  return result.cards;
}

/**
 * Ask which of the next waiting Feed cards the account already liked or
 * skipped on another device. `guest` means this device is not signed in, so it
 * has no other devices to hear from.
 */
export async function checkWaitingCards(
  cardIds: readonly string[],
): Promise<{ rated: string[]; guest: boolean }> {
  // Like every API call, start the guest session here rather than letting the
  // server mint one, so a lost cookie still sends the device's history.
  await ensureAnonymousSession();
  const response = await fetch('/api/me/rated', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Requested-With': 'fetch',
    },
    body: JSON.stringify({ cardIds }),
  });
  if (!response.ok)
    throw new Error(`Waiting-card check returned ${response.status}.`);
  return (await response.json()) as { rated: string[]; guest: boolean };
}
