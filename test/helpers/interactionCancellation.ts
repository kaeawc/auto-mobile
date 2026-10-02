import { afterEach, beforeAll, beforeEach, spyOn } from "bun:test";
import { registerInteractionTools } from "../../src/server/interactionTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { logger, LogLevel } from "../../src/utils/logger";
import { FakeTimer } from "../fakes/FakeTimer";

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
