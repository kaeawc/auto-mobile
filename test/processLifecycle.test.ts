import { describe, expect, spyOn, test } from "bun:test";
import {
  ProcessLifecycleHandlers,
  runAllCleanupOperations,
  type StdioWriteErrorSource,
} from "../src/processLifecycle";
import { FakeTimer } from "./fakes/FakeTimer";
import { DAEMON_SHUTDOWN_TIMEOUT_MS } from "../src/daemon/constants";
import { FakeProcess } from "./fakes/FakeProcess";

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

class FakeWritableErrorSource implements StdioWriteErrorSource {
  readonly listeners: Array<(error: Error) => void> = [];
  writeCalls = 0;
  unhandledErrorReports = 0;

  constructor(private readonly fakeProcess: FakeProcess) {}

  on(_event: "error", listener: (error: Error) => void): this {
    this.listeners.push(listener);
    return this;
  }

  emit(error: Error): void {
    if (this.listeners.length === 0) {
      // Bound fatal-handler re-entry so the unguarded regression cannot spin forever.
      if (this.unhandledErrorReports < 4) {
        this.unhandledErrorReports++;
        this.fakeProcess.emit("uncaughtException", error);
      }
      return;
    }
    for (const listener of this.listeners) {
      listener(error);
    }
  }

  write(): void {
    this.writeCalls++;
    this.emit(Object.assign(new Error("broken pipe"), { code: "EPIPE" }));
  }
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function flushUntilExit(fakeProcess: FakeProcess): Promise<void> {
  for (let turn = 0; turn < 20 && fakeProcess.exitCodes.length === 0; turn++) {
    await Promise.resolve();
  }
}

describe("synchronous stdio client-gone callbacks", () => {
  const cases = ["stdin end", "stdin close", "stdin error", "stdout error"] as const;

  function installCallback(
    lifecycle: ProcessLifecycleHandlers,
    source: FakeStdin,
    event: (typeof cases)[number],
    callback?: () => void,
  ): void {
    if (event === "stdout error") {
      lifecycle.installStdoutShutdownHandler(source, callback);
    } else {
      lifecycle.installStdinShutdownHandlers(source, callback);
    }
  }

  function emit(source: FakeStdin, event: (typeof cases)[number]): void {
    if (event.endsWith("error")) {
      source.emit("error", new Error("stream failed"));
    } else if (event === "stdin end") {
      source.emit("end");
    } else {
      source.emit("close");
    }
  }

  test.each(cases)("%s callback runs synchronously before cleanup starts", async (event) => {
    const fakeProcess = new FakeProcess();
    const lifecycle = new ProcessLifecycleHandlers(fakeProcess, new FakeTimer());
    const source = new FakeStdin();
    const order: string[] = [];
    installCallback(lifecycle, source, event, () => {
      order.push("client gone");
    });
    lifecycle.setShutdownHandler(() => {
      order.push("cleanup");
    });
    emit(source, event);
    expect(order[0]).toBe("client gone");
    await flushUntilExit(fakeProcess);
    expect(order).toEqual(["client gone", "cleanup"]);
    expect(fakeProcess.exitCodes).toEqual([0]);
  });

  test.each(cases)("%s callback still runs during signal shutdown", async (event) => {
    const fakeProcess = new FakeProcess();
    const lifecycle = new ProcessLifecycleHandlers(fakeProcess, new FakeTimer());
    const source = new FakeStdin();
    const cleanup = Promise.withResolvers<void>();
    let callbacks = 0;
    let shutdowns = 0;
    lifecycle.install();
    lifecycle.setShutdownHandler(() => {
      shutdowns++;
      return cleanup.promise;
    });
    installCallback(lifecycle, source, event, () => {
      callbacks++;
    });
    fakeProcess.emit("SIGTERM");
    await flushMicrotasks();
    emit(source, event);
    expect(callbacks).toBe(1);
    expect(shutdowns).toBe(1);
    cleanup.resolve();
    await flushUntilExit(fakeProcess);
    expect(fakeProcess.exitCodes).toEqual([0]);
  });

  test.each(cases)("%s throwing callback is logged and cannot block shutdown", async (event) => {
    const fakeProcess = new FakeProcess();
    const lifecycle = new ProcessLifecycleHandlers(fakeProcess, new FakeTimer());
    const source = new FakeStdin();
    const error = new Error("client-gone callback failed");
    const emergencyLog = spyOn(process.stderr, "write").mockImplementation(() => true);
    const shutdowns: string[] = [];
    try {
      installCallback(lifecycle, source, event, () => {
        throw error;
      });
      lifecycle.setShutdownHandler((signal) => {
        shutdowns.push(signal);
      });
      emit(source, event);
      await flushUntilExit(fakeProcess);
      expect(emergencyLog).toHaveBeenCalled();
      expect(
        emergencyLog.mock.calls.some(([message]) =>
          String(message).includes("client-gone callback"),
        ),
      ).toBe(true);
      expect(shutdowns).toEqual([event.startsWith("stdin") ? "stdin" : "stdout"]);
      expect(fakeProcess.exitCodes).toEqual([0]);
    } finally {
      emergencyLog.mockRestore();
    }
  });

  test.each(cases)("%s without a callback retains the same shutdown", async (event) => {
    const fakeProcess = new FakeProcess();
    const lifecycle = new ProcessLifecycleHandlers(fakeProcess, new FakeTimer());
    const source = new FakeStdin();
    const shutdowns: string[] = [];
    installCallback(lifecycle, source, event);
    lifecycle.setShutdownHandler((signal) => {
      shutdowns.push(signal);
    });
    emit(source, event);
    await flushUntilExit(fakeProcess);
    expect(shutdowns).toEqual([event.startsWith("stdin") ? "stdin" : "stdout"]);
    expect(fakeProcess.exitCodes).toEqual([0]);
  });
});

describe("stdio write errors (#11710)", () => {
  test.each(["EPIPE", "EIO"])("stdout %s shuts down once and exits cleanly", async (code) => {
    const fakeProcess = new FakeProcess();
    const stdout = new FakeWritableErrorSource(fakeProcess);
    const lifecycle = new ProcessLifecycleHandlers(fakeProcess, new FakeTimer());
    const reasons: string[] = [];
    const fatalEvents: string[] = [];
    lifecycle.install();
    lifecycle.installStdoutShutdownHandler(stdout);
    lifecycle.setShutdownHandler((reason) => {
      reasons.push(reason);
    });
    lifecycle.setFatalProcessHandler((event) => {
      fatalEvents.push(event.type);
    });

    const error = Object.assign(new Error("stdout write failed"), { code });
    stdout.emit(error);
    stdout.emit(error);
    await flushUntilExit(fakeProcess);

    expect(reasons).toEqual(["stdout"]);
    expect(fakeProcess.exitCodes).toEqual([0]);
    expect(fatalEvents).toEqual([]);
    expect(stdout.unhandledErrorReports).toBe(0);
  });

  test("stdout error leaves an in-progress stdin shutdown in charge", async () => {
    const fakeProcess = new FakeProcess();
    const stdin = new FakeStdin();
    const stdout = new FakeWritableErrorSource(fakeProcess);
    const lifecycle = new ProcessLifecycleHandlers(fakeProcess, new FakeTimer());
    const reasons: string[] = [];
    let finishShutdown!: () => void;
    lifecycle.installStdinShutdownHandlers(stdin);
    lifecycle.installStdoutShutdownHandler(stdout);
    lifecycle.setShutdownHandler((reason) => {
      reasons.push(reason);
      return new Promise<void>((resolve) => {
        finishShutdown = resolve;
      });
    });

    stdin.emit("end");
    await flushMicrotasks();
    stdout.emit(Object.assign(new Error("broken pipe"), { code: "EPIPE" }));
    await flushMicrotasks();

    expect(reasons).toEqual(["stdin"]);
    expect(fakeProcess.exitCodes).toEqual([]);
    finishShutdown();
    await flushUntilExit(fakeProcess);
    expect(reasons).toEqual(["stdin"]);
    expect(fakeProcess.exitCodes).toEqual([0]);
  });

  test("SIGTERM does not restart an in-progress stdout shutdown", async () => {
    const fakeProcess = new FakeProcess();
    const stdout = new FakeWritableErrorSource(fakeProcess);
    const lifecycle = new ProcessLifecycleHandlers(fakeProcess, new FakeTimer());
    const reasons: string[] = [];
    let finishShutdown!: () => void;
    lifecycle.install();
    lifecycle.installStdoutShutdownHandler(stdout);
    lifecycle.setShutdownHandler((reason) => {
      reasons.push(reason);
      return new Promise<void>((resolve) => {
        finishShutdown = resolve;
      });
    });

    stdout.emit(Object.assign(new Error("broken pipe"), { code: "EPIPE" }));
    await flushMicrotasks();
    fakeProcess.emit("SIGTERM");
    await flushMicrotasks();

    expect(reasons).toEqual(["stdout"]);
    expect(fakeProcess.exitCodes).toEqual([]);
    finishShutdown();
    await flushUntilExit(fakeProcess);
    expect(reasons).toEqual(["stdout"]);
    expect(fakeProcess.exitCodes).toEqual([0]);
  });

  test("installs each stdout shutdown listener only once", () => {
    const fakeProcess = new FakeProcess();
    const stdout = new FakeWritableErrorSource(fakeProcess);
    const lifecycle = new ProcessLifecycleHandlers(fakeProcess, new FakeTimer());

    lifecycle.installStdoutShutdownHandler(stdout);
    lifecycle.installStdoutShutdownHandler(stdout);

    expect(stdout.listeners).toHaveLength(1);
  });

  test("installs each stderr error guard only once", () => {
    const fakeProcess = new FakeProcess();
    const stderr = new FakeWritableErrorSource(fakeProcess);
    const lifecycle = new ProcessLifecycleHandlers(fakeProcess, new FakeTimer());

    lifecycle.installStderrErrorGuard(stderr);
    lifecycle.installStderrErrorGuard(stderr);

    expect(stderr.listeners).toHaveLength(1);
  });

  test("stderr errors cause no shutdown, fatal handling, exit, or stderr write", async () => {
    const fakeProcess = new FakeProcess();
    const stderr = new FakeWritableErrorSource(fakeProcess);
    const lifecycle = new ProcessLifecycleHandlers(fakeProcess, new FakeTimer());
    const reasons: string[] = [];
    const fatalEvents: string[] = [];
    lifecycle.install();
    lifecycle.installStderrErrorGuard(stderr);
    lifecycle.setShutdownHandler((reason) => {
      reasons.push(reason);
    });
    lifecycle.setFatalProcessHandler((event) => {
      fatalEvents.push(event.type);
    });

    stderr.emit(Object.assign(new Error("broken pipe"), { code: "EPIPE" }));
    stderr.emit(new Error("other stderr write failure"));
    await flushMicrotasks();

    expect(reasons).toEqual([]);
    expect(fatalEvents).toEqual([]);
    expect(fakeProcess.exitCodes).toEqual([]);
    expect(stderr.writeCalls).toBe(0);
    expect(stderr.unhandledErrorReports).toBe(0);
  });

  test("stderr guard prevents the fatal logger from re-entering on a broken pipe", async () => {
    for (const guarded of [false, true]) {
      const fakeProcess = new FakeProcess();
      const stderr = new FakeWritableErrorSource(fakeProcess);
      const lifecycle = new ProcessLifecycleHandlers(fakeProcess, new FakeTimer());
      const fatalEvents: string[] = [];
      lifecycle.install();
      if (guarded) {
        lifecycle.installStderrErrorGuard(stderr);
      }
      lifecycle.setFatalProcessHandler((event) => {
        fatalEvents.push(event.type);
        stderr.write();
      });

      fakeProcess.emit("uncaughtException", new Error("notification write failed"));
      await flushMicrotasks();

      expect(fatalEvents).toEqual(Array(guarded ? 1 : 5).fill("uncaughtException"));
      expect(stderr.writeCalls).toBe(guarded ? 1 : 5);
      expect(stderr.unhandledErrorReports).toBe(guarded ? 0 : 4);
      expect(fakeProcess.exitCodes).toEqual([]);
    }
  });
});

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

  test("leaves SIGHUP to the default disposition unless hangup shutdown is installed", () => {
    const fakeProcess = new FakeProcess();
    const lifecycle = new ProcessLifecycleHandlers(fakeProcess);

    lifecycle.install();

    expect(fakeProcess.listenerCount("SIGHUP")).toBe(0);
  });

  test("runs the shutdown handler on SIGHUP once hangup shutdown is installed (#11156)", async () => {
    const fakeProcess = new FakeProcess();
    const lifecycle = new ProcessLifecycleHandlers(fakeProcess);
    const signals: string[] = [];

    lifecycle.install();
    lifecycle.installHangupShutdownHandler();
    lifecycle.installHangupShutdownHandler();
    lifecycle.setShutdownHandler(async (signal) => {
      signals.push(signal);
    });
    expect(fakeProcess.listenerCount("SIGHUP")).toBe(1);

    fakeProcess.emit("SIGHUP");
    await flushUntilExit(fakeProcess);

    expect(signals).toEqual(["SIGHUP"]);
    expect(fakeProcess.exitCodes).toEqual([0]);
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
      await flushUntilExit(fakeProcess);

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
      await flushUntilExit(fakeProcess);

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

  test.each(["SIGINT", "SIGTERM"] as const)(
    "bounds %s cleanup even without stdin",
    async (signal) => {
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

      fakeProcess.emit(signal);
      await flushMicrotasks();
      timer.advanceTime(50);
      await flushMicrotasks();

      expect(fakeProcess.exitCodes).toEqual([1]);

      finishShutdown();
      await flushMicrotasks();

      expect(fakeProcess.exitCodes).toEqual([1]);
    },
  );

  test("finishes the default watchdog before the daemon supervisor escalates", async () => {
    const fakeProcess = new FakeProcess();
    const timer = new FakeTimer();
    const lifecycle = new ProcessLifecycleHandlers(fakeProcess, timer);
    lifecycle.install();
    lifecycle.setShutdownHandler(async () => await new Promise<void>(() => {}));

    fakeProcess.emit("SIGTERM");
    await flushMicrotasks();
    timer.advanceTime(DAEMON_SHUTDOWN_TIMEOUT_MS - 1);
    await flushMicrotasks();

    expect(fakeProcess.exitCodes).toEqual([1]);
  });

  test("does not restart the signal timeout when stdin closes during cleanup", async () => {
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
      timer.advanceTime(25);
      fakeStdin.emit("close");
      timer.advanceTime(25);
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

describe("stdin answer wait (#12049)", () => {
  function waiting() {
    const timer = new FakeTimer();
    const fakeProcess = new FakeProcess();
    const lifecycle = new ProcessLifecycleHandlers(fakeProcess, timer);
    const stdin = new FakeStdin();
    const answer = Promise.withResolvers<void>();
    const shutdowns: string[] = [];
    let callbacks = 0;
    lifecycle.install();
    lifecycle.setShutdownHandler((reason) => {
      shutdowns.push(reason);
    });
    lifecycle.installStdinShutdownHandlers(
      stdin,
      () => {
        callbacks++;
        return answer.promise;
      },
      50,
    );
    return { timer, fakeProcess, lifecycle, stdin, answer, shutdowns, callbacks: () => callbacks };
  }

  test("awaits answers before starting shutdown, runs callback once for end/error/close", async () => {
    const rig = waiting();
    rig.stdin.emit("end");
    rig.stdin.emit("error", new Error("closed"));
    rig.stdin.emit("close");
    expect(rig.callbacks()).toBe(1);
    await flushMicrotasks();
    expect(rig.shutdowns).toEqual([]);
    expect(rig.fakeProcess.exitCodes).toEqual([]);
    rig.answer.resolve();
    await flushUntilExit(rig.fakeProcess);
    expect(rig.shutdowns).toEqual(["stdin"]);
    expect(rig.fakeProcess.exitCodes).toEqual([0]);
    expect(rig.timer.getPendingTimeoutCount()).toBe(0);
  });

  test.each(["timeout", "rejection"])("%s logs and still shuts down cleanly", async (mode) => {
    const rig = waiting();
    const emergencyLog = spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      rig.stdin.emit("end");
      await flushMicrotasks();
      expect(rig.shutdowns).toEqual([]);
      if (mode === "timeout") {
        rig.timer.advanceTime(49);
        await flushMicrotasks();
        expect(rig.shutdowns).toEqual([]);
        rig.timer.advanceTime(1);
      } else {
        rig.answer.reject(new Error("answer rejected"));
      }
      await flushUntilExit(rig.fakeProcess);
      expect(rig.shutdowns).toEqual(["stdin"]);
      expect(rig.fakeProcess.exitCodes).toEqual([0]);
      expect(
        emergencyLog.mock.calls.some(([message]) => String(message).includes("stdin answer wait")),
      ).toBe(true);
      expect(rig.timer.getPendingTimeoutCount()).toBe(0);
    } finally {
      emergencyLog.mockRestore();
    }
  });

  test("SIGTERM during the wait immediately shuts down once and clears the wait deadline", async () => {
    const rig = waiting();
    rig.stdin.emit("end");
    expect(rig.timer.getPendingTimeoutCount()).toBe(1);
    rig.fakeProcess.emit("SIGTERM");
    await flushUntilExit(rig.fakeProcess);
    expect(rig.shutdowns).toEqual(["SIGTERM"]);
    expect(rig.fakeProcess.exitCodes).toEqual([0]);
    expect(rig.timer.getPendingTimeoutCount()).toBe(0);
    rig.answer.resolve();
    await flushMicrotasks();
    expect(rig.fakeProcess.exitCodes).toEqual([0]);
  });

  test("EOF during an existing shutdown invokes callback but arms no wait deadline", async () => {
    const rig = waiting();
    const cleanup = Promise.withResolvers<void>();
    rig.lifecycle.setShutdownHandler(() => cleanup.promise);
    rig.fakeProcess.emit("SIGTERM");
    const pending = rig.timer.getPendingTimeoutCount();
    rig.stdin.emit("end");
    expect(rig.callbacks()).toBe(1);
    expect(rig.timer.getPendingTimeoutCount()).toBe(pending);
    cleanup.resolve();
    await flushUntilExit(rig.fakeProcess);
    expect(rig.fakeProcess.exitCodes).toEqual([0]);
    expect(rig.timer.getPendingTimeoutCount()).toBe(0);
    rig.answer.resolve();
  });
});
