import { createExecutionContext, env, SELF } from 'cloudflare:test';
import { expect, it } from 'vitest';
import restore from '../src/restore';

it('requires the restore token for both API requests and static assets', async () => {
  const bindings = {
    ...env,
    RESTORE_TOKEN: 'private-restore-token',
    ASSETS: { ...SELF, fetch: async () => new Response('private asset') },
  };
  for (const path of ['/healthz', '/api/words/bluff', '/']) {
    for (const token of ['', 'incorrect-token-value']) {
      const response = await restore.fetch(
        new Request(`https://restore.test${path}`, {
          headers: { 'X-Restore-Token': token },
        }),
        bindings,
        createExecutionContext(),
      );
      expect(response.status).toBe(404);
    }
  }
  const response = await restore.fetch(
    new Request('https://restore.test/healthz', {
      headers: { 'X-Restore-Token': bindings.RESTORE_TOKEN },
    }),
    bindings,
    createExecutionContext(),
  );
  expect(response.status).toBe(200);
  expect(((await response.json()) as { status: string }).status).toBe('ok');
  const asset = await restore.fetch(
    new Request('https://restore.test/', {
      headers: { 'X-Restore-Token': bindings.RESTORE_TOKEN },
    }),
    bindings,
    createExecutionContext(),
  );
  expect(await asset.text()).toBe('private asset');
});
