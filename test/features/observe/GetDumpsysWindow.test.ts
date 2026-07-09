import { afterEach, describe, expect, test } from "bun:test";
import { GetDumpsysWindow } from "../../../src/features/observe/GetDumpsysWindow";
import { logger, type Logger } from "../../../src/utils/logger";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeTimer } from "../../fakes/FakeTimer";
import type { BootedDevice } from "../../../src/models";

describe("GetDumpsysWindow", () => {
  const originalDebug = logger.debug;

  afterEach(() => {
    logger.debug = originalDebug;
  });

  test("logs disk cache read failures before refreshing from adb", async () => {
    const debugLogs: string[] = [];
    logger.debug = ((message: string) => {
      debugLogs.push(message);
    }) as Logger["debug"];
    const fakeAdb = new FakeAdbExecutor();
    fakeAdb.setCommandResponse("shell dumpsys window", {
      stdout: "mCurrentFocus=Window{test}",
      stderr: "",
      toString: () => "mCurrentFocus=Window{test}",
      trim: () => "mCurrentFocus=Window{test}",
      includes: searchString => "mCurrentFocus=Window{test}".includes(searchString),
    });
    const device: BootedDevice = {
      deviceId: `missing-cache-${Date.now()}`,
      platform: "android",
      name: "Pixel",
      isEmulator: true,
    };
    const dumpsysWindow = new GetDumpsysWindow(
      device,
      new FakeAdbClientFactory(fakeAdb),
      new FakeTimer()
    );

    const result = await dumpsysWindow.execute();

    expect(result.stdout).toBe("mCurrentFocus=Window{test}");
    expect(debugLogs).toHaveLength(1);
    expect(debugLogs[0]).toContain("Failed to read dumpsys window disk cache");
  });
});
