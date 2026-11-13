import { describe, expect, spyOn, test } from "bun:test";
import { ActionableError, type ExecResult } from "../../src/models";
import * as budgets from "../../src/features/storage/fileTransferTimeout";
import {
  createSharedStorageServiceForTesting,
  type SharedStorageFileSystem,
  type StageSharedStorageRequest,
} from "../../src/server/sharedStorageService";
import { AdbSharedStorageDiagnostics } from "../../src/server/sharedStorageDiagnostics";
import {
  getAbortSignal,
  getRequestContext,
  runWithAbortSignal,
} from "../../src/utils/AbortContext";
import { CountingIdGenerator } from "../../src/utils/IdGenerator";
import { logger } from "../../src/utils/logger";
import { SHARED_STORAGE_ABORT_SETTLEMENT_TIMEOUT_MS } from "../../src/server/sharedStorageStaging";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { FakeSharedStorageDiagnostics } from "../fakes/FakeSharedStorageDiagnostics";
import { FakeTimer } from "../fakes/FakeTimer";
import { drainMicrotasks, drainUntil, settleByFakeEvents } from "../helpers/fakeTimerStepping";

const DESTINATION = "/storage/emulated/0/Download/fixtures/photo.png";
function fileSystemOfSize(size: number): SharedStorageFileSystem {
  return {
    stat: async () => ({ size, isFile: () => true }),
    mkdtemp: async () => "/fake/unused",
    writeFileBuffer: async () => {},
    rm: async () => {},
  };
}

function result(stdout: string): ExecResult {
  return {
    stdout,
    stderr: "",
    toString: () => stdout,
    trim: () => stdout.trim(),
    includes: (s) => stdout.includes(s),
  };
}

function setup(sourceBytes = 42) {
  const adb = new FakeAdbExecutor();
  const timer = new FakeTimer();
  const diagnostics = new FakeSharedStorageDiagnostics();
  adb.setCommandResponse("content query", result("Row: 0 _id=42"));
  const service = createSharedStorageServiceForTesting({
    adbFactory: { create: () => adb },
    fileSystem: fileSystemOfSize(sourceBytes),
    timer,
    diagnostics,
    idGenerator: new CountingIdGenerator("staging"),
    createUserResolver: () => ({ resolve: async () => ({ userId: 0, source: "primary" }) }),
  });
  const stage = (options: Partial<StageSharedStorageRequest> = {}) =>
    service.stage({
      device: { deviceId: "fake-android", name: "Fake Android", platform: "android" },
      namespace: "fixtures",
      files: [{ sourcePath: "/fixtures/photo.png", destinationPath: "photo.png" }],
      ...options,
    });
  return { adb, timer, diagnostics, stage };
}

/** Like AdbSignalExecutor with waitForProcessSettlementAfterAbort: pending until aborted. */
function settlesOnAbort(signal: AbortSignal | undefined): Promise<ExecResult> {
  return new Promise<ExecResult>((_resolve, reject) => {
    signal?.addEventListener("abort", () => reject(new Error("adb terminated after abort")), {
      once: true,
    });
  });
}

function capturedError(operation: Promise<unknown>): Promise<ActionableError> {
  return operation.then(
    () => {
      throw new Error("Expected staging to fail");
    },
    (error: unknown) => {
      expect(error).toBeInstanceOf(ActionableError);
      if (!(error instanceof ActionableError)) {
        throw error;
      }
      return error;
    },
  );
}

const MIB = 1024 * 1024;

describe("size-scaled shared-storage transfer budgets (#18328)", () => {
  test("push budget is proportional to size between the floor and the ceiling", () => {
    const rate = budgets.SHARED_STORAGE_MIN_TRANSFER_BYTES_PER_SECOND;
    expect(budgets.sharedStoragePushTimeoutMs(0)).toBe(
      budgets.SHARED_STORAGE_TRANSFER_TIMEOUT_FLOOR_MS,
    );
    expect(budgets.sharedStoragePushTimeoutMs(Number.NaN)).toBe(
      budgets.SHARED_STORAGE_TRANSFER_TIMEOUT_FLOOR_MS,
    );
    expect(budgets.sharedStoragePushTimeoutMs(200 * rate)).toBe(
      budgets.SHARED_STORAGE_TRANSFER_TIMEOUT_CEILING_MS,
    );
    const largeMs = budgets.sharedStoragePushTimeoutMs(100 * rate);
    expect(largeMs).toBe(100_000);
    expect(budgets.sharedStoragePushTimeoutMs(50 * rate) * 2).toBe(largeMs);
    expect(budgets.SHARED_STORAGE_TRANSFER_TIMEOUT_CEILING_MS).toBeLessThanOrEqual(
      budgets.APP_FILE_PUSH_TIMEOUT_MS,
    );
  });

  test("backup budget scales with the chunk's bytes and caps at one ceiling per file", () => {
    const rate = budgets.SHARED_STORAGE_MIN_TRANSFER_BYTES_PER_SECOND;
    const ceiling = budgets.SHARED_STORAGE_TRANSFER_TIMEOUT_CEILING_MS;
    expect(budgets.sharedStorageBackupTimeoutMs([])).toBe(
      budgets.SHARED_STORAGE_TRANSFER_TIMEOUT_FLOOR_MS,
    );
    expect(budgets.sharedStorageBackupTimeoutMs([40 * rate, 60 * rate])).toBe(100_000);
    expect(budgets.sharedStorageBackupTimeoutMs([1_000 * rate])).toBe(ceiling);
    expect(budgets.sharedStorageBackupTimeoutMs([1_000 * rate, 1_000 * rate])).toBe(2 * ceiling);
  });

  test("a large file's push gets a proportionally larger budget and survives past the floor", async () => {
    const bytes = 400 * MIB;
    const expectedMs = (bytes / budgets.SHARED_STORAGE_MIN_TRANSFER_BYTES_PER_SECOND) * 1000;
    expect(expectedMs).toBeGreaterThan(budgets.SHARED_STORAGE_TRANSFER_TIMEOUT_FLOOR_MS);
    const { adb, timer, stage } = setup(bytes);
    const execute = adb.executeCommand.bind(adb);
    let pushTimeout: number | undefined;
    let finishPush: (() => void) | undefined;
    spyOn(adb, "executeCommand").mockImplementation((value, options) => {
      if (value.includes("push ")) {
        pushTimeout = options?.timeoutMs;
        return new Promise<ExecResult>((resolve) => {
          finishPush = () => resolve(result("1 file pushed"));
        });
      }
      return execute(value, options);
    });
    const staging = stage();
    await drainUntil(() => finishPush !== undefined, { description: "large push" });
    expect(pushTimeout).toBe(expectedMs);
    // A healthy slow transfer outlives the floor that would have failed it.
    timer.advanceTime(expectedMs - 1);
    await drainMicrotasks(50);
    finishPush?.();
    const staged = await staging;
    expect(staged.files[0]?.byteCount).toBe(bytes);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("a large file's backup chunk gets a proportionally larger budget", async () => {
    const bytes = 200 * MIB;
    const { adb, stage } = setup(bytes);
    const execute = adb.executeCommand.bind(adb);
    let backupTimeout: number | undefined;
    spyOn(adb, "executeCommand").mockImplementation((value, options) => {
      if (value.includes("AUTOMOBILE_SHARED_STORAGE_BACKUP")) {
        backupTimeout = options?.timeoutMs;
      }
      return execute(value, options);
    });
    await stage({ rollbackOnFailure: true });
    expect(backupTimeout).toBe(
      (bytes / budgets.SHARED_STORAGE_MIN_TRANSFER_BYTES_PER_SECOND) * 1000,
    );
  });

  test("a small stalled push still fails at the floor with stage diagnostics", async () => {
    const { adb, timer, diagnostics, stage } = setup(42);
    const execute = adb.executeCommand.bind(adb);
    let pushSignal: AbortSignal | undefined;
    spyOn(adb, "executeCommand").mockImplementation((value, options) => {
      if (value.includes("push ")) {
        pushSignal = options?.signal;
        return settlesOnAbort(options?.signal);
      }
      return execute(value, options);
    });
    let settled = false;
    const failure = capturedError(stage()).finally(() => {
      settled = true;
    });
    await drainUntil(() => pushSignal !== undefined, { description: "stalled push" });
    timer.advanceTime(budgets.SHARED_STORAGE_TRANSFER_TIMEOUT_FLOOR_MS - 1);
    await drainMicrotasks(50);
    expect(settled).toBe(false);
    expect(pushSignal?.aborted).toBe(false);
    timer.advanceTime(1);
    const error = await failure;
    const floor = budgets.SHARED_STORAGE_TRANSFER_TIMEOUT_FLOOR_MS;
    expect(error.message).toContain(`stage=push`);
    expect(error.message).toContain(`timeout=${floor}ms; elapsed=${floor}ms`);
    expect(error.message).toContain("Shared-storage push timed out");
    expect(error.message).toContain(`Device state:\n${diagnostics.state}`);
    expect(pushSignal?.aborted).toBe(true);
    expect(adb.getExecutedCommands().at(-1)).toContain("shell rm -f");
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });
});

describe("shared-storage stage failures", () => {
  const stages = [
    {
      stage: "reset",
      match: "shell rm -rf",
      timeout: budgets.SHARED_STORAGE_RESET_TIMEOUT_MS,
      options: { reset: true },
    },
    { stage: "mkdir", match: "shell mkdir -p", timeout: budgets.SHARED_STORAGE_MKDIR_TIMEOUT_MS },
    { stage: "push", match: "push ", timeout: budgets.SHARED_STORAGE_TRANSFER_TIMEOUT_FLOOR_MS },
    { stage: "commit", match: "shell mv -f", timeout: budgets.SHARED_STORAGE_COMMIT_TIMEOUT_MS },
    {
      stage: "media-scan",
      match: "MEDIA_SCANNER_SCAN_FILE",
      timeout: budgets.SHARED_STORAGE_MEDIA_SCAN_TIMEOUT_MS,
    },
    {
      stage: "media-query",
      match: "content query",
      timeout: budgets.SHARED_STORAGE_MEDIA_QUERY_TIMEOUT_MS,
    },
    {
      stage: "backup",
      match: "AUTOMOBILE_SHARED_STORAGE_BACKUP",
      timeout: budgets.SHARED_STORAGE_TRANSFER_TIMEOUT_FLOOR_MS,
      options: { rollbackOnFailure: true },
    },
  ];
  for (const spec of stages) {
    test(`${spec.stage} timeout includes destination, exact command, timeout, elapsed and health`, async () => {
      const { adb, timer, diagnostics, stage } = setup();
      const execute = adb.executeCommand.bind(adb);
      let command = "";
      let commandSignal: AbortSignal | undefined;
      spyOn(adb, "executeCommand").mockImplementation((value, options) => {
        if (value.includes(spec.match)) {
          command = value;
          commandSignal = options?.signal;
          expect(options?.timeoutMs).toBe(spec.timeout);
          expect(options?.noRetry).toBe(true);
          return settlesOnAbort(options?.signal);
        }
        return execute(value, options);
      });
      const failure = capturedError(stage(spec.options));
      await drainUntil(() => command !== "", { description: `${spec.stage} command` });
      timer.advanceTime(spec.timeout);
      const error = await failure;
      expect(error.message).toContain(DESTINATION);
      expect(error.message).toContain(`stage=${spec.stage}`);
      if (spec.stage === "push") {
        expect(error.message).toContain(
          "adb 'push' '/fixtures/photo.png' '/storage/emulated/0/Download/fixtures/.automobile-staging-1.part'",
        );
      } else {
        expect(error.message).toContain(`adb ${command}`);
      }
      expect(error.message).toContain(`timeout=${spec.timeout}ms; elapsed=${spec.timeout}ms`);
      expect(error.message).toContain("timed out");
      expect(error.message).toContain(`Device state:\n${diagnostics.state}`);
      expect(error.cause).toBeInstanceOf(Error);
      expect(commandSignal?.aborted).toBe(true);
      expect(diagnostics.calls).toBe(1);
      expect(timer.getPendingTimeoutCount()).toBe(0);
      if (spec.stage === "push") {
        expect(adb.getExecutedCommands().at(-1)).toContain("shell rm -f");
      }
    });
  }

  test("a timed-out push settles its aborted adb write before temp-file cleanup starts", async () => {
    const { adb, timer, stage } = setup();
    const execute = adb.executeCommand.bind(adb);
    let pushSignal: AbortSignal | undefined;
    let terminate: ((error: Error) => void) | undefined;
    spyOn(adb, "executeCommand").mockImplementation((value, options) => {
      if (value.includes("push ")) {
        pushSignal = options?.signal;
        // The executor keeps the write pending through its SIGTERM/SIGKILL grace after abort.
        return new Promise<ExecResult>((_resolve, reject) => {
          terminate = reject;
        });
      }
      return execute(value, options);
    });
    const cleanupStarted = () =>
      adb.getExecutedCommands().some((command) => command.includes("shell rm -f"));
    let settled = false;
    const failure = capturedError(stage()).finally(() => {
      settled = true;
    });
    await drainUntil(() => terminate !== undefined, { description: "push command" });
    timer.advanceTime(budgets.SHARED_STORAGE_TRANSFER_TIMEOUT_FLOOR_MS);
    await drainMicrotasks(200);
    expect(pushSignal?.aborted).toBe(true);
    expect(cleanupStarted()).toBe(false);
    expect(settled).toBe(false);
    timer.advanceTime(1_000);
    await drainMicrotasks(200);
    expect(cleanupStarted()).toBe(false);
    terminate?.(new Error("adb push killed"));
    const error = await failure;
    expect(error.message).toContain("stage=push");
    expect(error.message).toContain(
      `elapsed=${budgets.SHARED_STORAGE_TRANSFER_TIMEOUT_FLOOR_MS}ms: Shared-storage push timed out`,
    );
    expect(cleanupStarted()).toBe(true);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("an aborted push that never settles delays cleanup only by the bound, overlapping diagnostics", async () => {
    const { adb, timer, diagnostics, stage } = setup();
    const execute = adb.executeCommand.bind(adb);
    spyOn(adb, "executeCommand").mockImplementation((value, options) =>
      value.includes("push ") ? new Promise<ExecResult>(() => {}) : execute(value, options),
    );
    spyOn(diagnostics, "collect").mockImplementation(() => new Promise<string>(() => {}));
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const error = await settleByFakeEvents(timer, capturedError(stage()), {
        description: "bounded abort settlement",
      });
      expect(error.message).toContain("stage=push");
      expect(SHARED_STORAGE_ABORT_SETTLEMENT_TIMEOUT_MS).toBeLessThan(
        budgets.SHARED_STORAGE_DIAGNOSTICS_TOTAL_TIMEOUT_MS,
      );
      expect(timer.now()).toBe(
        budgets.SHARED_STORAGE_TRANSFER_TIMEOUT_FLOOR_MS +
          budgets.SHARED_STORAGE_DIAGNOSTICS_TOTAL_TIMEOUT_MS,
      );
      expect(adb.getExecutedCommands().at(-1)).toContain("shell rm -f");
      expect(warn.mock.calls.some(([message]) => String(message).includes("did not settle"))).toBe(
        true,
      );
      expect(timer.getPendingTimeoutCount()).toBe(0);
    } finally {
      warn.mockRestore();
    }
  });

  test("empty adb errors retain a cause and explicit nonempty fallback", async () => {
    const { adb, timer, stage } = setup();
    const cause = new Error("");
    adb.setCommandError("push ", cause);
    timer.setCurrentTime(700);
    const error = await capturedError(stage());
    expect(error.message).toContain("stage=push");
    expect(error.message).toContain("no error output from adb");
    expect(error.message).toContain("elapsed=0ms");
    expect(error.cause).toBe(cause);
  });

  test("a hung diagnostics collector cannot mask the stage failure or extend its elapsed time", async () => {
    const { adb, timer, diagnostics, stage } = setup();
    const cause = new Error("push transport closed");
    adb.setCommandError("push ", cause);
    spyOn(diagnostics, "collect").mockImplementation(() => new Promise<string>(() => {}));
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const error = await settleByFakeEvents(timer, capturedError(stage()), {
        description: "bounded diagnostic collector",
      });
      expect(error.message).toContain("stage=push");
      expect(error.message).toContain("elapsed=0ms: push transport closed");
      expect(error.message).toContain(
        "Device state:\ndevice unresponsive: recycle this device (startDevice/killDevice) instead of launching the app on it",
      );
      expect(error.cause).toBe(cause);
      expect(timer.now()).toBe(budgets.SHARED_STORAGE_DIAGNOSTICS_TOTAL_TIMEOUT_MS);
      expect(timer.getPendingTimeoutCount()).toBe(0);
    } finally {
      warn.mockRestore();
    }
  });

  test("the API-level read is bounded as part of the media-query stage", async () => {
    const { adb, timer, stage } = setup();
    spyOn(adb, "getAndroidApiLevel").mockImplementation((timeoutMs, signal) => {
      expect(timeoutMs).toBe(budgets.SHARED_STORAGE_MEDIA_QUERY_TIMEOUT_MS);
      expect(signal?.aborted).toBe(false);
      return new Promise<number | null>(() => {});
    });
    const error = await settleByFakeEvents(timer, capturedError(stage()), {
      description: "bounded API-level probe",
    });
    expect(error.message).toContain(
      "stage=media-query; command: adb shell getprop ro.build.version.sdk",
    );
    expect(error.message).toContain("timeout=3000ms; elapsed=3000ms");
    expect(timer.now()).toBe(3000);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("query time consumes the total indexing budget and shortens the last adb timeout", async () => {
    const { adb, timer, stage } = setup();
    const execute = adb.executeCommand.bind(adb);
    const timeouts: Array<number | undefined> = [];
    spyOn(adb, "executeCommand").mockImplementation((command, options) => {
      if (!command.includes("content query")) {
        return execute(command, options);
      }
      timeouts.push(options?.timeoutMs);
      if (timeouts.length === 1) {
        timer.advanceTime(2700);
        return Promise.resolve(result(""));
      }
      return settlesOnAbort(options?.signal);
    });
    const failure = capturedError(stage());
    const error = await settleByFakeEvents(timer, failure, {
      description: "media-index total budget",
    });
    expect(timeouts).toEqual([3000, 2050]);
    expect(timer.now()).toBe(budgets.SHARED_STORAGE_MEDIA_INDEX_TIMEOUT_MS);
    expect(error.message).toContain("stage=media-query");
    expect(error.message).toContain("timeout=2050ms; elapsed=2050ms");
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("successful empty queries stop at the total budget with stage and command context", async () => {
    const { adb, timer, stage, diagnostics } = setup();
    adb.setCommandResponse("content query", result(""));
    const error = await settleByFakeEvents(timer, capturedError(stage()), {
      description: "empty media queries",
    });
    expect(timer.now()).toBe(5000);
    expect(error.message).toContain("stage=media-query");
    expect(error.message).toContain("adb shell content query");
    expect(error.message).toContain("timeout=5000ms; elapsed=5000ms");
    expect(error.message).toContain("Total media-index budget exhausted");
    expect(diagnostics.calls).toBe(1);
  });

  test("success preserves the result shape, uses bounded calls and never collects diagnostics", async () => {
    const { adb, stage, diagnostics, timer } = setup();
    expect(await stage({ reset: true })).toEqual({
      success: true,
      deviceId: "fake-android",
      platform: "android",
      namespace: "fixtures",
      userId: 0,
      userSource: "primary",
      destinationDirectory: "/storage/emulated/0/Download/fixtures",
      reset: true,
      files: [
        { destinationPath: "photo.png", byteCount: 42, mediaIndexing: { status: "completed" } },
      ],
    });
    for (const call of adb.getCommandCalls()) {
      expect(call.timeoutMs).toBeGreaterThan(0);
      expect(call.timeoutMs).toBeLessThanOrEqual(90_000);
    }
    expect(diagnostics.calls).toBe(0);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });
});

describe("shared-storage device-health diagnostics", () => {
  for (const unresponsive of ["echo", "boot", "neither"] as const) {
    test(`reports health and recovery when ${unresponsive} is unhealthy`, async () => {
      const adb = new FakeAdbExecutor();
      adb.setCommandResponse("shell echo ok", result(unresponsive === "echo" ? "" : "ok"));
      adb.setCommandResponse("sys.boot_completed", result(unresponsive === "boot" ? "0" : "1"));
      adb.setCommandResponse("df /sdcard", result("Filesystem Available\n/sdcard 10G"));
      adb.setCommandResponse(
        "logcat",
        result(
          `irrelevant\nANR older\nFATAL ${"x".repeat(2000)}\nMediaProvider blocked\nam_anr last`,
        ),
      );
      const state = await new AdbSharedStorageDiagnostics().collect(adb, new FakeTimer());
      expect(
        state.includes(
          "device unresponsive: recycle this device (startDevice/killDevice) instead of launching the app on it",
        ),
      ).toBe(unresponsive !== "neither");
      expect(state).toContain("sys.boot_completed:");
      expect(state).toContain("10G");
      expect(state).toContain("MediaProvider blocked\nam_anr last");
      expect(state).not.toContain("irrelevant");
      expect(
        state.split("logcat (ANR/FATAL/MediaProvider/am_anr): ")[1]!.length,
      ).toBeLessThanOrEqual(1500);
    });
  }

  test("hung probes are concurrent, bounded and detached from ambient cancellation and deadline", async () => {
    const adb = new FakeAdbExecutor();
    const timer = new FakeTimer();
    const controller = new AbortController();
    controller.abort();
    const calls: string[] = [];
    const signals: Array<AbortSignal | undefined> = [];
    spyOn(adb, "executeCommand").mockImplementation((command, options) => {
      calls.push(command);
      signals.push(options?.signal);
      expect(getAbortSignal()).toBeUndefined();
      expect(getRequestContext()).toBeUndefined();
      expect(options?.signal?.aborted).toBe(false);
      expect(options?.timeoutMs).toBe(4000);
      return new Promise<ExecResult>(() => {});
    });
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const pending = runWithAbortSignal(
        controller.signal,
        () => new AdbSharedStorageDiagnostics().collect(adb, timer),
        {
          getDeadlineMs: () => 0,
          textState: { dispatched: () => () => {} },
        },
      );
      const state = await settleByFakeEvents(timer, pending, { description: "hung device probes" });
      expect(calls).toEqual([
        "shell echo ok",
        "shell getprop sys.boot_completed",
        "shell df /sdcard",
        "logcat -d -t 200",
      ]);
      expect(timer.now()).toBe(4000);
      expect(signals.every((signal) => signal?.aborted)).toBe(true);
      expect(state).toContain("device unresponsive: recycle this device");
      expect(state).toContain("timed out after 4000ms");
      expect(warn).toHaveBeenCalledTimes(4);
      expect(timer.getPendingTimeoutCount()).toBe(0);
    } finally {
      warn.mockRestore();
    }
  });
});
