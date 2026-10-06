import { loggerCallsWithPrefix } from "../helpers/loggerCallsWithPrefix";
import { getAbortSignal, runWithAbortSignal } from "../../src/utils/AbortContext";
import { logger } from "../../src/utils/logger";
import { describe, expect, spyOn, test } from "bun:test";
import {
  createSharedStorageServiceForTesting,
  type SharedStorageFileSystem,
} from "../../src/server/sharedStorageService";
import { FakeAdbClientFactory } from "../fakes/FakeAdbClientFactory";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import type { BootedDevice } from "../../src/models";
import type { AdbClientFactory } from "../../src/utils/android-cmdline-tools/AdbClientFactory";
import type { UserTargetRequest } from "../../src/utils/android-cmdline-tools/AndroidUserTargetResolver";
import { FakeTimer } from "../fakes/FakeTimer";
import { CountingIdGenerator } from "../../src/utils/IdGenerator";
import { ActionableError } from "../../src/models/ActionableError";
import { shellQuote } from "../../src/utils/shellQuote";

const androidDevice: BootedDevice = {
  deviceId: "emulator-5554",
  name: "Pixel",
  platform: "android",
};

function execResult(stdout: string) {
  return {
    stdout,
    stderr: "",
    toString: () => stdout,
    trim: () => stdout.trim(),
    includes: (text: string) => stdout.includes(text),
  };
}

function adbFactoryFor(executor: FakeAdbExecutor): AdbClientFactory {
  return { create: () => executor };
}

describe("SharedStorageService", () => {
  for (const chunkCount of [1, 2]) {
    test(`reports ${chunkCount} failed rollback chunks without multiplying embedded commands`, async () => {
      const executor = new FakeAdbExecutor();
      const timer = new FakeTimer();
      executor.setCommandResponse("content query", execResult("Row: 0 _id=42"));
      const files = Array.from({ length: chunkCount * 64 }, (_, index) => ({
        sourcePath: `/fixtures/file-${index}.png`,
        destinationPath: `file-${index}-${"x".repeat(32)}.png`,
      }));
      const execute = executor.executeCommand.bind(executor);
      spyOn(executor, "executeCommand").mockImplementation(async (...args) => {
        const [command] = args;
        if (
          command.includes("MEDIA_SCANNER_SCAN_FILE") &&
          command.includes(files.at(-1)!.destinationPath)
        ) {
          throw new Error("indexing failed");
        }
        if (command.startsWith("shell rm -f")) {
          throw new Error(`Command failed: adb ${command}\nrm: Permission denied`);
        }
        return execute(...args);
      });
      const service = createSharedStorageServiceForTesting({
        adbFactory: adbFactoryFor(executor),
        timer,
        fileSystem: {
          stat: async () => ({ size: 3, isFile: () => true }),
          mkdtemp: async () => "/fake/unused",
          writeFileBuffer: async () => {},
          rm: async () => {},
        },
      });
      const warn = spyOn(logger, "warn").mockImplementation(() => {});
      try {
        const error = await service
          .stage({
            device: androidDevice,
            namespace: "chunk-failure",
            rollbackOnFailure: true,
            files,
          })
          .then(
            () => undefined,
            (error: unknown) => error,
          );
        expect(error).toBeInstanceOf(ActionableError);
        if (!(error instanceof ActionableError)) {
          throw new Error("Expected staging to fail with ActionableError");
        }
        console.log(`Rollback message (${chunkCount} chunks): ${error.message.length} characters`);
        expect(error.cause).toBeInstanceOf(Error);
        const warnings = loggerCallsWithPrefix(
          warn.mock.calls,
          "[SharedStorage]",
          "Failed to remove inline shared-storage directory:",
        );
        expect(warnings).toHaveLength(chunkCount);
        const loggedError = warnings[0]?.[1];
        expect(loggedError).toBeInstanceOf(ActionableError);
        if (!(loggedError instanceof ActionableError)) {
          throw new Error("Expected the full rollback error to be logged");
        }
        expect(loggedError.message).toContain("rm -f");
        expect(error.message.length).toBeLessThan(20_000);
        expect(error.message.split("rm -f").length - 1).toBeLessThanOrEqual(1);
        const failures = error.message.split("Rollback failures: ")[1] ?? "";
        const entries = failures.split("; ");
        expect(entries).toHaveLength(chunkCount);
        for (const [index, entry] of entries.entries()) {
          const paths = files
            .map((file) => file.destinationPath)
            .reverse()
            .slice(index * 64, (index + 1) * 64);
          expect(entry).toContain(
            `${paths.join(", ")}: Android shared-storage operation failed: Command failed`,
          );
          expect(entry).toContain("Permission denied");
          for (const path of paths) {
            expect(failures.split(path)).toHaveLength(2);
          }
        }
        expect(timer.getPendingTimeoutCount()).toBe(0);
      } finally {
        warn.mockRestore();
      }
    });
  }

  for (const reason of ["cleanup denied", `cleanup denied: ${"x".repeat(30_000)}`]) {
    test(`single-path rollback preserves short reasons and caps long ones (${reason.length} characters)`, async () => {
      const executor = new FakeAdbExecutor();
      const timer = new FakeTimer();
      const execute = executor.executeCommand.bind(executor);
      spyOn(executor, "executeCommand").mockImplementation(async (...args) => {
        const [command] = args;
        if (command.includes("MEDIA_SCANNER_SCAN_FILE")) {
          throw new Error("indexing failed");
        }
        if (command.startsWith("shell rm -f")) {
          throw new Error(reason);
        }
        return execute(...args);
      });
      const service = createSharedStorageServiceForTesting({
        adbFactory: adbFactoryFor(executor),
        timer,
        fileSystem: {
          stat: async () => ({ size: 3, isFile: () => true }),
          mkdtemp: async () => "/fake/unused",
          writeFileBuffer: async () => {},
          rm: async () => {},
        },
      });
      const warn = spyOn(logger, "warn").mockImplementation(() => {});
      try {
        const error = await service
          .stage({
            device: androidDevice,
            namespace: "single-failure",
            rollbackOnFailure: true,
            files: [{ sourcePath: "/fixtures/file.png", destinationPath: "file.png" }],
          })
          .then(
            () => undefined,
            (error: unknown) => error,
          );
        if (!(error instanceof ActionableError)) {
          throw new Error("Expected staging to fail with ActionableError");
        }
        const fullReason = `Android shared-storage operation failed: ${reason}`;
        const expectedReason =
          fullReason.length > 256 ? `${fullReason.slice(0, 253)}...` : fullReason;
        expect(error.message.split("Rollback failures: ")[1]).toBe(`file.png: ${expectedReason}.`);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(timer.getPendingTimeoutCount()).toBe(0);
      } finally {
        warn.mockRestore();
      }
    });
  }

  test("detached rollback removes both files after cancellation on the second push", async () => {
    const executor = new FakeAdbExecutor();
    const timer = new FakeTimer();
    const controller = new AbortController();
    executor.abortAfterCommand("push /fixtures/second.png", controller);
    executor.setCommandResponse("content query", execResult("Row: 0 _id=42"));
    const removed: string[] = [];
    const execute = executor.executeCommand.bind(executor);
    spyOn(executor, "executeCommand").mockImplementation(async (...args) => {
      const [command, timeoutMs, , , signal] = args;
      const effectiveSignal = signal ?? getAbortSignal();
      effectiveSignal?.throwIfAborted();
      if (command.startsWith("shell rm -f")) {
        expect(getAbortSignal()).toBeUndefined();
        // The temp-file removal carries no signal at all; the rollback carries a fresh one.
        expect(effectiveSignal?.aborted ?? false).toBe(false);
        expect(timeoutMs).toBe(5000);
        removed.push(command);
      }
      return execute(...args);
    });
    const fileSystem: SharedStorageFileSystem = {
      stat: async () => ({ size: 3, isFile: () => true }),
      mkdtemp: async () => "/fake/unused",
      writeFileBuffer: async () => {},
      rm: async () => {},
    };
    const service = createSharedStorageServiceForTesting({
      adbFactory: adbFactoryFor(executor),
      timer,
      fileSystem,
      idGenerator: new CountingIdGenerator("t"),
    });
    await expect(
      runWithAbortSignal(controller.signal, () =>
        service.stage({
          device: androidDevice,
          namespace: "cancelled-media",
          rollbackOnFailure: true,
          signal: controller.signal,
          files: [
            { sourcePath: "/fixtures/first.png", destinationPath: "first.png" },
            { sourcePath: "/fixtures/second.png", destinationPath: "second.png" },
          ],
        }),
      ),
    ).rejects.toThrow(/aborted.*Rolled back: first.png.*Rollback failures: none/);
    expect(controller.signal.aborted).toBe(true);
    // The cancelled second file never reached its destination: only its hidden temp copy is
    // removed, then the committed first file, both detached from the cancelled request.
    expect(removed).toEqual([
      "shell rm -f '/storage/emulated/0/Download/cancelled-media/.automobile-t-4.part'",
      "shell rm -f '/storage/emulated/0/Download/cancelled-media/first.png'",
    ]);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  for (const outcome of ["cancel", "failure"] as const) {
    for (const cleanupOutcome of ["success", "failure", "timeout"] as const) {
      test(`rolls back 12 staged files after ${outcome} with cleanup ${cleanupOutcome}`, async () => {
        const executor = new FakeAdbExecutor();
        const timer = new FakeTimer();
        const controller = new AbortController();
        const started = Promise.withResolvers<void>();
        const pending =
          Promise.withResolvers<Awaited<ReturnType<typeof executor.executeCommand>>>();
        const files = Array.from({ length: 12 }, (_, index) => ({
          sourcePath: `/fixtures/file-${index}.png`,
          destinationPath: `file-${index}.png`,
        }));
        const reversePaths = files.map((file) => file.destinationPath).reverse();
        const removed: string[] = [];
        const timeouts: Array<number | undefined> = [];
        let cleanupSignal: AbortSignal | undefined;
        executor.setCommandResponse("content query", execResult("Row: 0 _id=42"));
        const execute = executor.executeCommand.bind(executor);
        spyOn(executor, "executeCommand").mockImplementation(async (...args) => {
          const [command, timeoutMs, , , signal] = args;
          (signal ?? getAbortSignal())?.throwIfAborted();
          if (command.includes("MEDIA_SCANNER_SCAN_FILE") && command.includes("file-11.png")) {
            if (outcome === "cancel") {
              controller.abort(new Error("request cancelled"));
              controller.signal.throwIfAborted();
            }
            throw new Error("indexing failed");
          }
          if (command.startsWith("shell rm -f")) {
            expect(getAbortSignal()).toBeUndefined();
            expect(signal?.aborted).toBe(false);
            cleanupSignal = signal;
            removed.push(command);
            timeouts.push(timeoutMs);
            started.resolve();
            if (cleanupOutcome === "failure") {
              throw new Error("cleanup denied");
            }
            if (cleanupOutcome === "timeout") {
              return pending.promise;
            }
          }
          return execute(...args);
        });
        const service = createSharedStorageServiceForTesting({
          adbFactory: adbFactoryFor(executor),
          timer,
          fileSystem: {
            stat: async () => ({ size: 3, isFile: () => true }),
            mkdtemp: async () => "/fake/unused",
            writeFileBuffer: async () => {},
            rm: async () => {},
          },
        });
        const warn = spyOn(logger, "warn").mockImplementation(() => {});
        try {
          const operation = runWithAbortSignal(controller.signal, () =>
            service.stage({
              device: androidDevice,
              namespace: "batch",
              rollbackOnFailure: true,
              signal: controller.signal,
              files,
            }),
          );
          const report = operation.then(
            () => "unexpected success",
            (error: unknown) => {
              if (!(error instanceof Error)) {
                throw error;
              }
              return error.message;
            },
          );
          await started.promise;
          if (cleanupOutcome === "timeout") {
            expect(timer.getPendingTimeouts()).toEqual([5000]);
            timer.advanceTime(5000);
          }
          const message = await report;
          expect(message).toContain(outcome === "cancel" ? "request cancelled" : "indexing failed");
          expect(removed).toEqual([
            `shell rm -f ${reversePaths.map((path) => `'/storage/emulated/0/Download/batch/${path}'`).join(" ")}`,
          ]);
          expect(timeouts).toEqual([5000]);
          if (cleanupOutcome === "success") {
            expect(message).toContain(
              `Rolled back: ${reversePaths.join(", ")}. Rollback failures: none.`,
            );
          } else {
            const reason =
              cleanupOutcome === "failure" ? "cleanup denied" : "timed out after 5000ms";
            expect(message).toContain("Rolled back: none. Rollback failures:");
            expect(message).toContain(`${reversePaths.join(", ")}:`);
            expect(message.split(reason)).toHaveLength(2);
            expect(warn).toHaveBeenCalled();
          }
          expect(cleanupSignal?.aborted).toBe(cleanupOutcome === "timeout");
          expect(timer.now()).toBe(cleanupOutcome === "timeout" ? 5000 : 0);
          expect(timer.getPendingTimeoutCount()).toBe(0);
          if (cleanupOutcome === "timeout") {
            pending.reject(new Error("late rollback failure"));
          }
        } finally {
          warn.mockRestore();
        }
      });
    }
  }

  test("rollback chunks 64 paths, caps command time at remaining budget, and reports undispatched files", async () => {
    const executor = new FakeAdbExecutor();
    const timer = new FakeTimer();
    const controller = new AbortController();
    const started = Array.from({ length: 4 }, () => Promise.withResolvers<void>());
    const pending = Promise.withResolvers<Awaited<ReturnType<typeof executor.executeCommand>>>();
    const files = Array.from({ length: 257 }, (_, index) => ({
      sourcePath: `/fixtures/file-${index}.txt`,
      destinationPath: `file-${index}.txt`,
    }));
    const reversePaths = files.map((file) => file.destinationPath).reverse();
    const removed: string[] = [];
    const timeouts: Array<number | undefined> = [];
    const cleanupSignals: AbortSignal[] = [];
    const execute = executor.executeCommand.bind(executor);
    spyOn(executor, "executeCommand").mockImplementation(async (...args) => {
      const [command, timeoutMs, , , signal] = args;
      (signal ?? getAbortSignal())?.throwIfAborted();
      if (command.startsWith("push /fixtures/trigger.txt")) {
        controller.abort(new Error("request cancelled"));
        controller.signal.throwIfAborted();
      }
      if (command.startsWith("shell rm -f") && !command.includes(".part'")) {
        expect(getAbortSignal()).toBeUndefined();
        expect(signal?.aborted).toBe(false);
        if (signal) {
          cleanupSignals.push(signal);
        }
        removed.push(command);
        timeouts.push(timeoutMs);
        started[removed.length - 1]?.resolve();
        if (removed.length > 1) {
          return pending.promise;
        }
        await timer.sleep(4000);
      }
      return execute(...args);
    });
    const service = createSharedStorageServiceForTesting({
      adbFactory: adbFactoryFor(executor),
      timer,
      fileSystem: {
        stat: async () => ({ size: 3, isFile: () => true }),
        mkdtemp: async () => "/fake/unused",
        writeFileBuffer: async () => {},
        rm: async () => {},
      },
    });
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const operation = runWithAbortSignal(controller.signal, () =>
        service.stage({
          device: androidDevice,
          namespace: "chunked",
          rollbackOnFailure: true,
          signal: controller.signal,
          files: [
            ...files,
            { sourcePath: "/fixtures/trigger.txt", destinationPath: "trigger.txt" },
          ],
        }),
      );
      const report = operation.then(
        () => "unexpected success",
        (error: unknown) => {
          if (!(error instanceof Error)) {
            throw error;
          }
          return error.message;
        },
      );
      const durations = [4000, 5000, 5000, 1000];
      for (const [index, commandStarted] of started.entries()) {
        await commandStarted.promise;
        timer.advanceTime(durations[index] ?? 0);
      }
      const message = await report;
      expect(message).toContain("request cancelled");
      const expectedCommands: string[] = [];
      for (const offset of [0, 64, 128, 192]) {
        const quotedPaths = reversePaths
          .slice(offset, offset + 64)
          .map((path) => `'/storage/emulated/0/Download/chunked/${path}'`);
        expectedCommands.push(`shell rm -f ${quotedPaths.join(" ")}`);
      }
      expect(removed).toEqual(expectedCommands);
      expect(timeouts).toEqual([5000, 5000, 5000, 1000]);
      expect(message).toContain(`Rolled back: ${reversePaths.slice(0, 64).join(", ")}.`);
      const failureReport = message.split("Rollback failures: ")[1] ?? "";
      expect(failureReport.split("; ")).toHaveLength(4);
      for (const [index, reason] of [
        "timed out after 5000ms",
        "timed out after 5000ms",
        "timed out after 1000ms",
        "exceeded total timeout of 15000ms",
      ].entries()) {
        const paths = reversePaths.slice((index + 1) * 64, (index + 2) * 64);
        expect(failureReport).toContain(
          `${paths.join(", ")}: Shared-storage batch rollback ${reason}`,
        );
      }
      expect(cleanupSignals.map((signal) => signal.aborted)).toEqual([false, true, true, true]);
      expect(new Set(cleanupSignals).size).toBe(4);
      expect(timer.now()).toBe(15000);
      expect(timer.getPendingTimeoutCount()).toBe(0);
      expect(
        loggerCallsWithPrefix(
          warn.mock.calls,
          "[SharedStorage]",
          "Failed to remove inline shared-storage directory:",
        ),
      ).toHaveLength(4);
      pending.reject(new Error("late rollback failure"));
    } finally {
      warn.mockRestore();
    }
  });

  test("resets only the declared Downloads namespace, stages every file, and indexes media", async () => {
    const executor = new FakeAdbExecutor();
    executor.setCommandResponse("content query", execResult("Row: 0 _id=42"));
    const service = createSharedStorageServiceForTesting({ adbFactory: adbFactoryFor(executor) });

    const result = await service.stage({
      device: androidDevice,
      namespace: "run-42",
      reset: true,
      files: [
        { contentText: "read me", destinationPath: "docs/read me.txt" },
        {
          contentBase64: Buffer.from([1, 2, 3]).toString("base64"),
          destinationPath: "media/photo.png",
        },
      ],
    });

    expect(result).toEqual({
      success: true,
      deviceId: "emulator-5554",
      platform: "android",
      namespace: "run-42",
      userId: 0,
      userSource: "primary",
      destinationDirectory: "/storage/emulated/0/Download/run-42",
      reset: true,
      files: [
        {
          destinationPath: "docs/read me.txt",
          byteCount: 7,
          mediaIndexing: {
            status: "notRequested",
            reason:
              "media indexing was not requested for docs/read me.txt; Android document pickers discover files directly from Downloads",
          },
        },
        {
          destinationPath: "media/photo.png",
          byteCount: 3,
          mediaIndexing: { status: "completed" },
        },
      ],
    });

    const commands = executor.getExecutedCommands();
    expect(commands[0]).toBe("shell am get-current-user");
    expect(commands[1]).toBe("shell rm -rf '/storage/emulated/0/Download/run-42'");
    expect(
      executor.getCommandCalls().find((call) => call.command.startsWith("shell rm -rf"))?.timeoutMs,
    ).toBe(120_000);
    expect(commands).toContain("shell mkdir -p '/storage/emulated/0/Download/run-42'");
    expect(commands).toContain("shell mkdir -p '/storage/emulated/0/Download/run-42/docs'");
    expect(commands).toContain("shell mkdir -p '/storage/emulated/0/Download/run-42/media'");
    // Each file is pushed to a hidden temp beside its destination and renamed into place.
    const pushed = executor.getExecutedArgv().filter((argv) => argv[0] === "push");
    expect(pushed.map((argv) => argv[2])).toEqual([
      expect.stringMatching(
        /^\/storage\/emulated\/0\/Download\/run-42\/docs\/\.automobile-.*\.part$/,
      ),
      expect.stringMatching(
        /^\/storage\/emulated\/0\/Download\/run-42\/media\/\.automobile-.*\.part$/,
      ),
    ]);
    expect(pushed[0]?.[1]).toContain("automobile-shared-storage-");
    expect(commands).toContain(
      `shell mv -f ${shellQuote(pushed[0]?.[2] ?? "")} '/storage/emulated/0/Download/run-42/docs/read me.txt'`,
    );
    expect(
      executor
        .getCommandCalls()
        .filter((call) => call.command.startsWith("push "))
        .map((call) => call.timeoutMs),
    ).toEqual([120_000, 120_000]);
    expect(
      commands.some(
        (command) =>
          command.includes("MEDIA_SCANNER_SCAN_FILE") &&
          command.includes("file:///storage/emulated/0/Download/run-42/media/photo.png"),
      ),
    ).toBe(true);
    expect(
      commands.some(
        (command) =>
          command.includes("content query") && command.includes("external_primary/images/media"),
      ),
    ).toBe(true);
    expect(
      commands.some(
        (command) =>
          command.includes("relative_path=") &&
          command.includes("Download") &&
          !command.includes("Download/Download/"),
      ),
    ).toBe(true);
    expect(commands.every((command) => !command.includes(".."))).toBe(true);
    // A session release may cancel staging while a child is still exiting. Every
    // shared-storage mutation must remain pending until that process settles,
    // rather than rejecting immediately on abort.
    expect(
      executor
        .getCommandCalls()
        .filter((call) => /shell (?:rm -rf|mkdir -p|mv -f|am broadcast)|^push /.test(call.command))
        .every((call) => call.waitForProcessSettlementAfterAbort === true),
    ).toBe(true);
  });

  test("uses the resolved active profile rather than assuming Android user zero", async () => {
    const executor = new FakeAdbExecutor();
    const requests: UserTargetRequest[] = [];
    const service = createSharedStorageServiceForTesting({
      adbFactory: adbFactoryFor(executor),
      createUserResolver: () => ({
        resolve: async (request) => {
          requests.push(request ?? {});
          return { userId: 12, source: "managedProfile" };
        },
      }),
    });

    const result = await service.stage({
      device: androidDevice,
      namespace: "work-fixtures",
      reset: true,
      files: [{ contentText: "picker", destinationPath: "document.txt" }],
    });

    expect(result).toMatchObject({
      userId: 12,
      userSource: "managedProfile",
      destinationDirectory: "/storage/emulated/12/Download/work-fixtures",
    });
    expect(requests).toEqual([{ explicitUserId: undefined, currentUser: true, signal: undefined }]);
    expect(executor.getExecutedCommands()).toContain(
      "shell rm -rf '/storage/emulated/12/Download/work-fixtures'",
    );
    expect(executor.getExecutedArgv()).toContainEqual([
      "push",
      expect.stringContaining("automobile-shared-storage-"),
      expect.stringMatching(
        /^\/storage\/emulated\/12\/Download\/work-fixtures\/\.automobile-.*\.part$/,
      ),
    ]);
    expect(executor.getExecutedCommands()).toContainEqual(
      expect.stringMatching(
        /^shell mv -f '[^']*\.automobile-[^']*\.part' '\/storage\/emulated\/12\/Download\/work-fixtures\/document\.txt'$/,
      ),
    );
  });

  test("honors explicit user zero while still preferring current-user resolution otherwise", async () => {
    const executor = new FakeAdbExecutor();
    const requests: UserTargetRequest[] = [];
    const service = createSharedStorageServiceForTesting({
      adbFactory: adbFactoryFor(executor),
      createUserResolver: () => ({
        resolve: async (request) => {
          requests.push(request ?? {});
          return request?.explicitUserId !== undefined
            ? { userId: request.explicitUserId, source: "explicit" }
            : { userId: 12, source: "currentUser" };
        },
      }),
    });

    const result = await service.stage({
      device: androidDevice,
      namespace: "explicit-zero",
      explicitUserId: 0,
      files: [{ contentText: "zero", destinationPath: "fixture.txt" }],
    });

    expect(requests).toEqual([{ explicitUserId: 0, currentUser: true, signal: undefined }]);
    expect(result).toMatchObject({
      userId: 0,
      userSource: "explicit",
      destinationDirectory: "/storage/emulated/0/Download/explicit-zero",
    });
  });

  test("scopes MediaStore scanning and storage paths to a non-zero current user", async () => {
    const executor = new FakeAdbExecutor();
    executor.setCommandResponse("content query", execResult("Row: 0 _id=42"));
    const requests: UserTargetRequest[] = [];
    const service = createSharedStorageServiceForTesting({
      adbFactory: adbFactoryFor(executor),
      createUserResolver: () => ({
        resolve: async (request) => {
          requests.push(request ?? {});
          return { userId: 12, source: "currentUser" };
        },
      }),
    });

    const result = await service.stage({
      device: androidDevice,
      namespace: "work-media",
      files: [
        { contentBase64: Buffer.from([1, 2, 3]).toString("base64"), destinationPath: "photo.png" },
      ],
    });

    expect(requests[0]?.currentUser).toBe(true);
    expect(result.destinationDirectory).toBe("/storage/emulated/12/Download/work-media");
    expect(executor.getExecutedCommands()).toContain(
      "shell am broadcast --user 12 -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d 'file:///storage/emulated/12/Download/work-media/photo.png'",
    );
    expect(
      executor
        .getExecutedCommands()
        .some((command) => command.startsWith("shell content query --user 12 --uri ")),
    ).toBe(true);
  });

  test("reports why indexing was not requested when the caller opts out", async () => {
    const adbFactory = new FakeAdbClientFactory();
    const service = createSharedStorageServiceForTesting({ adbFactory });
    const result = await service.stage({
      device: androidDevice,
      namespace: "run-42",
      indexMedia: false,
      files: [{ contentText: "png", destinationPath: "photo.png" }],
    });

    expect(result.files[0]?.mediaIndexing).toEqual({
      status: "notRequested",
      reason: "media indexing was disabled by indexMedia=false",
    });
    expect(
      adbFactory
        .getFakeClient()
        .getAllCommands()
        .some((command) => command.includes("MEDIA_SCANNER_SCAN_FILE")),
    ).toBe(false);
  });

  test("rejects non-Android devices before issuing commands", async () => {
    const adbFactory = new FakeAdbClientFactory();
    const service = createSharedStorageServiceForTesting({ adbFactory });
    await expect(
      service.stage({
        device: { deviceId: "ios", name: "iPhone", platform: "ios" },
        namespace: "run-42",
        files: [{ contentText: "hello", destinationPath: "file.txt" }],
      }),
    ).rejects.toThrow("only supported on Android");
    expect(adbFactory.getFakeClient().getAllCommands()).toEqual([]);
  });

  test("validates every source before resetting the existing namespace", async () => {
    const adbFactory = new FakeAdbClientFactory();
    const service = createSharedStorageServiceForTesting({ adbFactory });
    await expect(
      service.stage({
        device: androidDevice,
        namespace: "run-42",
        reset: true,
        files: [{ sourcePath: "/definitely-missing-5587", destinationPath: "fixture.txt" }],
      }),
    ).rejects.toThrow("ENOENT");
    expect(adbFactory.getFakeClient().getAllCommands()).toEqual([]);
  });

  test("does not report media indexing complete until MediaStore exposes the file", async () => {
    const executor = new FakeAdbExecutor();
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const service = createSharedStorageServiceForTesting({
      adbFactory: adbFactoryFor(executor),
      timer,
    });

    await expect(
      service.stage({
        device: androidDevice,
        namespace: "run-42",
        files: [
          {
            contentBase64: Buffer.from([1, 2, 3]).toString("base64"),
            destinationPath: "photo.png",
          },
        ],
      }),
    ).rejects.toThrow("media indexing did not complete");
    expect(
      executor.getExecutedCommands().filter((command) => command.includes("content query")),
    ).toHaveLength(20);
  });

  test("rejects prefix-conflicting destinations before touching shared storage", async () => {
    const adbFactory = new FakeAdbClientFactory();
    const service = createSharedStorageServiceForTesting({ adbFactory });
    await expect(
      service.stage({
        device: androidDevice,
        namespace: "run-42",
        reset: true,
        files: [
          { contentText: "nested", destinationPath: "foo/bar.txt" },
          { contentText: "file", destinationPath: "foo" },
        ],
      }),
    ).rejects.toThrow("conflicts with a nested fixture");
    expect(adbFactory.getFakeClient().getAllCommands()).toEqual([]);
  });

  test("rejects duplicate normalized destinations before touching shared storage", async () => {
    const adbFactory = new FakeAdbClientFactory();
    const service = createSharedStorageServiceForTesting({ adbFactory });
    await expect(
      service.stage({
        device: androidDevice,
        namespace: "run-42",
        reset: true,
        files: [
          { contentText: "first", destinationPath: "fixture.txt" },
          { contentText: "second", destinationPath: "./fixture.txt" },
        ],
      }),
    ).rejects.toThrow("conflicts with a nested fixture");
    expect(adbFactory.getFakeClient().getAllCommands()).toEqual([]);
  });

  for (const cleanupFails of [false, true]) {
    test(`cleans a failed inline write and preserves its error (cleanup fails: ${cleanupFails})`, async () => {
      const original = new Error("disk full");
      const cleanupError = new Error("cleanup denied");
      const removed: string[] = [];
      const fileSystem: SharedStorageFileSystem = {
        stat: async () => {
          throw new Error("not used");
        },
        mkdtemp: async () => "/fake/shared-write",
        writeFileBuffer: async () => {
          throw original;
        },
        rm: async (path) => {
          removed.push(path);
          if (cleanupFails) {
            throw cleanupError;
          }
        },
      };
      const adbFactory = new FakeAdbClientFactory();
      const service = createSharedStorageServiceForTesting({ fileSystem, adbFactory });
      const warn = spyOn(logger, "warn").mockImplementation(() => {});
      try {
        await expect(
          service.stage({
            device: androidDevice,
            namespace: "run-42",
            files: [{ contentText: "hello", destinationPath: "file.txt" }],
          }),
        ).rejects.toBe(original);
        expect(removed).toEqual(["/fake/shared-write"]);
        expect(adbFactory.getFakeClient().getAllCommands()).toEqual([]);
        if (cleanupFails) {
          expect(warn).toHaveBeenCalledWith(
            "Failed to remove inline shared-storage directory: cleanup denied",
            cleanupError,
          );
        } else {
          expect(
            loggerCallsWithPrefix(
              warn.mock.calls,
              "[SharedStorage]",
              "Failed to remove inline shared-storage directory:",
            ),
          ).toHaveLength(0);
        }
      } finally {
        warn.mockRestore();
      }
    });
  }

  test("cleans inline fixture directories when active user resolution fails", async () => {
    const removed: string[] = [];
    let nextDir = 0;
    const fileSystem: SharedStorageFileSystem = {
      stat: async () => {
        throw new Error("not used");
      },
      mkdtemp: async () => `/fake/shared-${++nextDir}`,
      writeFileBuffer: async () => {},
      rm: async (path) => {
        removed.push(path);
      },
    };
    const service = createSharedStorageServiceForTesting({
      fileSystem,
      createUserResolver: () => ({
        resolve: async () => {
          throw new Error("no profile");
        },
      }),
    });

    await expect(
      service.stage({
        device: androidDevice,
        namespace: "run-42",
        files: [
          { contentText: "first", destinationPath: "first.txt" },
          { contentBase64: "eA==", destinationPath: "second.txt" },
        ],
      }),
    ).rejects.toThrow("no profile");
    expect(removed).toEqual(["/fake/shared-1", "/fake/shared-2"]);
  });
});
