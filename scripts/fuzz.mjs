// Longer invariant-fuzzing campaigns than `npm test` runs.
//
//   npm run fuzz                          # 10 seeds x 400 steps
//   FUZZ_SEEDS=50 FUZZ_STEPS=1000 npm run fuzz
//   FUZZ_FIRST_SEED=1001 npm run fuzz     # seeds not tried before
//   FUZZ_SEED=7 FUZZ_STEPS=1000 npm run fuzz   # replay one seed
//
// Prints how often each action succeeded, so thin coverage is visible, and
// exits non-zero with the seed and step when an invariant breaks.
import { fuzz } from '../test/fuzz.mjs';

const steps = Number(process.env.FUZZ_STEPS ?? 400);
const seeds = process.env.FUZZ_SEED
  ? [Number(process.env.FUZZ_SEED)]
  : Array.from({ length: Number(process.env.FUZZ_SEEDS ?? 10) }, (_, i) => i + Number(process.env.FUZZ_FIRST_SEED ?? 1));

const coverage = {};
let jobs = 0;
const started = Date.now();
for (const seed of seeds) {
  try {
    const stats = await fuzz({ seed, steps });
    jobs += stats.jobs;
    for (const [action, { ok, reverted }] of Object.entries(stats.byAction)) {
      coverage[action] ??= { succeeded: 0, reverted: 0 };
      coverage[action].succeeded += ok;
      coverage[action].reverted += reverted;
    }
    console.log(`seed ${seed}: ${stats.steps} steps, ${stats.jobs} jobs, invariants held`);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
console.log(`\n${seeds.length * steps} steps, ${jobs} jobs in ${Math.round((Date.now() - started) / 1000)} s; every invariant held.`);
console.table(coverage);
