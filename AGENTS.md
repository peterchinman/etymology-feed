# Agent guide

Read the doc for the area you are changing before you edit it:

- [docs/TESTING.md](docs/TESTING.md): commands, what each test layer covers, and
  browser fixture rules. Read it before adding or changing any test.
- [docs/SPEC.md](docs/SPEC.md): product behavior and architecture.
- [docs/DECISIONS.md](docs/DECISIONS.md): dated decision log. Append an entry
  for a decision a later change would need to know about.
- [docs/RUNBOOK.md](docs/RUNBOOK.md): production setup, releases, and restores.
- [database/README.md](database/README.md) and
  [docs/DATA_SELECTION.md](docs/DATA_SELECTION.md): the dictionary pipeline.

## Tests

Use Node 24. Run the cheapest relevant checks first; `npm run test:e2e`
rebuilds the web app and runs every browser test.

Browser tests are the slowest layer, and each case pays for a fresh page load.
Before adding one:

- Put pure logic, such as gesture math, formatting, and card eligibility, in a
  unit test instead.
- Extend an existing browser test that already reaches the same screen.
- Use the helpers in `apps/web/tests/helpers/` rather than inline IndexedDB code.

Do not write browser assertions that:

- pin colors, fonts, pixel positions, or other values that change with a restyle;
- check that removed UI stays absent;
- depend on exact animation timing.
