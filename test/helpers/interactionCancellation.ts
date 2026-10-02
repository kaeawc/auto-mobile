import { afterEach, beforeAll, beforeEach, spyOn, test as bunTest } from "bun:test";
import { registerInteractionTools } from "../../src/server/interactionTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { logger, LogLevel } from "../../src/utils/logger";
import { FakeTimer } from "../fakes/FakeTimer";

/** Warm the exact fake-driven scenarios outside Bun's per-test timing budget. */
export function cancellationTests(reset: () => void) {
  type Scenario = () => void | Promise<unknown>;
  const scenarios: Scenario[] = [];
  beforeAll(async () => {
    const previousLevel = logger.getLogLevel();
    logger.setLogLevel(LogLevel.NONE);
    try {
      reset();
      for (const scenario of scenarios) {
        try {
          await scenario();
        } catch {
          // Warm-up failures are deliberately ignored: the same callback and every
          // assertion run again as a real test, where failures must surface normally.
        } finally {
          reset();
        }
      }
    } finally {
      logger.setLogLevel(previousLevel);
    }
  });
  // Reuse the suite's teardown between warm-ups and after every measured test.
  afterEach(reset);

  function test(name: string, scenario: Scenario, timeout?: number) {
    scenarios.push(scenario);
    bunTest(name, scenario, timeout);
  }
  // These suites use single-value tables; let Bun retain its test-name formatting.
  test.each = <T>(cases: readonly T[]) => {
    return (name: string, scenario: (value: T) => void | Promise<unknown>, timeout?: number) => {
      for (const value of cases) {
        scenarios.push(() => scenario(value));
      }
      bunTest.each(cases)(name, scenario, timeout);
    };
  };
  return test;
}

/** Register once, retaining real handler wiring even when another suite clears the registry. */
export function cancellationHandlers(names: readonly string[]) {
  type Handler = NonNullable<ReturnType<typeof ToolRegistry.getTool>>["deviceAwareHandler"];
  const handlers = new Map<string, NonNullable<Handler>>();
  beforeAll(() => {
    registerInteractionTools();
    for (const name of names) {
      const handler = ToolRegistry.getTool(name)?.deviceAwareHandler;
      if (!handler) {
        throw new Error(`Missing registered handler: ${name}`);
      }
      handlers.set(name, handler);
    }
    ToolRegistry.clearTools();
  });

  // Cancellation assertions do not inspect logs. Avoid real sink I/O and error-stack
  // formatting, restoring the previous level so other server suites retain their logging.
  let previousLevel = logger.getLogLevel();
  beforeEach(() => {
    previousLevel = logger.getLogLevel();
    logger.setLogLevel(LogLevel.NONE);
  });
  afterEach(() => logger.setLogLevel(previousLevel));
  return (name: string) => {
    const handler = handlers.get(name);
    if (!handler) {
      throw new Error(`Missing captured handler: ${name}`);
    }
    return handler;
  };
}

/** Notify at the first fake sleep without polling or scheduling a real event-loop turn. */
export function pausedSleep(timer: FakeTimer) {
  const started = Promise.withResolvers<void>();
  const sleep = spyOn(timer, "sleep").mockImplementation((ms) => {
    const pending = FakeTimer.prototype.sleep.call(timer, ms);
    started.resolve();
    return pending;
  });
  return { started: started.promise, sleep };
}

/** Observe entry to rotation cleanup before inspecting its still-held write. */
export function cleanupDeadline(timer: FakeTimer) {
  const started = Promise.withResolvers<void>();
  const setTimeout = spyOn(timer, "setTimeout").mockImplementation((callback, ms) => {
    const handle = FakeTimer.prototype.setTimeout.call(timer, callback, ms);
    started.resolve();
    return handle;
  });
  return { started: started.promise, setTimeout };
}
