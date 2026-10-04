import { describe, expect, spyOn, test } from "bun:test";
import {
  TakeScreenshot,
  type ScreenshotOptions,
} from "../../../src/features/observe/TakeScreenshot";
import type { ScreenshotResult } from "../../../src/models/ScreenshotResult";
import type { AdbExecuteOptions } from "../../../src/utils/android-cmdline-tools/interfaces/AdbExecutor";
import { logger } from "../../../src/utils/logger";
import { screenshotTempIdToken } from "../../../src/utils/screenshot/screenshotFormats";
import { OPERATION_CANCELLED_MESSAGE } from "../../../src/utils/constants";
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
    undefined,
    false,
    { pathProtection: new FakeScreenshotPathProtection(timer) },
  ) as unknown as Base64Capture;
}

const tempFile = `/data/local/tmp/am-shot-${screenshotTempIdToken("cleanup")}.png`;
const command = `shell "screencap -d 0 -p ${tempFile} && base64 ${tempFile} && rm ${tempFile}"`;
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
    const debug = spyOn(logger, "debug");
    try {
      await expect(
        captureFor(adb).captureScreenshotBase64("/screenshots/result.png", options),
      ).rejects.toBe(failure);
      expect(rejectCleanup).toBeDefined();
      rejectCleanup?.(cleanupFailure);
      await pendingSentinel();
      expect(debug).toHaveBeenCalledWith(
        "[SCREENSHOT] Could not remove temporary base64 screenshot",
        cleanupFailure,
      );
    } finally {
      debug.mockRestore();
    }
  });

  test("does not remove device files for a failed read-only capture", async () => {
    const adb = new FakeAdbExecutor();
    const failure = new Error("capture failed");
    adb.setCommandError("screencap", failure);

    await expect(
      captureFor(adb).captureScreenshotBase64("/screenshots/result.png", options, undefined, true),
    ).rejects.toBe(failure);

    expect(adb.getExecutedCommands()).toEqual([`shell "screencap -d 0 -p | base64"`]);
  });
});
