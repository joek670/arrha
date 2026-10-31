// A short fuzz run on every `npm test`. `npm run fuzz` runs longer campaigns.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fuzz } from './fuzz.mjs';

for (const seed of [101, 202]) {
  test(`invariants hold through 150 random steps (seed ${seed})`, async () => {
    const stats = await fuzz({ seed, steps: 150 });
    assert.equal(stats.steps, 150);
    assert.ok(stats.jobs > 0, 'the run opened at least one job');
  });
}
