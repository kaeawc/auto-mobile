import { beforeAll, describe, expect, test } from "bun:test";
import fc from "fast-check";
import { combineApkDigests } from "../../src/utils/ContentHashProvider";

// Property-based tests for the APK-digest combiner that gates APK-install cache
// invalidation. Its contract is order-independence ("sorted so split-APK ordering
// does not affect the result"): an order bug causes spurious cache hits/misses.
// See test/utils/Backoff.property.test.ts for the pinned-seed rationale.
const RUN_OPTIONS = { seed: 1_234_567, numRuns: 150 } as const;

/** A valid 64-char lowercase hex SHA-256 digest (matches the module's SHA256_HEX). */
const hexDigest = fc
  .array(fc.constantFrom(..."0123456789abcdef"), {
    minLength: 64,
    maxLength: 64,
  })
  .map((chars) => chars.join(""));

/** A path token with no whitespace (only the first token of a line is read). */
const pathToken = fc
  .array(fc.constantFrom(..."ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_./-"), {
    minLength: 1,
    maxLength: 32,
  })
  .map((chars) => chars.join(""));

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

describe("combineApkDigests (property-based)", () => {
  beforeAll(() => {
    // Keep one-off fast-check and SHA-256 initialization outside the first property.
    combineApkDigests("0".repeat(64) + "  /warmup.apk");
  });

  test("commutativity: output is invariant to input line order", () => {
    const arb = fc.array(validLine, { minLength: 1, maxLength: 8 }).chain((lines) =>
      fc
        .shuffledSubarray(lines, {
          minLength: lines.length,
          maxLength: lines.length,
        })
        .map((shuffled) => ({ lines, shuffled })),
    );
    fc.assert(
      fc.property(arb, ({ lines, shuffled }) => {
        const base = combineApkDigests(lines.join("\n"));
        expect(combineApkDigests(shuffled.join("\n"))).toBe(base);
      }),
      RUN_OPTIONS,
    );
  });

  test("edge cases: duplicates and maximum-size input preserve order independence", () => {
    const repeated = "a".repeat(64);
    const distinct = "b".repeat(64);
    const lines = [
      `${repeated}  /base.apk`,
      `${distinct}  /split_1.apk`,
      `${repeated}  /base.apk`,
      `${"c".repeat(64)}  /split_2.apk`,
      `${"d".repeat(64)}  /split_3.apk`,
      `${"e".repeat(64)}  /split_4.apk`,
      `${"f".repeat(64)}  /split_5.apk`,
      `${"0".repeat(64)}  /split_6.apk`,
    ];
    expect(combineApkDigests([...lines].reverse().join("\n"))).toBe(
      combineApkDigests(lines.join("\n")),
    );
  });

  test("garbage-line invariance: non-digest lines do not change the result", () => {
    // Generate a full-length shuffle so every valid/garbage line participates.
    const arb = fc
      .tuple(
        fc.array(validLine, { minLength: 1, maxLength: 6 }),
        fc.array(garbageLine, { maxLength: 6 }),
      )
      .chain(([valid, garbage]) =>
        fc
          .shuffledSubarray([...valid, ...garbage], {
            minLength: valid.length + garbage.length,
            maxLength: valid.length + garbage.length,
          })
          .map((mixed) => ({ valid, mixed })),
      );
    fc.assert(
      fc.property(arb, ({ valid, mixed }) => {
        const clean = combineApkDigests(valid.join("\n"));
        expect(combineApkDigests(mixed.join("\n"))).toBe(clean);
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
