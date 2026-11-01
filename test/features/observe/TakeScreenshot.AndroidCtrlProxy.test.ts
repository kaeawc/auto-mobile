import { createExecResult } from "../../../src/utils/execResult";
import { beforeEach, describe, expect, test, spyOn } from "bun:test";
import { useScratchRoot } from "../../helpers/scratchRoot";
import { readFileSync } from "node:fs";
import { TakeScreenshot } from "../../../src/features/observe/TakeScreenshot";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android";
import { FakeAndroidPhysicalDisplayIdResolver } from "../../fakes/FakeAndroidPhysicalDisplayIdResolver";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { mockDevice } from "./takeScreenshotTestHelpers";
import { FakeCtrlProxy } from "../../fakes/FakeCtrlProxy";
import type { ScreenshotResult } from "../../../src/features/observe/android";

describe("TakeScreenshot Android CtrlProxy and fallback paths", function () {
  let cacheDir: string;
  const scratch = useScratchRoot("am-shot-test-");
  beforeEach(() => {
    cacheDir = scratch.next();
  });

  test("tracks WebP metadata when requested", async function () {
    const fakeAdb = new FakeAdbExecutor();
    const screenshot = new TakeScreenshot(mockDevice, {
      adbFactory: new FakeAdbClientFactory(fakeAdb),
      cacheDirResolver: () => cacheDir,
    });
    const ctrlProxy = new FakeCtrlProxy();
    spyOn(ctrlProxy, "requestScreenshot").mockImplementation(async () => ({
      success: false,
      error: "CtrlProxy unavailable",
    }));
    const getInstance = spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue(ctrlProxy);
    fakeAdb.setDefaultResponse(
      createExecResult(
        readFileSync("test/fixtures/screenshots/black-on-white.png").toString("base64"),
        "",
      ),
    );
    try {
      const result = await screenshot.execute({ format: "webp" });
      expect(result.success).toBe(true);
      expect(result.path).toMatch(/\.webp$/);
      expect(result.screenshotFormat).toBe("webp");
      expect(result.screenshotMimeType).toBe("image/webp");
    } finally {
      getInstance.mockRestore();
    }
  });

  test("persists native Android CtrlProxy JPEG as jpg with metadata", async () => {
    const fakeAdb = new FakeAdbExecutor();
    const screenshot = new TakeScreenshot(mockDevice, {
      adbFactory: new FakeAdbClientFactory(fakeAdb),
      cacheDirResolver: () => cacheDir,
    });
    const ctrlProxy = new FakeCtrlProxy();
    spyOn(ctrlProxy, "requestScreenshot").mockImplementation(async () => ({
      success: true,
      data: Buffer.from([0xff, 0xd8, 0xff, 0xe0]).toString("base64"),
      format: "jpeg",
    }));
    const getInstance = spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue(ctrlProxy);
    try {
      const result = await screenshot.execute({ format: "jpeg" });
      expect(result.success).toBe(true);
      expect(result.path).toMatch(/\.jpg$/);
      expect(result.screenshotFormat).toBe("jpeg");
      expect(result.screenshotMimeType).toBe("image/jpeg");
      expect(fakeAdb.getExecutedCommands()).toHaveLength(0);
    } finally {
      getInstance.mockRestore();
    }
  });

  test("captures requested PNG on the selected Android display through screencap", async () => {
    const fakeAdb = new FakeAdbExecutor();
    const screenshot = new TakeScreenshot(mockDevice, {
      adbFactory: new FakeAdbClientFactory(fakeAdb),
      cacheDirResolver: () => cacheDir,
      physicalDisplayIdResolver: new FakeAndroidPhysicalDisplayIdResolver(
        new Map([[2, "4619827259835644673"]]),
      ),
    });
    let ctrlProxyCalled = false;
    const ctrlProxy = new FakeCtrlProxy();
    spyOn(ctrlProxy, "requestScreenshot").mockImplementation(async () => {
      ctrlProxyCalled = true;
      return { success: false };
    });
    const getInstance = spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue(ctrlProxy);
    fakeAdb.setDefaultResponse(
      createExecResult(
        readFileSync("test/fixtures/screenshots/black-on-white.png").toString("base64"),
        "",
      ),
    );
    try {
      const result = await screenshot.execute({ format: "png", displayId: 2 });
      expect(result.success).toBe(true);
      expect(result.screenshotFormat).toBe("png");
      expect(result.path).toMatch(/\.png$/);
      expect(ctrlProxyCalled).toBe(false);
      expect(
        fakeAdb.getExecutedCommands().find((command) => command.includes("screencap")),
      ).toContain("screencap -d 4619827259835644673 -p");
    } finally {
      getInstance.mockRestore();
    }
  });

  test("keeps the ADB fallback as PNG", async () => {
    const fakeAdb = new FakeAdbExecutor();
    const screenshot = new TakeScreenshot(mockDevice, {
      adbFactory: new FakeAdbClientFactory(fakeAdb),
      cacheDirResolver: () => cacheDir,
    });
    const ctrlProxy = new FakeCtrlProxy();
    spyOn(ctrlProxy, "requestScreenshot").mockImplementation(async () => ({
      success: false,
      error: "CtrlProxy unavailable",
    }));
    const getInstance = spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue(ctrlProxy);
    fakeAdb.setDefaultResponse(
      createExecResult(
        readFileSync("test/fixtures/screenshots/black-on-white.png").toString("base64"),
        "",
      ),
    );
    try {
      const result = await screenshot.execute({});
      expect(result.success).toBe(true);
      expect(result.path).toMatch(/\.png$/);
      expect(result.screenshotFormat).toBe("png");
      expect(result.screenshotMimeType).toBe("image/png");
    } finally {
      getInstance.mockRestore();
    }
  });

  test("should use single optimized ADB command for screenshot capture", async function () {
    const testFakeAdb = new FakeAdbExecutor();
    testFakeAdb.setDefaultResponse(
      createExecResult(
        readFileSync("test/fixtures/screenshots/black-on-white.png").toString("base64"),
        "",
      ),
    );
    const screenshot = new TakeScreenshot(mockDevice, {
      adbFactory: new FakeAdbClientFactory(testFakeAdb),
      cacheDirResolver: () => cacheDir,
    });
    const result = await screenshot.execute();
    const executedCommands = testFakeAdb.getExecutedCommands();
    const captureCommand = executedCommands.find((command) => command.includes("screencap"));
    expect(captureCommand).toMatch(/screencap -p \/data\/local\/tmp\/am-shot-/);
    expect(captureCommand).toContain("base64");
    expect(captureCommand).toContain("rm");
    expect(result.success).toBe(true);
  });

  describe("with the prototype hidden (#9305)", () => {
    const pngFixture = () => readFileSync("test/fixtures/screenshots/black-on-white.png");

    const capture = async (
      reply: ScreenshotResult,
      options: Parameters<TakeScreenshot["execute"]>[0],
    ) => {
      const fakeAdb = new FakeAdbExecutor();
      fakeAdb.setDefaultResponse(createExecResult(pngFixture().toString("base64"), ""));
      const screenshot = new TakeScreenshot(mockDevice, {
        adbFactory: new FakeAdbClientFactory(fakeAdb),
        cacheDirResolver: () => cacheDir,
      });
      const calls: Parameters<FakeCtrlProxy["requestScreenshot"]>[] = [];
      const ctrlProxy = new FakeCtrlProxy();
      spyOn(ctrlProxy, "requestScreenshot").mockImplementation(
        async (...args: Parameters<FakeCtrlProxy["requestScreenshot"]>) => {
          calls.push(args);
          return reply;
        },
      );
      const getInstance = spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue(ctrlProxy);
      try {
        const result = await screenshot.execute(options);
        return { result, calls, adbCommands: fakeAdb.getExecutedCommands() };
      } finally {
        getInstance.mockRestore();
      }
    };

    test("captures through CtrlProxy in the requested format and reports the prototype hidden", async () => {
      const { result, calls, adbCommands } = await capture(
        { success: true, data: pngFixture().toString("base64"), prototypesHidden: true },
        { format: "png", displayId: 1, hidePrototypes: true },
      );
      expect(result).toMatchObject({
        success: true,
        prototypesHidden: true,
        screenshotFormat: "png",
        screenshotMimeType: "image/png",
      });
      expect(result.path).toMatch(/\.png$/);
      expect(readFileSync(result.path!)).toEqual(pngFixture());
      // displayId and hidePrototypes reach the client; nothing goes through ADB screencap.
      expect(calls[0]?.[2]?.displayId).toBe(1);
      expect(calls[0]?.[2]?.hidePrototypes).toBe(true);
      expect(adbCommands).toHaveLength(0);
    });

    test("keeps the device's own bytes when no format is requested", async () => {
      const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
      const { result } = await capture(
        { success: true, data: jpeg.toString("base64"), format: "jpeg", prototypesHidden: true },
        { hidePrototypes: true },
      );
      expect(result).toMatchObject({
        success: true,
        prototypesHidden: true,
        screenshotFormat: "jpeg",
      });
      expect(result.path).toMatch(/\.jpg$/);
      expect(readFileSync(result.path!)).toEqual(jpeg);
    });

    test.each([
      ["the device could not confirm the hide", { prototypesHidden: false }],
      ["the device predates the flag", {}],
    ])("fails without an ADB fallback when %s", async (_, reply) => {
      const { result, adbCommands } = await capture(
        { success: true, data: pngFixture().toString("base64"), ...reply },
        { format: "png", hidePrototypes: true },
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain("could not confirm its prototype was hidden");
      expect(adbCommands).toHaveLength(0);
    });

    test("a failed CtrlProxy capture fails without an ADB fallback", async () => {
      const { result, adbCommands } = await capture(
        { success: false, error: "rate limited" },
        { format: "png", hidePrototypes: true },
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain("rate limited");
      expect(adbCommands).toHaveLength(0);
    });
  });
});
