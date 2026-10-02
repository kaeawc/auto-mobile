import { afterEach, beforeAll, test as bunTest } from "bun:test";
import { logger, LogLevel } from "../../src/utils/logger";

/** Opt test scenarios into warm-up outside Bun's per-test timing budget. */
export function warmedTests(reset: () => void | Promise<void>) {
  type Scenario = () => void | Promise<unknown>;
  const scenarios: Scenario[] = [];
  beforeAll(async () => {
    const previousLevel = logger.getLogLevel();
    logger.setLogLevel(LogLevel.NONE);
    try {
      await reset();
      for (const scenario of scenarios) {
        try {
          await scenario();
        } catch {
          // Warm-up failures are deliberately ignored: the same callback and every
          // assertion run again as a real test, where failures must surface normally.
        } finally {
          await reset();
        }
      }
    } finally {
      logger.setLogLevel(previousLevel);
    }
  });
  // Reuse the suite's teardown between warm-ups and after every measured test.
  afterEach(async () => {
    await reset();
  });

  function test(name: string, scenario: Scenario, timeout?: number) {
    scenarios.push(scenario);
    bunTest(name, scenario, timeout);
  }
  // Let Bun retain test-name formatting and spread array rows in both runs.
  function each<const T extends readonly unknown[]>(
    cases: readonly T[],
  ): (name: string, scenario: (...args: T) => void | Promise<unknown>, timeout?: number) => void;
  function each<T>(
    cases: readonly T[],
  ): (name: string, scenario: (value: T) => void | Promise<unknown>, timeout?: number) => void;
  function each(cases: readonly unknown[]) {
    return (
      name: string,
      scenario: (...args: unknown[]) => void | Promise<unknown>,
      timeout?: number,
    ) => {
      for (const value of cases) {
        scenarios.push(() => scenario(...(Array.isArray(value) ? value : [value])));
      }
      bunTest.each(cases)(name, scenario, timeout);
    };
  }
  test.each = each;
  return test;
}
