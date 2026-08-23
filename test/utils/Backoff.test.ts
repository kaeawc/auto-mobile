import { describe, expect, test } from "bun:test";
import {
  delayForAttempt,
  exponentialBackoff,
  fixedBackoff,
  sequenceBackoff,
} from "../../src/utils/Backoff";

describe("Backoff", function () {
  test("fixedBackoff returns the same delay for every attempt", function () {
    const policy = fixedBackoff(25);

    expect(policy.delayForAttempt(1)).toBe(25);
    expect(policy.delayForAttempt(4)).toBe(25);
  });

  test("sequenceBackoff clamps to the final configured delay", function () {
    const policy = sequenceBackoff([10, 20]);

    expect(policy.delayForAttempt(1)).toBe(10);
    expect(policy.delayForAttempt(2)).toBe(20);
    expect(policy.delayForAttempt(3)).toBe(20);
  });

  test("exponentialBackoff applies multiplier and cap", function () {
    const policy = exponentialBackoff({
      initialDelayMs: 50,
      multiplier: 3,
      maxDelayMs: 500,
    });

    expect(policy.delayForAttempt(1)).toBe(50);
    expect(policy.delayForAttempt(2)).toBe(150);
    expect(policy.delayForAttempt(3)).toBe(450);
    expect(policy.delayForAttempt(4)).toBe(500);
  });

  test("delayForAttempt accepts callback policies", function () {
    expect(delayForAttempt((attempt) => attempt * 7, 3)).toBe(21);
  });

  test("invalid attempts and delays throw clear errors", function () {
    expect(() => fixedBackoff(Number.POSITIVE_INFINITY)).toThrow(/finite/);
    expect(() => fixedBackoff(1).delayForAttempt(0)).toThrow(/positive integer/);
    expect(() => sequenceBackoff([])).toThrow(/at least one/);
    expect(() => exponentialBackoff({ initialDelayMs: 1, multiplier: 0 })).toThrow(/multiplier/);
  });

  test("normalizes fractional and negative delays via floor and zero-clamp", function () {
    expect(fixedBackoff(25.9).delayForAttempt(1)).toBe(25);
    expect(fixedBackoff(-10).delayForAttempt(1)).toBe(0);
  });

  test("exponentialBackoff defaults the multiplier to 2 when omitted", function () {
    const policy = exponentialBackoff({ initialDelayMs: 10 });
    expect(policy.delayForAttempt(1)).toBe(10);
    expect(policy.delayForAttempt(2)).toBe(20);
    expect(policy.delayForAttempt(3)).toBe(40);
  });

  test("exponentialBackoff treats multiplier=1 as a constant schedule", function () {
    const policy = exponentialBackoff({ initialDelayMs: 30, multiplier: 1 });
    expect(policy.delayForAttempt(1)).toBe(30);
    expect(policy.delayForAttempt(9)).toBe(30);
  });

  test("sequenceBackoff floor-normalizes and clamps its entries", function () {
    const policy = sequenceBackoff([10.7, -5]);
    expect(policy.delayForAttempt(1)).toBe(10);
    expect(policy.delayForAttempt(2)).toBe(0);
    expect(policy.delayForAttempt(50)).toBe(0);
  });

  test("delayForAttempt accepts a fixed number input", function () {
    expect(delayForAttempt(15, 4)).toBe(15);
  });

  test("delayForAttempt accepts an array input", function () {
    expect(delayForAttempt([5, 9], 2)).toBe(9);
    expect(delayForAttempt([5, 9], 7)).toBe(9);
  });

  test("rejects non-integer and non-positive attempts across policy types", function () {
    expect(() => fixedBackoff(1).delayForAttempt(1.5)).toThrow(/positive integer/);
    expect(() => exponentialBackoff({ initialDelayMs: 1 }).delayForAttempt(-2)).toThrow(
      /positive integer/,
    );
    expect(() => sequenceBackoff([1]).delayForAttempt(0)).toThrow(/positive integer/);
  });

  test("uncapped exponential backoff throws /finite/ once it overflows at a high attempt", function () {
    // With no maxDelayMs the cap is +Infinity, so a large attempt overflows the
    // exponential to Infinity and normalizeDelay rejects it rather than silently
    // returning a non-finite delay.
    const policy = exponentialBackoff({ initialDelayMs: 1, multiplier: 2 });
    expect(() => policy.delayForAttempt(1100)).toThrow(/finite/);
  });

  test("a capped exponential backoff stays finite at the same high attempt", function () {
    const policy = exponentialBackoff({ initialDelayMs: 1, multiplier: 2, maxDelayMs: 500 });
    expect(policy.delayForAttempt(1100)).toBe(500);
  });
});
