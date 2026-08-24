import { describe, expect, test } from "bun:test";
import { createDaemonFatalProcessHandler } from "../../src/daemon/daemonFatalHandler";
import {
  ProcessLifecycleHandlers,
  type ProcessLifecycleEventMap,
  type ProcessLifecycleProcess,
} from "../../src/processLifecycle";

interface LoggedError {
  message: string;
  args: unknown[];
}

function makeFakeLogger(): {
  errors: LoggedError[];
  error: (message: string, ...args: unknown[]) => void;
} {
  const errors: LoggedError[] = [];
  return {
    errors,
    error: (message: string, ...args: unknown[]) => {
      errors.push({ message, args });
    },
  };
}

class FakeProcess implements ProcessLifecycleProcess {
  readonly listeners = new Map<keyof ProcessLifecycleEventMap, Array<(...args: any[]) => void>>();
  readonly exitCodes: number[] = [];

  on<K extends keyof ProcessLifecycleEventMap>(
    event: K,
    listener: (...args: ProcessLifecycleEventMap[K]) => void,
  ): unknown {
    const eventListeners = this.listeners.get(event) ?? [];
    eventListeners.push(listener);
    this.listeners.set(event, eventListeners);
    return this;
  }

  exit(code: number = 0): never {
    this.exitCodes.push(code);
    return undefined as never;
  }

  emit<K extends keyof ProcessLifecycleEventMap>(
    event: K,
    ...args: ProcessLifecycleEventMap[K]
  ): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(...args);
    }
  }
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("createDaemonFatalProcessHandler (unit)", () => {
  test("logs an uncaughtException with the stack and does not exit", () => {
    const logger = makeFakeLogger();
    const handler = createDaemonFatalProcessHandler(logger);
    const error = new Error("boom in child.on(data)");

    handler({ type: "uncaughtException", error });

    expect(logger.errors).toHaveLength(1);
    expect(logger.errors[0].message).toContain("uncaughtException");
    expect(logger.errors[0].message).toContain("keeping daemon alive");
    expect(logger.errors[0].message).toContain("boom in child.on(data)");
    // The caught error is forwarded as a structured arg for the log sink.
    expect(logger.errors[0].args[0]).toBe(error);
  });

  test("logs an unhandledRejection reason and does not exit", () => {
    const logger = makeFakeLogger();
    const handler = createDaemonFatalProcessHandler(logger);

    handler({
      type: "unhandledRejection",
      reason: "floating rejection",
      promise: Promise.resolve(),
    });

    expect(logger.errors).toHaveLength(1);
    expect(logger.errors[0].message).toContain("unhandledRejection");
    expect(logger.errors[0].message).toContain("floating rejection");
  });

  test("handles a non-Error uncaughtException value without throwing", () => {
    const logger = makeFakeLogger();
    const handler = createDaemonFatalProcessHandler(logger);

    // Node types this as Error, but a thrown non-Error can still reach here.
    handler({ type: "uncaughtException", error: "not-an-error" as unknown as Error });

    expect(logger.errors[0].message).toContain("not-an-error");
  });
});

describe("daemon fatal handler wired through ProcessLifecycleHandlers (integration)", () => {
  test("keeps the process alive on both fatal events once the daemon handler is bound", async () => {
    const fakeProcess = new FakeProcess();
    const logger = makeFakeLogger();
    const lifecycle = new ProcessLifecycleHandlers(fakeProcess);

    lifecycle.install();
    lifecycle.setFatalProcessHandler(createDaemonFatalProcessHandler(logger));

    fakeProcess.emit("uncaughtException", new Error("escaped throw"));
    fakeProcess.emit("unhandledRejection", "bad", Promise.resolve());
    await flushMicrotasks();

    // The regression this guards (#3408): the daemon must NOT exit on background failures.
    expect(fakeProcess.exitCodes).toEqual([]);
    expect(logger.errors.map((e) => e.message.includes("uncaughtException"))).toContain(true);
    expect(logger.errors.map((e) => e.message.includes("unhandledRejection"))).toContain(true);
  });
});
