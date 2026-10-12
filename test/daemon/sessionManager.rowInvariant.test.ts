import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Kysely } from "kysely";
import type { Database } from "../../src/db/types";
import { createTestDatabase } from "../db/testDbHelper";
import {
  EXTENDED_OPERATIONS,
  runSessionRowInterleaving,
  type SessionRowRunOptions,
} from "../helpers/sessionRowInvariantHarness";

// Small cases keep each test far inside the 100ms unit budget on a slow, contended CI runner.
const SEEDS_PER_CASE = 2;
const SWEEP_CASES = 100;
const EXTENDED_SWEEP_CASES = 50;

/**
 * Seeds whose interleaving left the row and the session apart before the #11557 fixes: a release
 * or a rebind that began while a live-row rewrite was in flight. They are tied to the generator in
 * `sessionRowInvariantHarness.ts`; pick new ones from a sweep when it changes.
 */
const REGRESSION_SEEDS = [
  122, 131, 155, 185, 275, 381, 562, 605, 747, 819, 838, 968, 1012, 1086, 1140,
];

/**
 * Seeds of the second model (peers, re-issue, forced releases, failing release writes, restart)
 * that broke an invariant before its fixes, by what they left: an active row for a session a
 * failed non-terminal release had ended (rehydrated as a ghost); a superseded release's terminal
 * row over a session a non-terminal release or the shutdown handoff ended (the name refused for
 * good, the session not rehydrated); a rebind's live row over a forced release's. Tied to the
 * generator like the seeds above.
 */
const EXTENDED_REGRESSION_SEEDS = [
  [12, 238, 333, 438, 453, 505, 715, 906],
  [189, 259, 260, 281, 393, 402, 410, 635],
  [56, 853, 1074, 3197, 4052, 2158, 3848, 5257],
  // A parked superseded terminal write erased the peer's terminal row; a rebind revived it;
  // a parked terminal write released the active row the peer had re-issued (#11557, case 1).
  [27, 223, 2390],
  // A refused rebind's terminal adoption began its release after shutdown's drain (#11557).
  [14294],
  // Activity repair must settle its follow-up release inside the shutdown drain.
  [4024, 9103, 13761, 14856],
  // Failed creation and shutdown refusal restore the row they claimed.
  [9271, 17669, 15266, 19329],
];
const EXTENDED: SessionRowRunOptions = { allowed: EXTENDED_OPERATIONS };

/** The seeds in cases of at most `SEEDS_PER_CASE`, so no listed group outgrows a sweep case. */
function casesOf(seeds: readonly number[]): number[][] {
  return Array.from({ length: Math.ceil(seeds.length / SEEDS_PER_CASE) }, (_, index) =>
    seeds.slice(index * SEEDS_PER_CASE, (index + 1) * SEEDS_PER_CASE),
  );
}

async function violationsOf(
  db: Kysely<Database>,
  seeds: readonly number[],
  options?: SessionRowRunOptions,
): Promise<string[]> {
  const broken: string[] = [];
  for (const seed of seeds) {
    const run = await runSessionRowInterleaving(db, seed, options);
    if (run.violations.length > 0) {
      broken.push([`seed ${seed}: ${run.violations.join("; ")}`, ...run.writes].join("\n    "));
    }
  }
  return broken;
}

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

  const sweeps = Array.from({ length: SWEEP_CASES }, (_, index) => index * SEEDS_PER_CASE + 1);

  test.each(sweeps)("seeds %d and the next 1", async (first) => {
    const seeds = Array.from({ length: SEEDS_PER_CASE }, (_, index) => first + index);

    expect(await violationsOf(db, seeds)).toEqual([]);
  });

  test.each(casesOf(REGRESSION_SEEDS))(
    "the interleavings that broke it before the fixes: %p",
    async (...seeds) => {
      expect(await violationsOf(db, seeds)).toEqual([]);
    },
  );
});

// #11557: the same, with a second daemon writing the row, the name issued again after a release,
// releases forced at any point and release writes that keep failing; and after a shutdown at any
// point, the next daemon rehydrates exactly the session that was live and not terminally released.
describe("the row agrees with the session across peers, re-issue, forced releases and a restart (#11557)", () => {
  let db: Kysely<Database>;

  beforeAll(async () => {
    db = await createTestDatabase();
    await runSessionRowInterleaving(db, 0, EXTENDED);
  });

  afterAll(async () => {
    await db.destroy();
  });

  const sweeps = Array.from(
    { length: EXTENDED_SWEEP_CASES },
    (_, index) => index * SEEDS_PER_CASE + 1,
  );

  test.each(sweeps)("seeds %d and the next 1", async (first) => {
    const seeds = Array.from({ length: SEEDS_PER_CASE }, (_, index) => first + index);

    expect(await violationsOf(db, seeds, EXTENDED)).toEqual([]);
  });

  test.each(EXTENDED_REGRESSION_SEEDS.flatMap(casesOf))(
    "the interleavings that broke it before the fixes (%d, ...)",
    async (...seeds) => {
      expect(await violationsOf(db, seeds, EXTENDED)).toEqual([]);
    },
  );
});
