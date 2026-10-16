import { beforeAll, expect, test } from "bun:test";
import { runSlotAgreement, type SlotAgreementRun } from "../helpers/sessionSlotAgreementHarness";

// Pinned to this generator: covers overlapping release, rebind, reissue and expiry windows.
const REGRESSION_SEEDS = [1, 7, 12, 27, 122, 238, 27666, 97677];
const SEEDS = [...new Set([...REGRESSION_SEEDS, ...Array.from({ length: 24 }, (_, i) => i + 1)])];
const results = new Map<number, SlotAgreementRun>();

beforeAll(async () => {
  for (const seed of SEEDS) {
    results.set(seed, await runSlotAgreement(seed));
  }
});

test.each(SEEDS)("real manager agrees at every checkpoint for seed %d", (seed) => {
  const result = results.get(seed)!;
  expect(result.violations).toEqual([]);
  expect(result.incarnations).toBeGreaterThanOrEqual(3);
});

test("seed corpus exercises each operation, forced removal, residue and real rehydration", () => {
  const observed = new Set([...results.values()].flatMap((run) => run.observed));
  for (const event of [
    "create",
    "rebind",
    "graceful",
    "force",
    "forced",
    "supersede",
    "reissue",
    "expiry",
    "shutdown",
    "restart",
    "rehydrated",
    "residue",
    "orphan-release",
  ]) {
    expect(observed.has(event)).toBe(true);
  }
});
