import { describe, expect, test } from "bun:test";
import { GetDumpsysWindow } from "../../../src/features/observe/GetDumpsysWindow";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeLogger } from "../../fakes/FakeLogger";
import { FakeTimer } from "../../fakes/FakeTimer";
import type { BootedDevice } from "../../../src/models";

describe("GetDumpsysWindow", () => {
  test("logs disk cache read failures before refreshing from adb", async () => {
    // The logger is injected rather than monkey-patched onto the shared
    // singleton -- see
    // [issue #4134](https://github.com/kaeawc/auto-mobile/issues/4134).
    // The previous version replaced `logger.debug` process-wide and asserted an
    // exact total, so any other test logging while this one held the patch
    // appended into its array; CI once observed 25 entries instead of 1. A fake
    // instance is unreachable by other tests, so the race cannot occur.
    const fakeLogger = new FakeLogger();
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
      new FakeTimer(),
      fakeLogger
    );

    const result = await dumpsysWindow.execute();

    expect(result.stdout).toBe("mCurrentFocus=Window{test}");

    // Assert the specific diagnostic rather than a total count. Even scoped to
    // this instance, a bare length check would pin every trace the class emits
    // and break when an unrelated one is added.
    const cacheReadFailures = fakeLogger.messages.filter(
      entry => entry.level === "debug"
        && entry.message.includes("Failed to read dumpsys window disk cache")
    );
    expect(cacheReadFailures).toHaveLength(1);
    expect(cacheReadFailures[0].message).toContain(device.deviceId);
  });
});
