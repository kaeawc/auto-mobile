import { beforeEach, describe, expect, test } from "bun:test";
import { promises as fsPromises, readFileSync } from "node:fs";
import path from "node:path";
import { TakeScreenshot } from "../../../src/features/observe/TakeScreenshot";
import { BootedDevice } from "../../../src/models/DeviceInfo";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeFileSystem } from "../../fakes/FakeFileSystem";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { CountingIdGenerator } from "../../../src/utils/IdGenerator";
import { IOSCtrlProxyClient } from "../../../src/features/observe/ios";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android";
import { OPERATION_CANCELLED_MESSAGE } from "../../../src/utils/constants";
import { FakeScreenshotFileWriter } from "../../fakes/FakeScreenshotFileWriter";
import { FakeIOSCtrlProxy } from "../../fakes/FakeIOSCtrlProxy";
import { FakeIdGenerator } from "../../fakes/FakeIdGenerator";
import {
  screenshotDeviceToken,
  screenshotFileName,
} from "../../../src/utils/screenshot/screenshotFormats";

describe("TakeScreenshot", function () {
  describe("Unit Tests for Extracted Methods", function () {
    let takeScreenshot: TakeScreenshot;
    let fakeAdb: FakeAdbExecutor;
    let mockDevice: BootedDevice;

    beforeEach(function () {
      mockDevice = {
        name: "test-device",
        platform: "android",
        deviceId: "test-device-id",
        source: "local",
      };

      // Create a simple fake ADB for unit testing
      fakeAdb = new FakeAdbExecutor();
      const fakeFactory = new FakeAdbClientFactory(fakeAdb);
      takeScreenshot = new TakeScreenshot(mockDevice, fakeFactory);
    });

    test("should generate correct screenshot path with png format", function () {
      const timestamp = 1234567890123;
      const options = { format: "png" as const };

      const result = takeScreenshot.generateScreenshotPath(timestamp, options);

      expect(result).toContain("screenshot_1234567890123");
      expect(result).toMatch(/screenshot_1234567890123_[^.]+\.png$/);
    });

    test("should generate correct screenshot path with webp format", function () {
      const timestamp = 1234567890456;
      const options = { format: "webp" as const };

      const result = takeScreenshot.generateScreenshotPath(timestamp, options);

      expect(result).toContain("screenshot_1234567890456");
      expect(result).toMatch(/screenshot_1234567890456_[^.]+\.webp$/);
    });

    test("tracks WebP metadata when requested", async function () {
      const originalGetInstance = AndroidCtrlProxyClient.getInstance;
      AndroidCtrlProxyClient.getInstance = (() => ({
        requestScreenshot: async () => ({ success: false, error: "CtrlProxy unavailable" }),
      })) as typeof AndroidCtrlProxyClient.getInstance;
      fakeAdb.setDefaultResponse({
        stdout: readFileSync("test/fixtures/screenshots/black-on-white.png").toString("base64"),
        stderr: "",
      });

      try {
        const result = await takeScreenshot.execute({ format: "webp" });

        expect(result.success).toBe(true);
        expect(result.path).toMatch(/\.webp$/);
        expect(result.screenshotFormat).toBe("webp");
        expect(result.screenshotMimeType).toBe("image/webp");
      } finally {
        AndroidCtrlProxyClient.getInstance = originalGetInstance;
      }
    });

    test("should generate different timestamps for consecutive calls", async function () {
      const fakeTimer = new FakeTimer();
      const timestamp1 = fakeTimer.now();
      const options = { format: "png" as const };

      const result1 = takeScreenshot.generateScreenshotPath(timestamp1, options);
      fakeTimer.advanceTime(1);
      const timestamp2 = fakeTimer.now();
      const result2 = takeScreenshot.generateScreenshotPath(timestamp2, options);

      expect(result1).not.toBe(result2);
    });

    test("uses an injected unique suffix when captures share a timestamp", function () {
      const idGenerator = new CountingIdGenerator("capture");
      const sameTime = 1234567890123;
      const screenshot = new TakeScreenshot(
        mockDevice,
        new FakeAdbClientFactory(fakeAdb),
        new FakeTimer(),
        idGenerator,
      );

      const first = screenshot.generateScreenshotPath(sameTime, { format: "png" });
      const second = screenshot.generateScreenshotPath(sameTime, { format: "png" });

      const deviceToken = screenshotDeviceToken("test-device-id");
      expect(first.endsWith(`screenshot_1234567890123_${deviceToken}_capture-1.png`)).toBe(true);
      expect(second.endsWith(`screenshot_1234567890123_${deviceToken}_capture-2.png`)).toBe(true);
      expect(first).not.toBe(second);
    });

    test("names captures after the device so a shared cache dir stays attributable", function () {
      const screenshot = new TakeScreenshot(
        { name: "remote", platform: "android", deviceId: "127.0.0.1:5555", source: "local" },
        new FakeAdbClientFactory(fakeAdb),
        new FakeTimer(),
        new CountingIdGenerator("capture"),
      );

      const generated = screenshot.generateScreenshotPath(1234567890123, { format: "png" });

      expect(
        generated.endsWith(screenshotFileName(1234567890123, "127.0.0.1:5555", "capture-1", "png")),
      ).toBe(true);
      expect(path.basename(generated)).toMatch(
        /^screenshot_1234567890123_127-0-0-1-5555-[0-9a-f]+_capture-1\.png$/,
      );
    });

    test("persists native Android CtrlProxy JPEG as jpg with metadata", async () => {
      const originalGetInstance = AndroidCtrlProxyClient.getInstance;
      AndroidCtrlProxyClient.getInstance = (() => ({
        requestScreenshot: async () => ({
          success: true,
          data: Buffer.from([0xff, 0xd8, 0xff, 0xe0]).toString("base64"),
          format: "jpeg",
        }),
      })) as typeof AndroidCtrlProxyClient.getInstance;

      try {
        const result = await takeScreenshot.execute({});

        expect(result.success).toBe(true);
        expect(result.path).toMatch(/\.jpg$/);
        expect(result.screenshotFormat).toBe("jpeg");
        expect(result.screenshotMimeType).toBe("image/jpeg");
        expect(fakeAdb.getExecutedCommands()).toHaveLength(0);
      } finally {
        AndroidCtrlProxyClient.getInstance = originalGetInstance;
      }
    });

    test("keeps the ADB fallback as PNG", async () => {
      const originalGetInstance = AndroidCtrlProxyClient.getInstance;
      AndroidCtrlProxyClient.getInstance = (() => ({
        requestScreenshot: async () => ({ success: false, error: "CtrlProxy unavailable" }),
      })) as typeof AndroidCtrlProxyClient.getInstance;
      fakeAdb.setDefaultResponse({
        stdout: Buffer.from("png bytes").toString("base64"),
        stderr: "",
      });

      try {
        const result = await takeScreenshot.execute({});

        expect(result.success).toBe(true);
        expect(result.path).toMatch(/\.png$/);
        expect(result.screenshotFormat).toBe("png");
        expect(result.screenshotMimeType).toBe("image/png");
      } finally {
        AndroidCtrlProxyClient.getInstance = originalGetInstance;
      }
    });

    test("should use single optimized ADB command for screenshot capture", async function () {
      // Create minimal valid PNG base64 data
      const base64PngData = Buffer.from("fake-png-data").toString("base64");

      const testFakeAdb = new FakeAdbExecutor();
      testFakeAdb.setDefaultResponse({ stdout: base64PngData, stderr: "" });

      // Use FakeFileSystem to avoid actual file I/O
      const fakeFileSystem = new FakeFileSystem();
      fakeFileSystem.setDirectory("/tmp/auto-mobile/screenshots");
      fakeFileSystem.setExists("/tmp/auto-mobile/screenshots", true);

      // Create factory that returns testFakeAdb
      const testFactory = new FakeAdbClientFactory(testFakeAdb);
      const takeScreenshot = new TakeScreenshot(mockDevice, testFactory);

      // Mock the window dependency to avoid additional ADB calls
      const mockWindow = { getActiveHash: async () => "mock-hash" };
      (takeScreenshot as any).window = mockWindow;

      const result = await takeScreenshot.execute();

      // Verify only one ADB command was executed (optimized)
      const executedCommands = testFakeAdb.getExecutedCommands();
      expect(executedCommands.length).toBe(1);

      // Verify the command uses the optimized base64 approach
      const calledCommand = executedCommands[0];
      expect(calledCommand).toContain("screencap");
      expect(calledCommand).toContain("base64");
      expect(calledCommand).toContain("rm"); // Should cleanup temp file in same command

      expect(result.success).toBe(true);
    });
  });

  describe("Android cancellation", function () {
    test("abandons an in-flight CtrlProxy screenshot as soon as the signal aborts", async function () {
      const androidDevice: BootedDevice = {
        name: "test-device",
        platform: "android",
        deviceId: "android-cancel-device",
        source: "local",
      };
      const controller = new AbortController();
      const originalGetInstance = AndroidCtrlProxyClient.getInstance;
      let finishScreenshot: (() => void) | undefined;
      let requestScreenshotCalls = 0;
      AndroidCtrlProxyClient.getInstance = (() => ({
        requestScreenshot: () =>
          new Promise((resolve) => {
            requestScreenshotCalls++;
            // Stands in for the client's own 10s timeout: it never settles
            // within the test, so only the abort can end the wait.
            finishScreenshot = () => resolve({ success: false, error: "too late" });
          }),
      })) as typeof AndroidCtrlProxyClient.getInstance;

      try {
        const screenshot = new TakeScreenshot(
          androidDevice,
          new FakeAdbClientFactory(new FakeAdbExecutor()),
        );
        // No format => the default CtrlProxy path.
        const resultPromise = screenshot.execute({}, controller.signal);
        await Promise.resolve();
        controller.abort();

        const stillPending = (async () => {
          for (let i = 0; i < 50; i++) {
            await Promise.resolve();
          }
          return "still-pending" as const;
        })();

        const outcome = await Promise.race([resultPromise, stillPending]);

        expect(requestScreenshotCalls).toBe(1);
        expect(outcome).toEqual({ success: false, error: OPERATION_CANCELLED_MESSAGE });
        finishScreenshot?.();
        await resultPromise;
      } finally {
        AndroidCtrlProxyClient.getInstance = originalGetInstance;
      }
    });

    test("discards a capture written after the caller cancelled", async function () {
      const androidDevice: BootedDevice = {
        name: "test-device",
        platform: "android",
        deviceId: "android-late-cancel",
        source: "local",
      };
      const controller = new AbortController();
      const originalGetInstance = AndroidCtrlProxyClient.getInstance;
      AndroidCtrlProxyClient.getInstance = (() => ({
        requestScreenshot: async () => ({
          success: true,
          data: Buffer.from([0xff, 0xd8, 0xff, 0xe0]).toString("base64"),
          format: "jpeg" as const,
        }),
      })) as typeof AndroidCtrlProxyClient.getInstance;

      const writer = new FakeScreenshotFileWriter(() => controller.abort());
      try {
        const screenshot = new TakeScreenshot(
          androidDevice,
          new FakeAdbClientFactory(new FakeAdbExecutor()),
          new FakeTimer(),
          new CountingIdGenerator("capture"),
          writer,
        );

        const result = await screenshot.execute({}, controller.signal);

        expect(result).toEqual({ success: false, error: OPERATION_CANCELLED_MESSAGE });
        expect(writer.written.length).toBe(1);
        // The frame the cancelled request produced must not survive on disk,
        // where the latest-screenshot fallback would pick it up.
        expect(writer.removed).toEqual(writer.written);
      } finally {
        AndroidCtrlProxyClient.getInstance = originalGetInstance;
      }
    });
  });

  describe("iOS cancellation", function () {
    test("does not let a reconnect hold an expired screenshot request open", async function () {
      const iosDevice: BootedDevice = {
        name: "iPhone",
        platform: "ios",
        deviceId: "ios-device-id",
        source: "local",
      };
      const controller = new AbortController();
      const originalGetInstance = IOSCtrlProxyClient.getInstance;
      let requestScreenshotCalls = 0;
      let finishReconnect: (() => void) | undefined;
      IOSCtrlProxyClient.getInstance = (() => ({
        ensureConnected: () =>
          new Promise<boolean>((resolve) => {
            finishReconnect = () => resolve(true);
          }),
        requestScreenshot: async () => {
          requestScreenshotCalls++;
          return { success: false, error: "unexpected screenshot request" };
        },
      })) as typeof IOSCtrlProxyClient.getInstance;

      try {
        const screenshot = new TakeScreenshot(
          iosDevice,
          new FakeAdbClientFactory(new FakeAdbExecutor()),
        );
        const resultPromise = screenshot.execute({ format: "png" }, controller.signal);

        // The reconnect represents an iOS auto-setup path. Its completion is
        // intentionally withheld past the caller's deadline.
        controller.abort();
        const result = await resultPromise;

        expect(result).toEqual({ success: false, error: OPERATION_CANCELLED_MESSAGE });
        expect(requestScreenshotCalls).toBe(0);
        finishReconnect?.();
      } finally {
        IOSCtrlProxyClient.getInstance = originalGetInstance;
      }
    });

    test("does not write or publish a screenshot after the request is cancelled", async function () {
      const iosDevice: BootedDevice = {
        name: "iPhone",
        platform: "ios",
        deviceId: "ios-device-id",
        source: "local",
      };
      const controller = new AbortController();
      const originalGetInstance = IOSCtrlProxyClient.getInstance;
      let requestScreenshotCalls = 0;
      IOSCtrlProxyClient.getInstance = (() => ({
        ensureConnected: async () => true,
        requestScreenshot: async () => {
          requestScreenshotCalls++;
          controller.abort();
          return {
            success: true,
            data: Buffer.from("image").toString("base64"),
          };
        },
      })) as typeof IOSCtrlProxyClient.getInstance;

      try {
        const screenshot = new TakeScreenshot(
          iosDevice,
          new FakeAdbClientFactory(new FakeAdbExecutor()),
        );

        const result = await screenshot.execute({ format: "png" }, controller.signal);

        expect(requestScreenshotCalls).toBe(1);
        expect(result).toEqual({
          success: false,
          error: OPERATION_CANCELLED_MESSAGE,
        });
      } finally {
        IOSCtrlProxyClient.getInstance = originalGetInstance;
      }
    });

    test("removes an iOS frame written as the caller cancels", async function () {
      const iosDevice: BootedDevice = {
        name: "iPhone",
        platform: "ios",
        deviceId: "ios-late-cancel",
        source: "local",
      };
      const controller = new AbortController();
      const fakeCtrlProxy = new FakeIOSCtrlProxy();
      fakeCtrlProxy.setScreenshotData(Buffer.from("image").toString("base64"));
      const originalGetInstance = IOSCtrlProxyClient.getInstance;
      IOSCtrlProxyClient.getInstance = (() => ({
        ensureConnected: async () => true,
        requestScreenshot: fakeCtrlProxy.requestScreenshot.bind(fakeCtrlProxy),
      })) as typeof IOSCtrlProxyClient.getInstance;

      const writer = new FakeScreenshotFileWriter(() => controller.abort());
      try {
        const screenshot = new TakeScreenshot(
          iosDevice,
          new FakeAdbClientFactory(new FakeAdbExecutor()),
          new FakeTimer(),
          new CountingIdGenerator("capture"),
          writer,
        );

        const result = await screenshot.execute({ format: "png" }, controller.signal);

        expect(result).toEqual({ success: false, error: OPERATION_CANCELLED_MESSAGE });
        expect(writer.written).toHaveLength(1);
        expect(writer.removed).toEqual(writer.written);
      } finally {
        IOSCtrlProxyClient.getInstance = originalGetInstance;
      }
    });

    test("passes a cancellation signal to iOS CtrlProxy before screenshot dispatch", async function () {
      const iosDevice: BootedDevice = {
        name: "iPhone",
        platform: "ios",
        deviceId: "ios-pre-cancel",
        source: "local",
      };
      const controller = new AbortController();
      const fakeCtrlProxy = new FakeIOSCtrlProxy();
      fakeCtrlProxy.setScreenshotData(Buffer.from("image").toString("base64"));
      fakeCtrlProxy.abortScreenshotOnRequest(controller);
      const originalGetInstance = IOSCtrlProxyClient.getInstance;
      IOSCtrlProxyClient.getInstance = (() => ({
        ensureConnected: async () => true,
        requestScreenshot: fakeCtrlProxy.requestScreenshot.bind(fakeCtrlProxy),
      })) as typeof IOSCtrlProxyClient.getInstance;

      const writer = new FakeScreenshotFileWriter();
      try {
        const screenshot = new TakeScreenshot(
          iosDevice,
          new FakeAdbClientFactory(new FakeAdbExecutor()),
          new FakeTimer(),
          new CountingIdGenerator("capture"),
          writer,
        );
        let streamPushes = 0;
        (screenshot as any).pushScreenshotToStream = () => {
          streamPushes++;
        };

        const result = await (screenshot as any).captureiOSScreenshot(
          "/private/tmp/ios-pre-cancel.png",
          controller.signal,
        );

        expect(result).toEqual({ success: false, error: OPERATION_CANCELLED_MESSAGE });
        expect(fakeCtrlProxy.getScreenshotRequestSignals()).toEqual([controller.signal]);
        expect(writer.written).toEqual([]);
        expect(streamPushes).toBe(0);
      } finally {
        IOSCtrlProxyClient.getInstance = originalGetInstance;
      }
    });
  });

  describe("Android file-pull screenshots", function () {
    const androidDevice: BootedDevice = {
      name: "test-device",
      platform: "android",
      deviceId: "android-file-pull",
      source: "local",
    };

    test("rejects a quiet screencap failure before pulling a stale frame and cleans up", async function () {
      const fakeAdb = new FakeAdbExecutor();
      fakeAdb.setCommandResponse("screencap -p", {
        stdout: "AM_SCREENCAP_RC:1",
        stderr: "",
      });
      const screenshot = new TakeScreenshot(
        androidDevice,
        new FakeAdbClientFactory(fakeAdb),
        new FakeTimer(),
        new FakeIdGenerator(["quiet-failure"]),
      );

      await expect(
        (screenshot as any).captureScreenshotFilePull("/private/tmp/quiet-failure.png", {
          format: "png",
        }),
      ).rejects.toThrow("Screencap failed");

      const commands = fakeAdb.getExecutedCommands();
      expect(commands.some((command) => command.startsWith("pull "))).toBe(false);
      expect(commands).toContain("shell rm -f /sdcard/screenshot_quiet-failure.png");
    });

    test("uses and removes a unique device-side file for every successful file pull", async function () {
      const fakeAdb = new FakeAdbExecutor();
      fakeAdb.setCommandResponse("screencap -p", {
        stdout: "AM_SCREENCAP_RC:0",
        stderr: "",
      });
      const localDir = await fsPromises.mkdtemp("/private/tmp/auto-mobile-screenshot-");
      const screenshot = new TakeScreenshot(
        androidDevice,
        new FakeAdbClientFactory(fakeAdb),
        new FakeTimer(),
        new FakeIdGenerator(["first", "second"]),
      );
      const firstPath = path.join(localDir, "first.png");
      const secondPath = path.join(localDir, "second.png");

      try {
        await fsPromises.writeFile(`${firstPath}.temp`, "first");
        await (screenshot as any).captureScreenshotFilePull(firstPath, { format: "png" });
        await fsPromises.writeFile(`${secondPath}.temp`, "second");
        await (screenshot as any).captureScreenshotFilePull(secondPath, { format: "png" });

        const screencaps = fakeAdb
          .getExecutedCommands()
          .filter((command) => command.includes("screencap -p"));
        const removals = fakeAdb
          .getExecutedCommands()
          .filter((command) => command.startsWith("shell rm -f "));
        const pulls = fakeAdb
          .getExecutedCommands()
          .filter((command) => command.startsWith("pull "));

        expect(screencaps).toHaveLength(2);
        expect(screencaps[0]).toContain("/sdcard/screenshot_first.png");
        expect(screencaps[1]).toContain("/sdcard/screenshot_second.png");
        expect(removals).toEqual([
          "shell rm -f /sdcard/screenshot_first.png",
          "shell rm -f /sdcard/screenshot_second.png",
        ]);
        expect(pulls).toEqual([
          `pull /sdcard/screenshot_first.png ${firstPath}.temp`,
          `pull /sdcard/screenshot_second.png ${secondPath}.temp`,
        ]);
      } finally {
        await fsPromises.rm(localDir, { recursive: true, force: true });
      }
    });
  });
});
