# Testing and CI

Run the cheapest relevant checks first:

```sh
npm run test:unit       # scoring, card eligibility, swipe math, text selection
npm run test:api        # real Workers runtime and local D1
npm run test:dictionary # source selection and dictionary construction
npm run test:e2e        # built app, local D1, mock OAuth, Chrome
```

Use Node 24. For browser tests, `node apps/web/scripts/ensure-browser.mjs`
checks the installed Chrome and installs it only if it cannot launch. Set
`ETYMOLOGY_E2E_PORT` when the default port is in use. Each port uses a separate
local D1 directory; none of these tests read the deployed database.

## Coverage and cost

- CI runs on Linux only: lint, type checks, all unit/API/data/release tests, the
  browser suite, and development/production Worker packaging checks.
- Linux Chrome does not provide native touch long-press selection, so the
  selection test exercises long-press only when run on a Mac. CI covers its
  double-tap selection and swipe suppression. Check long-press selection by hand
  on a real phone after changing gesture or selection code; desktop Chrome is not
  a substitute for iOS Safari or Android Chrome.
- PRs run App checks. A merge runs the same reusable checks through Deploy
  production before deployment; App checks does not also trigger on that push.
  Dictionary releases still check the exact main commit they will deploy.

Keep browser tests for saved data, offline reload/reconnection, account merging,
settings, and actual browser input behavior. Use fast unit tests for gesture and
selection algorithms. Avoid browser assertions about exact animation duration,
easing strings, decorative spacing, or development-only demos. Do not pin exact
colors, fonts, or pixel positions, and do not assert that removed UI stays absent.
Extend an existing browser test before adding a new one: each case pays for a fresh
page load. The existing swipe and selection unit tests are included in
`test:unit`, alongside shared tests.

The September 29 baseline ran 31 browser cases on each OS, twice per main merge
(standalone App checks and Deploy production). One successful PR run took 2m43s
on Linux and 3m06s on macOS; Chrome reinstallation alone took 34–38 seconds.
The cleanup runs 27 browser cases on Linux and one on macOS, once per main merge,
reuses a working installed Chrome, and seeds APP with one fixture statement.
On October 2 the macOS job and five decorative or duplicate browser cases were
removed, leaving 25 cases on Linux only. Before that change the Linux browser
step took about one minute and the whole suite about 40 seconds locally.

## Reliable fixtures

Browser tests start past the first-run welcome card: the Playwright config seeds
`etymology-welcome` in localStorage, and contexts created inside a test inherit it.
`welcome.spec.ts` clears it to start as a new visitor.

Use `putCardsOnStack` for a specific deck. It leaves the live Feed before replacing
IndexedDB, intercepts background feed requests, updates both saved state and the
display preview, then waits for the intended etymology to become interactive.
Do not write a fixture underneath a running feed or equate headwords with card IDs.
Wait for stored swipes, including their card IDs where identity matters, before
navigating away. Await `document.fonts.ready` before setting or measuring scroll
positions: a late web font reflows card text, and scroll anchoring then moves
`scrollTop` by a pixel or two.

Use `context.route` when a real service worker is involved: page routes do not
intercept its network requests. See [Playwright's service-worker routing guide](https://playwright.dev/docs/service-workers#network-events-and-routing).
Keep real service workers in offline tests. A focused test that explicitly blocks
them must not claim to cover offline shell caching.

Retries stay disabled. Failures retain a Playwright trace and screenshot under
`apps/web/test-results`; CI uploads these for seven days. Inspect the failing
action and stored state before rerunning or changing a timeout:

```sh
npx playwright show-trace path/to/trace.zip
```

One browser worker avoids collisions between tests sharing the local API and mock
sign-in account. Separate browser contexts isolate each test's cookies and storage.
Do not parallelize this suite without also isolating its server-side fixtures.
