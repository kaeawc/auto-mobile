import { beforeAll, describe, expect, test } from "bun:test";
import { logger, LogLevel } from "../../src/utils/logger";
import { cancellationTests, warmedTests } from "./interactionCancellation";

describe("warmedTests lifecycle", () => {
  let calls = 0;
  let resets = 0;
  let dirty = false;
  const previousLevel = logger.getLogLevel();
  const warmed = warmedTests(() => {
    dirty = false;
    resets++;
  });

  warmed("runs with clean state and the appropriate logger level", () => {
    expect(dirty).toBe(false);
    calls++;
    expect(logger.getLogLevel()).toBe(calls === 1 ? LogLevel.NONE : previousLevel);
    dirty = true;
  });

  beforeAll(() => {
    expect(calls).toBe(1);
    expect(resets).toBe(2);
    expect(dirty).toBe(false);
    expect(logger.getLogLevel()).toBe(previousLevel);
  });

  test("runs the scenario once more and resets after the real test", () => {
    expect(calls).toBe(2);
    expect(resets).toBe(3);
    expect(dirty).toBe(false);
    expect(cancellationTests).toBe(warmedTests);
  });
});

describe("warmedTests failures", () => {
  let calls = 0;
  let dirty = false;
  const warmed = warmedTests(() => {
    dirty = false;
  });

  warmed("swallows only the first call's failure and executes real assertions", () => {
    expect(dirty).toBe(false);
    dirty = true;
    calls++;
    if (calls === 1) {
      throw new Error("Expected warm-up failure");
    }
    expect(calls).toBe(2);
  });

  beforeAll(() => {
    expect(calls).toBe(1);
    expect(dirty).toBe(false);
  });

  test("the real run succeeded and its state was reset", () => {
    expect(calls).toBe(2);
    expect(dirty).toBe(false);
  });
});

describe("warmedTests.each", () => {
  const tuples: unknown[][] = [];
  const values: unknown[] = [];
  let dirty = false;
  const warmed = warmedTests(() => {
    dirty = false;
  });
  const value = { key: "single" };

  warmed.each([["tuple", 7]])("spreads %s %i", (label, count) => {
    expect(dirty).toBe(false);
    dirty = true;
    expect(label).toBe("tuple");
    expect(count).toBe(7);
    tuples.push([label, count]);
  });

  warmed.each([value])("passes %o as one value", (row) => {
    expect(dirty).toBe(false);
    dirty = true;
    expect(row).toBe(value);
    values.push(row);
  });

  beforeAll(() => {
    expect(tuples).toEqual([["tuple", 7]]);
    expect(values).toEqual([value]);
    expect(dirty).toBe(false);
  });

  test("both row shapes run identically during warm-up and measurement", () => {
    expect(tuples).toEqual([
      ["tuple", 7],
      ["tuple", 7],
    ]);
    expect(values).toEqual([value, value]);
    expect(dirty).toBe(false);
  });
});
