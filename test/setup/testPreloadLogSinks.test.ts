import { describe, expect, test } from "bun:test";
import { logger, LogLevel } from "../../src/utils/logger";
import { testOverrides } from "../../src/utils/testOverrides";
import { drainMicrotasks } from "../helpers/fakeTimerStepping";
import { useRealLogSinks } from "../helpers/realLogSinks";

const preloadOverride = testOverrides.logSinksDisabled;

test("the preload discards log records in a unit file", async () => {
  expect(testOverrides.logSinksDisabled?.()).toBe(true);
  const previousLevel = logger.getLogLevel();
  try {
    logger.setLogLevel(LogLevel.INFO);
    for (let i = 0; i < 500; i++) {
      logger.info(`preload discarded line ${i}`);
    }
    let settled = false;
    void logger.flush().then(() => {
      settled = true;
    });
    // trackWrite retains its promise chain: allow eight microtasks per discarded line.
    await drainMicrotasks(4_000);
    expect(settled).toBe(true);
  } finally {
    logger.setLogLevel(previousLevel);
  }
});

describe("real log sink scope", () => {
  useRealLogSinks();
  test("clears the override inside its scope", () => {
    expect(testOverrides.logSinksDisabled).toBeUndefined();
  });
});

test("restores the preload override for a later sibling", () => {
  expect(testOverrides.logSinksDisabled).toBe(preloadOverride);
  expect(testOverrides.logSinksDisabled?.()).toBe(true);
});
