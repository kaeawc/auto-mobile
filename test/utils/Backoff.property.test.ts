import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import {
  delayForAttempt,
  exponentialBackoff,
  fixedBackoff,
  sequenceBackoff,
} from "../../src/utils/Backoff";

// Property-based testing proof-of-concept.
//
// A pinned seed keeps CI deterministic — the same generated cases run every
// time — which matches the repo's reproducibility conventions (randomness is
// otherwise injected via `Random`). On failure fast-check prints the seed and
// the shrunk counterexample; bump `numRuns` locally to widen the search.
const RUN_OPTIONS = { seed: 1_234_567, numRuns: 300 } as const;

// Generators are bounded to the realistic operating range so exponential growth
// never overflows to Infinity/NaN (which `normalizeDelay` rejects by design).
// With multiplier <= 10 and attempt <= 20 the largest product is ~1e23, finite.
const attempt = fc.integer({ min: 1, max: 20 });
const delayMs = fc.integer({ min: 0, max: 10_000 });
const finiteDelayMs = fc.double({ min: 0, max: 10_000, noNaN: true });
const multiplier = fc.double({ min: 1, max: 10, noNaN: true });

const isNonNegativeInteger = (value: number): boolean => Number.isInteger(value) && value >= 0;

describe("Backoff (property-based)", () => {
  test("every policy yields a non-negative integer delay", () => {
    fc.assert(
      fc.property(delayMs, attempt, (ms, n) =>
        isNonNegativeInteger(fixedBackoff(ms).delayForAttempt(n)),
      ),
      RUN_OPTIONS,
    );
  });

  test("fixedBackoff is constant across attempts and floors the delay", () => {
    fc.assert(
      fc.property(finiteDelayMs, attempt, attempt, (ms, a, b) => {
        const policy = fixedBackoff(ms);
        const expected = Math.floor(ms);
        return policy.delayForAttempt(a) === expected && policy.delayForAttempt(b) === expected;
      }),
      RUN_OPTIONS,
    );
  });

  test("exponentialBackoff is monotonic non-decreasing and never exceeds the cap", () => {
    fc.assert(
      fc.property(delayMs, multiplier, delayMs, attempt, (initialDelayMs, mult, cap, n) => {
        const policy = exponentialBackoff({ initialDelayMs, multiplier: mult, maxDelayMs: cap });
        const capFloor = Math.floor(cap);

        const current = policy.delayForAttempt(n);
        const next = policy.delayForAttempt(n + 1);

        return isNonNegativeInteger(current) && current <= capFloor && next >= current;
      }),
      RUN_OPTIONS,
    );
  });

  test("exponentialBackoff first attempt equals the floored initial delay (uncapped)", () => {
    fc.assert(
      fc.property(delayMs, multiplier, (initialDelayMs, mult) => {
        const policy = exponentialBackoff({ initialDelayMs, multiplier: mult });
        return policy.delayForAttempt(1) === Math.floor(initialDelayMs);
      }),
      RUN_OPTIONS,
    );
  });

  test("sequenceBackoff clamps to the final delay for out-of-range attempts", () => {
    fc.assert(
      fc.property(
        fc.array(delayMs, { minLength: 1, maxLength: 8 }),
        fc.integer({ min: 0, max: 12 }),
        (delays, overshoot) => {
          const policy = sequenceBackoff(delays);
          const last = policy.delayForAttempt(delays.length);
          // Any attempt at or beyond the sequence length returns the final delay.
          return policy.delayForAttempt(delays.length + overshoot) === last;
        },
      ),
      RUN_OPTIONS,
    );
  });

  test("callback policies are normalized (floored, clamped to >= 0)", () => {
    fc.assert(
      fc.property(fc.double({ min: -10_000, max: 10_000, noNaN: true }), attempt, (raw, n) => {
        const result = delayForAttempt(() => raw, n);
        return result === Math.max(0, Math.floor(raw));
      }),
      RUN_OPTIONS,
    );
  });

  test("non-positive or non-integer attempts always throw", () => {
    const badAttempt = fc.oneof(
      fc.integer({ min: -50, max: 0 }),
      fc.double({ min: 0.01, max: 50, noNaN: true }).filter((n) => !Number.isInteger(n)),
    );
    fc.assert(
      fc.property(delayMs, badAttempt, (ms, n) => {
        expect(() => fixedBackoff(ms).delayForAttempt(n)).toThrow(/positive integer/);
        return true;
      }),
      RUN_OPTIONS,
    );
  });
});
