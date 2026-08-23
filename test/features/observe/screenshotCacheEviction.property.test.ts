import { describe, test } from "bun:test";
import fc from "fast-check";
import {
  selectScreenshotsToEvict,
  type ScreenshotCacheFile,
} from "../../../src/features/observe/screenshotCacheEviction";

// Property-based tests. See test/utils/Backoff.property.test.ts for the pinned-seed rationale.
const RUN_OPTIONS = { seed: 1_234_567, numRuns: 300 } as const;

const NOW_MS = 1_000_000_000;
// Each file is described by an age (so protection is exercised) and a size; the
// path index makes paths unique so eviction membership is unambiguous.
const rawFiles = fc
  .array(
    fc.record({
      ageMs: fc.integer({ min: 0, max: 200_000 }),
      size: fc.integer({ min: 0, max: 100_000 }),
    }),
    { maxLength: 30 },
  )
  .map((rs) =>
    rs.map((r, i): ScreenshotCacheFile => ({
      path: `s${i}`,
      size: r.size,
      mtimeMs: NOW_MS - r.ageMs,
    })),
  );

const maxSize = fc.integer({ min: 0, max: 3_000_000 });
const minAge = fc.integer({ min: 0, max: 200_000 });

const totalSize = (files: ScreenshotCacheFile[]): number => files.reduce((s, f) => s + f.size, 0);
const byPath = (files: ScreenshotCacheFile[]): Map<string, ScreenshotCacheFile> =>
  new Map(files.map((f) => [f.path, f]));

describe("selectScreenshotsToEvict (property-based)", () => {
  test("evicts nothing when the total is already within budget", () => {
    fc.assert(
      fc.property(rawFiles, maxSize, minAge, (files, max, min) => {
        return (
          totalSize(files) > max || selectScreenshotsToEvict(files, max, min, NOW_MS).length === 0
        );
      }),
      RUN_OPTIONS,
    );
  });

  test("every evicted path belongs to the input (subset)", () => {
    fc.assert(
      fc.property(rawFiles, maxSize, minAge, (files, max, min) => {
        const paths = new Set(files.map((f) => f.path));
        return selectScreenshotsToEvict(files, max, min, NOW_MS).every((p) => paths.has(p));
      }),
      RUN_OPTIONS,
    );
  });

  test("never evicts a file younger than minAgeMs (protection window)", () => {
    fc.assert(
      fc.property(rawFiles, maxSize, minAge, (files, max, min) => {
        const lookup = byPath(files);
        return selectScreenshotsToEvict(files, max, min, NOW_MS).every(
          (p) => NOW_MS - lookup.get(p)!.mtimeMs >= min,
        );
      }),
      RUN_OPTIONS,
    );
  });

  test("evicts oldest-first (evicted mtimes are non-decreasing)", () => {
    fc.assert(
      fc.property(rawFiles, maxSize, minAge, (files, max, min) => {
        const lookup = byPath(files);
        const mtimes = selectScreenshotsToEvict(files, max, min, NOW_MS).map(
          (p) => lookup.get(p)!.mtimeMs,
        );
        return mtimes.every((m, i) => i === 0 || mtimes[i - 1] <= m);
      }),
      RUN_OPTIONS,
    );
  });

  test("stops once within budget, or after evicting everything evictable", () => {
    fc.assert(
      fc.property(rawFiles, maxSize, minAge, (files, max, min) => {
        const lookup = byPath(files);
        const evicted = selectScreenshotsToEvict(files, max, min, NOW_MS);
        const evictedSize = evicted.reduce((s, p) => s + lookup.get(p)!.size, 0);
        const remaining = totalSize(files) - evictedSize;
        if (remaining <= max) {
          return true;
        }
        // Still over budget only because every evictable (old-enough) file is gone.
        const evictedSet = new Set(evicted);
        return files.filter((f) => NOW_MS - f.mtimeMs >= min).every((f) => evictedSet.has(f.path));
      }),
      RUN_OPTIONS,
    );
  });

  test("a larger budget evicts a prefix-subset of a smaller budget's selection (monotonic)", () => {
    fc.assert(
      fc.property(rawFiles, maxSize, maxSize, minAge, (files, a, b, min) => {
        const smaller = Math.min(a, b);
        const larger = Math.max(a, b);
        const evictedSmall = selectScreenshotsToEvict(files, smaller, min, NOW_MS);
        const evictedLarge = selectScreenshotsToEvict(files, larger, min, NOW_MS);
        // The larger-budget selection is a prefix of the smaller-budget one.
        return (
          evictedLarge.length <= evictedSmall.length &&
          evictedLarge.every((p, i) => p === evictedSmall[i])
        );
      }),
      RUN_OPTIONS,
    );
  });
});
