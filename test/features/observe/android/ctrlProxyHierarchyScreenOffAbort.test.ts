import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { CtrlProxyHierarchy } from "../../../../src/features/observe/android/CtrlProxyHierarchy";
import type { HierarchyDelegateContext } from "../../../../src/features/observe/android/types";
import { RequestManager } from "../../../../src/utils/RequestManager";
import { FakeTimer } from "../../../fakes/FakeTimer";
import { logger } from "../../../../src/utils/logger";

function createHarness(isScreenOn: (signal?: AbortSignal) => Promise<boolean>) {
  const timer = new FakeTimer();
  const context: HierarchyDelegateContext = {
    getWebSocket: () => null,
    requestManager: new RequestManager(timer),
    timer,
    ensureConnected: async () => true,
    cancelScreenshotBackoff: () => {},
    device: { deviceId: "emulator-5554", platform: "android" } as never,
    adb: { isScreenOn } as never,
    getCachedHierarchy: () => null,
    setCachedHierarchy: () => {},
    getLastWebSocketTimeout: () => 0,
    setLastWebSocketTimeout: () => {},
  };
  const hierarchy = new CtrlProxyHierarchy(context);
  const waitForFreshData = (signal?: AbortSignal) =>
    (
      hierarchy as never as {
        waitForFreshData: (
          timeout: number,
          minTimestamp: number,
          useDeviceTimestamp: boolean,
          signal?: AbortSignal,
        ) => Promise<null>;
      }
    ).waitForFreshData(10_000, 0, false, signal);
  return { hierarchy, timer, waitForFreshData };
}

describe("CtrlProxyHierarchy screen-off check with caller abort", () => {
  let warnSpy: ReturnType<typeof spyOn> | undefined;

  afterEach(() => {
    warnSpy?.mockRestore();
    warnSpy = undefined;
  });

  test("suppresses an in-flight screen-off warning after the caller aborts", async () => {
    let resolveScreenCheck: ((value: boolean) => void) | undefined;
    const h = createHarness(
      () =>
        new Promise<boolean>((resolve) => {
          resolveScreenCheck = resolve;
        }),
    );
    const controller = new AbortController();
    warnSpy = spyOn(logger, "warn");
    const result = h.waitForFreshData(controller.signal);

    await h.timer.advanceTimeAsync(1000);
    expect(resolveScreenCheck).toBeDefined();
    controller.abort(new Error("caller cancelled"));
    resolveScreenCheck?.(false);
    await Promise.resolve();
    await h.timer.advanceTimeAsync(50);

    expect(await result).toBeNull();
    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining("Screen is off"));
  });

  test("still fails fast when the screen is off without an abort", async () => {
    const h = createHarness(async () => false);
    warnSpy = spyOn(logger, "warn");
    const result = h.waitForFreshData();

    await h.timer.advanceTimeAsync(1000);

    expect(await result).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      "[CTRL_PROXY] Screen is off - failing fast instead of waiting for timeout",
    );
  });
});
