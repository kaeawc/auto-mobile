import { describe, expect, test } from "bun:test";
import {
  delayForAttempt,
  exponentialBackoff,
  fixedBackoff,
  sequenceBackoff
} from "../../src/utils/Backoff";

describe("Backoff", function() {
  test("fixedBackoff returns the same delay for every attempt", function() {
    const policy = fixedBackoff(25);

    expect(policy.delayForAttempt(1)).toBe(25);
    expect(policy.delayForAttempt(4)).toBe(25);
  });

  test("sequenceBackoff clamps to the final configured delay", function() {
    const policy = sequenceBackoff([10, 20]);

    expect(policy.delayForAttempt(1)).toBe(10);
    expect(policy.delayForAttempt(2)).toBe(20);
    expect(policy.delayForAttempt(3)).toBe(20);
  });

  test("exponentialBackoff applies multiplier and cap", function() {
    const policy = exponentialBackoff({
      initialDelayMs: 50,
      multiplier: 3,
      maxDelayMs: 500
    });

    expect(policy.delayForAttempt(1)).toBe(50);
    expect(policy.delayForAttempt(2)).toBe(150);
    expect(policy.delayForAttempt(3)).toBe(450);
    expect(policy.delayForAttempt(4)).toBe(500);
  });

  test("delayForAttempt accepts callback policies", function() {
    expect(delayForAttempt(attempt => attempt * 7, 3)).toBe(21);
  });

  test("invalid attempts and delays throw clear errors", function() {
    expect(() => fixedBackoff(Number.POSITIVE_INFINITY)).toThrow(/finite/);
    expect(() => fixedBackoff(1).delayForAttempt(0)).toThrow(/positive integer/);
    expect(() => sequenceBackoff([])).toThrow(/at least one/);
    expect(() => exponentialBackoff({ initialDelayMs: 1, multiplier: 0 })).toThrow(/multiplier/);
  });
});
