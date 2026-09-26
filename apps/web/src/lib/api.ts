import type { Card } from '@etymology-feed/shared/card';
import { hc } from 'hono/client';
import type { AppType } from '../../../api/src/index';

export async function fetchCards(): Promise<Card[]> {
  const client = hc<AppType>(window.location.origin);
  const response = await client.api.feed.$get({ query: { n: '100' } });
  if (!response.ok) throw new Error(`The feed returned ${response.status}.`);
  const result = await response.json();
  if (!('cards' in result)) throw new Error('The feed response has no cards.');
  return result.cards;
}
