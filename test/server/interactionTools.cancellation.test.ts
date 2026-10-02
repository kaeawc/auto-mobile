import { cancellationHandlers, cancellationTests } from "../helpers/interactionCancellation";
import { describe, expect, spyOn } from "bun:test";
import type { BootedDevice } from "../../src/models";
import { DOUBLE_TAP_GAP_MS } from "../../src/features/action/tapAtGesture";
import {
  resetTapAtElementFactory,
  resetTapOnElementFactory,
  resetTapAnyElementFactory,
  resetDragAndDropFactory,
  setTapAtElementFactory,
  setTapOnElementFactory,
  setTapAnyElementFactory,
  setDragAndDropFactory,
} from "../../src/server/interactionTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { FakeTimer } from "../fakes/FakeTimer";
import { createTapAt } from "../helpers/tapAtCoordinate";

const devices = [
  { name: "Android test device", platform: "android", deviceId: "emulator-5554" },
  { name: "iOS test device", platform: "ios", deviceId: "ios-test-device" },
] as BootedDevice[];

const registeredHandler = cancellationHandlers(["tapAt", "tapOn", "tapAny", "dragAndDrop"]);

describe("registered interaction handler cancellation", () => {
  const test = cancellationTests(() => {
    resetTapAtElementFactory();
    resetTapOnElementFactory();
    resetTapAnyElementFactory();
    resetDragAndDropFactory();
    ToolRegistry.clearTools();
  });

  test.each(devices)(
    "tapAt cancels during the double-tap gap on %s",
    async (device) => {
      const { tapAt, timer, androidDispatches, iosDispatches } = createTapAt(device);
      setTapAtElementFactory(() => tapAt);
      const gapTimer = new FakeTimer();
      const controller = new AbortController();
      let gapStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        gapStarted = resolve;
      });
      const sleep = spyOn(timer, "sleep").mockImplementation((ms) => {
        expect(ms).toBe(DOUBLE_TAP_GAP_MS);
        const pending = gapTimer.sleep(ms);
        gapStarted();
        return pending;
      });
      try {
        const pending = registeredHandler("tapAt")(
          device,
          { x: 1, y: 2, action: "doubleTap" },
          undefined,
          controller.signal,
        );
        await started;
        const dispatches = device.platform === "android" ? androidDispatches : iosDispatches;
        expect(dispatches).toHaveLength(1);
        gapTimer.advanceTime(DOUBLE_TAP_GAP_MS / 2);
        controller.abort();
        // Settle while the gap sleep is still pending: cancellation must not wait for it.
        expect(await pending).toMatchObject({ isError: true });
        expect(dispatches).toHaveLength(1);
        gapTimer.advanceTime(DOUBLE_TAP_GAP_MS / 2);
        await Promise.resolve();
        expect(dispatches).toHaveLength(1);
      } finally {
        gapTimer.resolveAll();
        sleep.mockRestore();
      }
    },
    100,
  );

  test.each(devices)("pre-aborted tapAt dispatches nothing on %s", async (device) => {
    const { tapAt, androidDispatches, iosDispatches } = createTapAt(device);
    setTapAtElementFactory(() => tapAt);
    const controller = new AbortController();
    controller.abort();
    const response = await registeredHandler("tapAt")(
      device,
      { x: 1, y: 2, action: "doubleTap" },
      undefined,
      controller.signal,
    );
    expect(response).toMatchObject({ isError: true });
    expect(androidDispatches).toHaveLength(0);
    expect(iosDispatches).toHaveLength(0);
  });

  test("tapAt forwards the exact signal to execute", async () => {
    let received: AbortSignal | undefined;
    setTapAtElementFactory(() => ({
      execute: async (options, _progress, signal) => {
        received = signal;
        return { success: true, x: options.x, y: options.y, action: "doubleTap" };
      },
    }));
    const controller = new AbortController();
    await registeredHandler("tapAt")(
      devices[0]!,
      { x: 1, y: 2, action: "doubleTap" },
      undefined,
      controller.signal,
    );
    expect(received).toBe(controller.signal);
  });

  test.each(["tapOn", "tapAny", "dragAndDrop"])("%s forwards the exact signal", async (name) => {
    let received: AbortSignal | undefined;
    const sentinel = new Error("fake command stopped");
    const execute = async (
      _options: unknown,
      _progress: unknown,
      signal?: AbortSignal,
    ): Promise<never> => {
      received = signal;
      throw sentinel;
    };
    if (name === "tapOn") {
      setTapOnElementFactory(() => ({ execute }));
    }
    if (name === "tapAny") {
      setTapAnyElementFactory(() => ({ execute }));
    }
    if (name === "dragAndDrop") {
      setDragAndDropFactory(() => ({ execute }));
    }
    const controller = new AbortController();
    await expect(
      registeredHandler(name)(
        devices[0]!,
        { selector: { text: "Target" }, action: "tap" },
        undefined,
        controller.signal,
      ),
    ).rejects.toBe(sentinel);
    expect(received).toBe(controller.signal);
  });
});
