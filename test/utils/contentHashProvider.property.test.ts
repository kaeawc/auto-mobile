import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { combineApkDigests } from "../../src/utils/ContentHashProvider";

// Property-based tests for the APK-digest combiner that gates APK-install cache
// invalidation. Its contract is order-independence ("sorted so split-APK ordering
// does not affect the result"): an order bug causes spurious cache hits/misses.
// See test/utils/Backoff.property.test.ts for the pinned-seed rationale.
const RUN_OPTIONS = { seed: 1_234_567, numRuns: 300 } as const;

/** A valid 64-char lowercase hex SHA-256 digest (matches the module's SHA256_HEX). */
const hexDigest = fc.stringMatching(/^[0-9a-f]{64}$/);

/** A path token with no whitespace (only the first token of a line is read). */
const pathToken = fc.stringMatching(/^[A-Za-z0-9_./-]+$/).filter((s) => s.length > 0);

/** One `sha256sum`-style line: `<digest>  <path>`. */
const validLine = fc.tuple(hexDigest, pathToken).map(([d, p]) => `${d}  ${p}`);

/** A line whose first token is NOT a valid digest, so the combiner must drop it. */
const garbageLine = fc.oneof(
  fc.constant("sha256sum: not found"),
  fc.constant("sha256sum: /data/app/base.apk: No such file or directory"),
  fc.stringMatching(/^[0-9a-f]{1,63}$/), // too short to be a digest
  fc.stringMatching(/^[g-zG-Z]{64}$/), // 64 chars but not hex
  fc.constant(""),
);

/** Reorder `items` by an independently generated key vector (a pseudo-permutation). */
function permuteBy<T>(items: T[], keys: number[]): T[] {
  return items
    .map((item, i) => ({ item, key: keys[i] }))
    .sort((a, b) => a.key - b.key)
    .map(({ item }) => item);
}

describe("combineApkDigests (property-based)", () => {
  test("commutativity: output is invariant to input line order", () => {
    const arb = fc.array(validLine, { minLength: 1, maxLength: 8 }).chain((lines) =>
      fc
        .array(fc.double({ noNaN: true, noDefaultInfinity: true }), {
          minLength: lines.length,
          maxLength: lines.length,
        })
        .map((keys) => ({ lines, keys })),
    );
    fc.assert(
      fc.property(arb, ({ lines, keys }) => {
        const base = combineApkDigests(lines.join("\n"));
        const shuffled = combineApkDigests(permuteBy(lines, keys).join("\n"));
        expect(shuffled).toBe(base);
      }),
      RUN_OPTIONS,
    );
  });

  test("garbage-line invariance: non-digest lines do not change the result", () => {
    const arb = fc.tuple(
      fc.array(validLine, { minLength: 1, maxLength: 6 }),
      fc.array(garbageLine, { maxLength: 6 }),
      fc.array(fc.double({ noNaN: true, noDefaultInfinity: true }), { maxLength: 12 }),
    );
    fc.assert(
      fc.property(arb, ([valid, garbage, keys]) => {
        const clean = combineApkDigests(valid.join("\n"));
        const mixed = permuteBy([...valid, ...garbage], keys).join("\n");
        expect(combineApkDigests(mixed)).toBe(clean);
      }),
      RUN_OPTIONS,
    );
  });

  test("empty: no valid digest yields the empty string", () => {
    const arb = fc.array(garbageLine, { maxLength: 8 });
    fc.assert(
      fc.property(arb, (garbage) => {
        expect(combineApkDigests(garbage.join("\n"))).toBe("");
      }),
      RUN_OPTIONS,
    );
    expect(combineApkDigests("")).toBe("");
  });

  test("determinism and shape: any valid input yields a stable 64-hex hash", () => {
    const arb = fc.array(validLine, { minLength: 1, maxLength: 8 });
    fc.assert(
      fc.property(arb, (lines) => {
        const stdout = lines.join("\n");
        const first = combineApkDigests(stdout);
        expect(combineApkDigests(stdout)).toBe(first);
        expect(first).toMatch(/^[0-9a-f]{64}$/);
      }),
      RUN_OPTIONS,
    );
  });
});
