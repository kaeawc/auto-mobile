import { describe, expect, spyOn, test } from "bun:test";
import {
  ProcessLifecycleHandlers,
  runAllCleanupOperations,
  type ProcessLifecycleEventMap,
  type ProcessLifecycleProcess,
} from "../src/processLifecycle";
import { FakeTimer } from "./fakes/FakeTimer";

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

  listenerCount(event: keyof ProcessLifecycleEventMap): number {
    return this.listeners.get(event)?.length ?? 0;
  }
}

type StdinEventMap = {
  end: [];
  error: [Error];
  close: [];
};

class FakeStdin {
  readonly listeners = new Map<keyof StdinEventMap, Array<(...args: any[]) => void>>();

  on<K extends keyof StdinEventMap>(event: K, listener: (...args: StdinEventMap[K]) => void): this {
    const eventListeners = this.listeners.get(event) ?? [];
    eventListeners.push(listener);
    this.listeners.set(event, eventListeners);
    return this;
  }

  emit<K extends keyof StdinEventMap>(event: K, ...args: StdinEventMap[K]): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(...args);
    }
  }

  listenerCount(event: keyof StdinEventMap): number {
    return this.listeners.get(event)?.length ?? 0;
  }
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("process lifecycle handlers", () => {
  test("installs each process listener only once", () => {
    const fakeProcess = new FakeProcess();
    const lifecycle = new ProcessLifecycleHandlers(fakeProcess);

    lifecycle.install();
    lifecycle.install();

    expect(fakeProcess.listenerCount("SIGINT")).toBe(1);
    expect(fakeProcess.listenerCount("SIGTERM")).toBe(1);
    expect(fakeProcess.listenerCount("uncaughtException")).toBe(1);
    expect(fakeProcess.listenerCount("unhandledRejection")).toBe(1);
  });

  test("exits cleanly when a startup signal arrives before cleanup is bound", async () => {
    const fakeProcess = new FakeProcess();
    const lifecycle = new ProcessLifecycleHandlers(fakeProcess);

    lifecycle.install();
    fakeProcess.emit("SIGINT");
    await flushMicrotasks();

    expect(fakeProcess.exitCodes).toEqual([0]);
  });

  test("awaits the bound shutdown handler before exiting", async () => {
    const fakeProcess = new FakeProcess();
    const lifecycle = new ProcessLifecycleHandlers(fakeProcess);
    const signals: string[] = [];
    let finishShutdown!: () => void;

    lifecycle.install();
    lifecycle.setShutdownHandler(async (signal) => {
      signals.push(signal);
      await new Promise<void>((resolve) => {
        finishShutdown = resolve;
      });
    });

    fakeProcess.emit("SIGTERM");
    await flushMicrotasks();

    expect(signals).toEqual(["SIGTERM"]);
    expect(fakeProcess.exitCodes).toEqual([]);

    finishShutdown();
    await flushMicrotasks();

    expect(fakeProcess.exitCodes).toEqual([0]);
  });

  test("ignores repeated signals while shutdown is already running", async () => {
    const fakeProcess = new FakeProcess();
    const lifecycle = new ProcessLifecycleHandlers(fakeProcess);
    const signals: string[] = [];
    let finishShutdown!: () => void;

    lifecycle.install();
    lifecycle.setShutdownHandler(async (signal) => {
      signals.push(signal);
      await new Promise<void>((resolve) => {
        finishShutdown = resolve;
      });
    });

    fakeProcess.emit("SIGINT");
    fakeProcess.emit("SIGTERM");
    await flushMicrotasks();

    expect(signals).toEqual(["SIGINT"]);

    finishShutdown();
    await flushMicrotasks();

    expect(fakeProcess.exitCodes).toEqual([0]);
  });

  test("exits with failure after shutdown cleanup reports an aggregate failure", async () => {
    const fakeProcess = new FakeProcess();
    const lifecycle = new ProcessLifecycleHandlers(fakeProcess);
    const consoleError = spyOn(console, "error").mockImplementation(() => {});

    try {
      lifecycle.install();
      lifecycle.setShutdownHandler(() => {
        throw new AggregateError([new Error("socket cleanup failed")], "cleanup failed");
      });

      fakeProcess.emit("SIGTERM");
      await flushMicrotasks();

      expect(fakeProcess.exitCodes).toEqual([1]);
    } finally {
      consoleError.mockRestore();
    }
  });

  test("closes active resources once before exiting when stdin closes", async () => {
    const fakeProcess = new FakeProcess();
    const fakeStdin = new FakeStdin();
    const lifecycle = new ProcessLifecycleHandlers(fakeProcess);
    const closedResources: string[] = [];
    let finishClosingProxy!: () => void;

    lifecycle.installStdinShutdownHandlers(fakeStdin);
    lifecycle.setShutdownHandler(async (reason) => {
      closedResources.push(reason);
      await new Promise<void>((resolve) => {
        finishClosingProxy = resolve;
      });
      closedResources.push("proxy");
    });

    fakeStdin.emit("close");
    fakeStdin.emit("end");
    fakeStdin.emit("error", new Error("EPIPE"));
    await flushMicrotasks();

    expect(closedResources).toEqual(["stdin"]);
    expect(fakeProcess.exitCodes).toEqual([]);

    finishClosingProxy();
    await flushMicrotasks();

    expect(closedResources).toEqual(["stdin", "proxy"]);
    expect(fakeProcess.exitCodes).toEqual([0]);
  });

  test("exits when stdin cleanup exceeds the shutdown timeout", async () => {
    const fakeProcess = new FakeProcess();
    const fakeStdin = new FakeStdin();
    const timer = new FakeTimer();
    const lifecycle = new ProcessLifecycleHandlers(fakeProcess, timer, 50);
    const consoleError = spyOn(console, "error").mockImplementation(() => {});
    const timeoutFinalizers: string[] = [];

    try {
      lifecycle.installStdinShutdownHandlers(fakeStdin);
      lifecycle.setShutdownHandler(
        async () => await new Promise<void>(() => {}),
        () => {
          timeoutFinalizers.push("logger");
        },
      );

      fakeStdin.emit("close");
      await flushMicrotasks();
      expect(fakeProcess.exitCodes).toEqual([]);

      timer.advanceTime(50);
      await flushMicrotasks();

      expect(fakeProcess.exitCodes).toEqual([1]);
      expect(timeoutFinalizers).toEqual(["logger"]);
    } finally {
      consoleError.mockRestore();
    }
  });

  test("exits with failure when a cleanup fails before stdin shutdown times out", async () => {
    const fakeProcess = new FakeProcess();
    const fakeStdin = new FakeStdin();
    const timer = new FakeTimer();
    const lifecycle = new ProcessLifecycleHandlers(fakeProcess, timer, 50);
    const consoleError = spyOn(console, "error").mockImplementation(() => {});
    let cleanupFailed = false;

    try {
      lifecycle.installStdinShutdownHandlers(fakeStdin);
      lifecycle.setShutdownHandler(
        async () => {
          await runAllCleanupOperations(
            [
              () => {
                throw new Error("first cleanup failed");
              },
              () => new Promise<void>(() => {}),
            ],
            () => {
              cleanupFailed = true;
            },
          );
        },
        () => (cleanupFailed ? { exitCode: 1 } : undefined),
      );

      fakeStdin.emit("close");
      await flushMicrotasks();
      timer.advanceTime(50);
      await flushMicrotasks();

      expect(cleanupFailed).toBe(true);
      expect(fakeProcess.exitCodes).toEqual([1]);
    } finally {
      consoleError.mockRestore();
    }
  });

  test("exits when timeout finalization exceeds its bound", async () => {
    const fakeProcess = new FakeProcess();
    const fakeStdin = new FakeStdin();
    const timer = new FakeTimer();
    const lifecycle = new ProcessLifecycleHandlers(fakeProcess, timer, 50);
    const consoleError = spyOn(console, "error").mockImplementation(() => {});

    try {
      lifecycle.installStdinShutdownHandlers(fakeStdin);
      lifecycle.setShutdownHandler(
        async () => await new Promise<void>(() => {}),
        async () => await new Promise<void>(() => {}),
      );

      fakeStdin.emit("close");
      await flushMicrotasks();
      timer.advanceTime(50);
      await flushMicrotasks();
      expect(fakeProcess.exitCodes).toEqual([]);

      timer.advanceTime(50);
      await flushMicrotasks();
      expect(fakeProcess.exitCodes).toEqual([1]);
    } finally {
      consoleError.mockRestore();
    }
  });

  test("does not time out signal cleanup", async () => {
    const fakeProcess = new FakeProcess();
    const timer = new FakeTimer();
    const lifecycle = new ProcessLifecycleHandlers(fakeProcess, timer, 50);
    let finishShutdown!: () => void;

    lifecycle.install();
    lifecycle.setShutdownHandler(async () => {
      await new Promise<void>((resolve) => {
        finishShutdown = resolve;
      });
    });

    fakeProcess.emit("SIGTERM");
    await flushMicrotasks();
    timer.advanceTime(50);
    await flushMicrotasks();

    expect(fakeProcess.exitCodes).toEqual([]);

    finishShutdown();
    await flushMicrotasks();

    expect(fakeProcess.exitCodes).toEqual([0]);
  });

  test("uses the stdin timeout when stdin closes during signal cleanup", async () => {
    const fakeProcess = new FakeProcess();
    const fakeStdin = new FakeStdin();
    const timer = new FakeTimer();
    const lifecycle = new ProcessLifecycleHandlers(fakeProcess, timer, 50);
    const consoleError = spyOn(console, "error").mockImplementation(() => {});

    try {
      lifecycle.install();
      lifecycle.installStdinShutdownHandlers(fakeStdin);
      lifecycle.setShutdownHandler(async () => await new Promise<void>(() => {}));

      fakeProcess.emit("SIGTERM");
      await flushMicrotasks();
      fakeStdin.emit("close");
      timer.advanceTime(50);
      await flushMicrotasks();

      expect(fakeProcess.exitCodes).toEqual([1]);
    } finally {
      consoleError.mockRestore();
    }
  });

  test("attempts every cleanup operation when one fails", async () => {
    const cleaned: string[] = [];

    await expect(
      runAllCleanupOperations([
        () => {
          cleaned.push("video");
          throw new Error("video cleanup failed");
        },
        async () => {
          cleaned.push("proxy");
        },
      ]),
    ).rejects.toThrow("One or more shutdown cleanup operations failed");

    expect(cleaned).toEqual(["video", "proxy"]);
  });

  test("installs each stdin shutdown listener only once", () => {
    const fakeProcess = new FakeProcess();
    const fakeStdin = new FakeStdin();
    const lifecycle = new ProcessLifecycleHandlers(fakeProcess);

    lifecycle.installStdinShutdownHandlers(fakeStdin);
    lifecycle.installStdinShutdownHandlers(fakeStdin);

    expect(fakeStdin.listenerCount("end")).toBe(1);
    expect(fakeStdin.listenerCount("error")).toBe(1);
    expect(fakeStdin.listenerCount("close")).toBe(1);
  });

  test("delegates fatal process events without forcing an exit", async () => {
    const fakeProcess = new FakeProcess();
    const lifecycle = new ProcessLifecycleHandlers(fakeProcess);
    const events: string[] = [];
    const promise = Promise.resolve();

    lifecycle.install();
    lifecycle.setFatalProcessHandler((event) => {
      events.push(event.type);
    });

    fakeProcess.emit("uncaughtException", new Error("boom"));
    fakeProcess.emit("unhandledRejection", "bad", promise);
    await flushMicrotasks();

    expect(events).toEqual(["uncaughtException", "unhandledRejection"]);
    expect(fakeProcess.exitCodes).toEqual([]);
  });

  test("exits with failure for fatal startup events before a handler is bound", async () => {
    const fakeProcess = new FakeProcess();
    const lifecycle = new ProcessLifecycleHandlers(fakeProcess);
    const consoleError = spyOn(console, "error").mockImplementation(() => {});

    try {
      lifecycle.install();
      fakeProcess.emit("uncaughtException", new Error("startup failed"));
      await flushMicrotasks();

      expect(fakeProcess.exitCodes).toEqual([1]);
    } finally {
      consoleError.mockRestore();
    }
  });
});
