import { beforeEach, describe, expect, test } from "bun:test";
import { TakeScreenshot } from "../../../src/features/observe/TakeScreenshot";
import { BootedDevice } from "../../../src/models/DeviceInfo";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeFileSystem } from "../../fakes/FakeFileSystem";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { CountingIdGenerator } from "../../../src/utils/IdGenerator";
import { IOSCtrlProxyClient } from "../../../src/features/observe/ios";
import { OPERATION_CANCELLED_MESSAGE } from "../../../src/utils/constants";

describe("TakeScreenshot", function() {
  describe("Unit Tests for Extracted Methods", function() {
    let takeScreenshot: TakeScreenshot;
    let fakeAdb: FakeAdbExecutor;
    let mockDevice: BootedDevice;

    beforeEach(function() {
      mockDevice = {
        name: "test-device",
        platform: "android",
        deviceId: "test-device-id",
        source: "local"
      };

      // Create a simple fake ADB for unit testing
      fakeAdb = new FakeAdbExecutor();
      const fakeFactory = new FakeAdbClientFactory(fakeAdb);
      takeScreenshot = new TakeScreenshot(mockDevice, fakeFactory);
    });

    test("should generate correct screenshot path with png format", function() {
      const timestamp = 1234567890123;
      const options = { format: "png" as const };

      const result = takeScreenshot.generateScreenshotPath(timestamp, options);

      expect(result).toContain("screenshot_1234567890123");
      expect(result).toMatch(/screenshot_1234567890123_[^.]+\.png$/);
    });

    test("should generate correct screenshot path with webp format", function() {
      const timestamp = 1234567890456;
      const options = { format: "webp" as const };

      const result = takeScreenshot.generateScreenshotPath(timestamp, options);

      expect(result).toContain("screenshot_1234567890456");
      expect(result).toMatch(/screenshot_1234567890456_[^.]+\.webp$/);
    });

    test("should generate different timestamps for consecutive calls", async function() {
      const fakeTimer = new FakeTimer();
      const timestamp1 = fakeTimer.now();
      const options = { format: "png" as const };

      const result1 = takeScreenshot.generateScreenshotPath(timestamp1, options);
      fakeTimer.advanceTime(1);
      const timestamp2 = fakeTimer.now();
      const result2 = takeScreenshot.generateScreenshotPath(timestamp2, options);

      expect(result1).not.toBe(result2);
    });

    test("uses an injected unique suffix when captures share a timestamp", function() {
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

      expect(first).toMatch(/screenshot_1234567890123_capture-1\.png$/);
      expect(second).toMatch(/screenshot_1234567890123_capture-2\.png$/);
      expect(first).not.toBe(second);
    });

    test("should use single optimized ADB command for screenshot capture", async function() {
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

  describe("iOS cancellation", function() {
    test("does not write or publish a screenshot after the request is cancelled", async function() {
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
  });

});
