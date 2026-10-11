import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Kysely } from "kysely";
import type { Database } from "../../src/db/types";
import { createTestDatabase } from "../db/testDbHelper";
import { runSessionRowInterleaving } from "../helpers/sessionRowInvariantHarness";

// Small cases keep each test far inside the 100ms unit budget on a slow, contended CI runner.
const SEEDS_PER_CASE = 5;
const SWEEP_CASES = 40;

/**
 * Seeds whose interleaving left the row and the session apart before the #11557 fixes: a release
 * or a rebind that began while a live-row rewrite was in flight. They are tied to the generator in
 * `sessionRowInvariantHarness.ts`; pick new ones from a sweep when it changes.
 */
const REGRESSION_SEEDS = [
  122, 131, 155, 185, 275, 381, 562, 605, 747, 819, 838, 968, 1012, 1086, 1140,
];

// #11557: after any interleaving of activity writes, releases, rebinds, transient write failures,
// retries and a shutdown drain has settled, the persisted row is the session the manager holds.
describe("the persisted session row agrees with the session after any interleaving (#11557)", () => {
  let db: Kysely<Database>;

  beforeAll(async () => {
    db = await createTestDatabase();
    // Warm the statements and the modules, so the first case is not the one that pays for them.
    await runSessionRowInterleaving(db, 0);
  });

  afterAll(async () => {
    await db.destroy();
  });

  async function violationsOf(seeds: readonly number[]): Promise<string[]> {
    const broken: string[] = [];
    for (const seed of seeds) {
      const run = await runSessionRowInterleaving(db, seed);
      if (run.violations.length > 0) {
        broken.push([`seed ${seed}: ${run.violations.join("; ")}`, ...run.writes].join("\n    "));
      }
    }
    return broken;
  }

  const sweeps = Array.from({ length: SWEEP_CASES }, (_, index) => index * SEEDS_PER_CASE + 1);

  test.each(sweeps)("seeds %d and the next 4", async (first) => {
    const seeds = Array.from({ length: SEEDS_PER_CASE }, (_, index) => first + index);

    expect(await violationsOf(seeds)).toEqual([]);
  });

  const regressionChunks = Array.from(
    { length: Math.ceil(REGRESSION_SEEDS.length / SEEDS_PER_CASE) },
    (_, index) => REGRESSION_SEEDS.slice(index * SEEDS_PER_CASE, (index + 1) * SEEDS_PER_CASE),
  );

  test.each(regressionChunks)(
    "the interleavings that broke it before the fixes: %p",
    async (...seeds) => {
      expect(await violationsOf(seeds)).toEqual([]);
    },
  );
});
