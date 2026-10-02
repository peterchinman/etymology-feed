import { test as base } from '@playwright/test';

export { expect, type Page } from '@playwright/test';

let contexts = 0;

/**
 * Local Wrangler stamps requests with the loopback address unless they already
 * carry CF-Connecting-IP, so the whole suite would share one bucket of new
 * anonymous sessions. Give each test its own private address. In production
 * Cloudflare sets this header itself, whatever the client sends.
 */
export const test = base.extend({
  extraHTTPHeaders: async ({ extraHTTPHeaders }, use, testInfo) => {
    contexts++;
    await use({
      ...extraHTTPHeaders,
      'CF-Connecting-IP': `10.${testInfo.workerIndex % 256}.${Math.floor(contexts / 256) % 256}.${contexts % 256}`,
    });
  },
});
