import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

// Hosted runners already provide Chrome. Check that it actually launches,
// including its system dependencies, before spending time reinstalling it.
try {
  const browser = await chromium.launch({ channel: 'chrome', timeout: 15_000 });
  console.log(`Using installed Chrome ${browser.version()}`);
  await browser.close();
} catch {
  console.log('Chrome is unavailable; installing it and its dependencies.');
  execFileSync(
    process.execPath,
    [
      fileURLToPath(
        new URL('../../../node_modules/playwright/cli.js', import.meta.url),
      ),
      'install',
      '--with-deps',
      'chrome',
    ],
    { stdio: 'inherit' },
  );
}
