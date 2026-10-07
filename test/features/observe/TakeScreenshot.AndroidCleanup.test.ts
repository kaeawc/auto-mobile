import { describe, expect, spyOn, test } from "bun:test";
import {
  TakeScreenshot,
  type ScreenshotOptions,
} from "../../../src/features/observe/TakeScreenshot";
import { AdbClient } from "../../../src/utils/android-cmdline-tools/AdbClient";
import { runWithAbortSignal } from "../../../src/utils/AbortContext";
import { createExecResult } from "../../../src/utils/execResult";
import type { ScreenshotResult } from "../../../src/models/ScreenshotResult";
import type { AdbExecuteOptions } from "../../../src/utils/android-cmdline-tools/interfaces/AdbExecutor";
import { logger } from "../../../src/utils/logger";
import { screenshotTempIdToken } from "../../../src/utils/screenshot/screenshotFormats";
import { OPERATION_CANCELLED_MESSAGE } from "../../../src/utils/constants";
import { FakeAndroidPhysicalDisplayIdResolver } from "../../fakes/FakeAndroidPhysicalDisplayIdResolver";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeFileSystem } from "../../fakes/FakeFileSystem";
import { FakeIdGenerator } from "../../fakes/FakeIdGenerator";
import { FakeScreenshotFileWriter } from "../../fakes/FakeScreenshotFileWriter";
import { FakeScreenshotPathProtection } from "../../fakes/FakeScreenshotPathProtection";
import { FakeTimer } from "../../fakes/FakeTimer";
import { androidDevice } from "./takeScreenshotTestHelpers";

// Exercise the base64 path directly so maxBuffer failures are not hidden by the pull fallback.
interface Base64Capture {
  captureScreenshotBase64(
    finalPath: string,
    options: ScreenshotOptions,
    signal?: AbortSignal,
    readOnly?: boolean,
  ): Promise<ScreenshotResult>;
}

function captureFor(adb: FakeAdbExecutor): Base64Capture {
  const timer = new FakeTimer();
  return new TakeScreenshot(
    androidDevice("base64-cleanup"),
    new FakeAdbClientFactory(adb),
    timer,
    new FakeIdGenerator(["cleanup"]),
    new FakeScreenshotFileWriter(),
    new FakeFileSystem(),
    () => "/screenshots/cache",
    new FakeAndroidPhysicalDisplayIdResolver(new Map([[0, "4619827259835644672"]])),
    false,
    { pathProtection: new FakeScreenshotPathProtection(timer) },
  ) as unknown as Base64Capture;
}

const tempFile = `/data/local/tmp/am-shot-${screenshotTempIdToken("cleanup")}.png`;
const command = `shell "screencap -d 4619827259835644672 -p ${tempFile} && base64 ${tempFile} && rm ${tempFile}"`;
const options = { format: "png", displayId: 0 } as const;
const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Bound the assertion with microtasks rather than a real timer if cleanup never settles. */
async function pendingSentinel(): Promise<"pending"> {
  for (let i = 0; i < 50; i++) {
    await Promise.resolve();
  }
  return "pending";
}

describe("Android base64 screenshot cleanup", () => {
  test.each(["already aborted", "before dispatch"])(
    "does not remove a temporary file when cancelled %s",
    async (kind) => {
      const adb = new FakeAdbExecutor();
      const controller = new AbortController();
      const failure = new DOMException("capture aborted", "AbortError");
      if (kind === "already aborted") {
        controller.abort(failure);
      }

      const capture = captureFor(adb).captureScreenshotBase64(
        "/screenshots/result.png",
        options,
        controller.signal,
      );
      // The display argument await yields before entering the capture lock.
      if (kind === "before dispatch") {
        controller.abort(failure);
      }

      await expect(capture).rejects.toThrow(OPERATION_CANCELLED_MESSAGE);
      expect(adb.getExecutedCommands()).toEqual([]);
    },
  );

  test.each(["abort", "maxBuffer"])(
    "detaches cleanup after %s without delaying rejection",
    async (kind) => {
      const adb = new FakeAdbExecutor();
      const controller = new AbortController();
      const failure =
        kind === "abort"
          ? new DOMException("capture aborted", "AbortError")
          : new Error("stdout maxBuffer exceeded");
      adb.setCommandError("screencap", failure);
      const executeCommand = adb.executeCommand.bind(adb);
      adb.executeCommand = async (...args) => {
        if (kind === "abort" && args[0].includes("screencap")) {
          controller.abort(failure);
        }
        return executeCommand(...args);
      };
      const removals: Array<{ args: string[]; options: AdbExecuteOptions }> = [];
      adb.execute = async (args, cleanupOptions = {}) => {
        removals.push({ args, options: cleanupOptions });
        return new Promise(() => {});
      };

      const capture = captureFor(adb).captureScreenshotBase64(
        "/screenshots/result.png",
        options,
        controller.signal,
      );
      const outcome = await Promise.race([
        capture.then(
          () => "unexpected-success",
          (error: unknown) => error,
        ),
        pendingSentinel(),
      ]);

      expect(outcome).toBe(failure);
      expect(removals).toHaveLength(1);
      expect(removals[0]?.args).toEqual(["shell", "rm", "-f", tempFile]);
      expect(removals[0]?.options.timeoutMs).toBe(1500);
      expect(removals[0]?.options.noRetry).toBe(true);
      expect(removals[0]?.options.signal).toBeInstanceOf(AbortSignal);
      expect(removals[0]?.options.signal).not.toBe(controller.signal);
      expect(removals[0]?.options.signal?.aborted).toBe(false);
    },
  );

  test("keeps the successful capture command and command count unchanged", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse("screencap", { stdout: pngBytes.toString("base64"), stderr: "" });

    const result = await captureFor(adb).captureScreenshotBase64(
      "/screenshots/result.png",
      options,
    );

    expect(result.success).toBe(true);
    expect(adb.getExecutedCommands()).toEqual([command]);
    expect(adb.getCommandCalls()[0]?.maxBuffer).toBe(50 * 1024 * 1024);
  });

  test("handles a late detached cleanup rejection without changing the capture error", async () => {
    const adb = new FakeAdbExecutor();
    const failure = new Error("capture failed");
    const cleanupFailure = new Error("device offline during cleanup");
    adb.setCommandError("screencap", failure);
    let rejectCleanup: ((error: Error) => void) | undefined;
    adb.execute = () =>
      new Promise((_resolve, reject) => {
        rejectCleanup = reject;
      });
    const warn = spyOn(logger, "warn");
    try {
      await expect(
        captureFor(adb).captureScreenshotBase64("/screenshots/result.png", options),
      ).rejects.toBe(failure);
      expect(rejectCleanup).toBeDefined();
      rejectCleanup?.(cleanupFailure);
      await pendingSentinel();
      expect(warn).toHaveBeenCalledWith(
        "[SCREENSHOT] Could not remove temporary base64 screenshot",
        cleanupFailure,
      );
    } finally {
      warn.mockRestore();
    }
  });

  test("does not remove device files for a failed read-only capture", async () => {
    const adb = new FakeAdbExecutor();
    const failure = new Error("capture failed");
    adb.setCommandError("screencap", failure);

    await expect(
      captureFor(adb).captureScreenshotBase64("/screenshots/result.png", options, undefined, true),
    ).rejects.toBe(failure);

    expect(adb.getExecutedCommands()).toEqual([
      `shell "screencap -d 4619827259835644672 -p | base64"`,
    ]);
  });
});

interface FilePullCapture {
  captureScreenshotFilePull(
    finalPath: string,
    options: ScreenshotOptions,
    signal?: AbortSignal,
  ): Promise<ScreenshotResult>;
}

function filePullHarness(
  controller: AbortController,
  captureOutcome:
    | "success"
    | "screencap abort"
    | "pull abort"
    | "pull cancelled"
    | "write cancelled"
    | "failure" = "success",
  cleanupOutcome: "success" | "pending" | "failure" = "success",
) {
  const timer = new FakeTimer();
  const commands: string[] = [];
  const failure = new Error("capture failed");
  const cleanupFailure = new Error("device offline during cleanup");
  const adb = new AdbClient(
    androidDevice("file-pull-cleanup"),
    async (command) => {
      commands.push(command);
      if (command.includes("shell rm -f")) {
        if (cleanupOutcome === "pending") {
          return new Promise(() => {});
        }
        if (cleanupOutcome === "failure") {
          throw cleanupFailure;
        }
      }
      if (
        (captureOutcome === "screencap abort" && command.includes("screencap")) ||
        (captureOutcome.startsWith("pull") && command.includes(" pull "))
      ) {
        controller.abort(failure);
        if (captureOutcome !== "pull cancelled") {
          throw failure;
        }
      }
      if (captureOutcome === "failure" && command.includes("screencap")) {
        throw failure;
      }
      return createExecResult(command.includes("screencap") ? "AM_SCREENCAP_RC:0" : "", "");
    },
    null,
    undefined,
    timer,
  );
  const execute = spyOn(adb, "execute");
  const fileSystem = new FakeFileSystem();
  const finalPath = "/screenshots/result.png";
  fileSystem.setBinaryFile(`${finalPath}.temp`, pngBytes);
  const screenshot = new TakeScreenshot(
    androidDevice("file-pull-cleanup"),
    new FakeAdbClientFactory(adb),
    timer,
    new FakeIdGenerator(["cleanup"]),
    {
      async write(path, bytes) {
        fileSystem.setBinaryFile(path, bytes);
        if (captureOutcome === "write cancelled") {
          controller.abort(failure);
        }
      },
      async remove(path) {
        await fileSystem.remove(path);
      },
    },
    fileSystem,
    () => "/screenshots/cache",
    new FakeAndroidPhysicalDisplayIdResolver(new Map([[0, "4619827259835644672"]])),
    false,
    { pathProtection: new FakeScreenshotPathProtection(timer) },
  ) as unknown as FilePullCapture;
  return {
    commands,
    execute,
    failure,
    cleanupFailure,
    fileSystem,
    finalPath,
    capture: () =>
      runWithAbortSignal(controller.signal, () =>
        screenshot.captureScreenshotFilePull(finalPath, options, controller.signal),
      ),
  };
}

const filePullTempFile = `/sdcard/screenshot_${screenshotTempIdToken("cleanup")}.png`;

function expectDetachedFilePullCleanup(
  harness: ReturnType<typeof filePullHarness>,
  controller: AbortController,
) {
  expect(harness.commands.filter((command) => command.includes("shell rm -f"))).toHaveLength(1);
  const removals = harness.execute.mock.calls.filter(
    ([args]) => args[0] === "shell" && args[1] === "rm",
  );
  expect(removals).toHaveLength(1);
  expect(removals[0]?.[0]).toEqual(["shell", "rm", "-f", filePullTempFile]);
  const cleanupOptions = removals[0]?.[1];
  expect(cleanupOptions?.timeoutMs).toBe(1500);
  expect(cleanupOptions?.noRetry).toBe(true);
  expect(cleanupOptions?.signal).toBeInstanceOf(AbortSignal);
  expect(cleanupOptions?.signal).not.toBe(controller.signal);
  expect(cleanupOptions?.signal?.aborted).toBe(false);
}

describe("Android file-pull screenshot cleanup with ambient cancellation", () => {
  test.each(["screencap abort", "pull abort"] as const)(
    "dispatches detached cleanup after %s without changing rejection",
    async (stage) => {
      const controller = new AbortController();
      const harness = filePullHarness(controller, stage);
      await expect(harness.capture()).rejects.toBe(harness.failure);
      await pendingSentinel();
      expectDetachedFilePullCleanup(harness, controller);
    },
  );

  test.each(["screencap abort", "pull cancelled"] as const)(
    "does not await stalled cleanup after %s",
    async (stage) => {
      const controller = new AbortController();
      const harness = filePullHarness(controller, stage, "pending");
      const outcome = await Promise.race([
        harness.capture().catch((error: unknown) => error),
        pendingSentinel(),
      ]);
      if (stage === "screencap abort") {
        expect(outcome).toBe(harness.failure);
      } else {
        expect(outcome).toEqual({ success: false, error: OPERATION_CANCELLED_MESSAGE });
      }
      expectDetachedFilePullCleanup(harness, controller);
      expect(harness.fileSystem.existsSync(harness.finalPath)).toBe(false);
      expect(harness.fileSystem.existsSync(`${harness.finalPath}.temp`)).toBe(false);
    },
  );

  test.each(["already aborted", "before dispatch"])(
    "skips removal when capture was never dispatched: %s",
    async (stage) => {
      const controller = new AbortController();
      const harness = filePullHarness(controller);
      if (stage === "already aborted") {
        controller.abort();
      }
      const capture = harness.capture();
      if (stage === "before dispatch") {
        controller.abort();
      }
      await expect(capture).rejects.toThrow(OPERATION_CANCELLED_MESSAGE);
      expect(harness.commands).toEqual([]);
      expect(harness.execute.mock.calls).toEqual([]);
    },
  );

  test("removes the device file exactly once on success", async () => {
    const controller = new AbortController();
    const harness = filePullHarness(controller);
    expect((await harness.capture()).success).toBe(true);
    expectDetachedFilePullCleanup(harness, controller);
    expect(harness.fileSystem.existsSync(harness.finalPath)).toBe(true);
  });

  test("discards a completed frame on late cancellation without awaiting cleanup", async () => {
    const controller = new AbortController();
    const harness = filePullHarness(controller, "write cancelled", "pending");
    const result = await Promise.race([harness.capture(), pendingSentinel()]);
    expect(result).toEqual({ success: false, error: OPERATION_CANCELLED_MESSAGE });
    expectDetachedFilePullCleanup(harness, controller);
    expect(harness.fileSystem.existsSync(harness.finalPath)).toBe(false);
    expect(harness.fileSystem.existsSync(`${harness.finalPath}.temp`)).toBe(false);
  });

  test.each(["success", "failure", "pull cancelled"] as const)(
    "warns about cleanup failure without changing %s",
    async (outcome) => {
      const controller = new AbortController();
      const harness = filePullHarness(controller, outcome, "failure");
      const warn = spyOn(logger, "warn");
      try {
        const result = await harness.capture().catch((error: unknown) => error);
        if (outcome === "failure") {
          expect(result).toBe(harness.failure);
        } else if (outcome === "pull cancelled") {
          expect(result).toEqual({ success: false, error: OPERATION_CANCELLED_MESSAGE });
        } else {
          expect(result).toMatchObject({ success: true, path: harness.finalPath });
        }
        await pendingSentinel();
        expectDetachedFilePullCleanup(harness, controller);
        expect(warn).toHaveBeenCalledWith(
          "[SCREENSHOT] Could not remove temporary file-pull screenshot",
          harness.cleanupFailure,
        );
      } finally {
        warn.mockRestore();
      }
    },
  );
});
