import { DEFAULT_GESTURE_REQUEST_TIMEOUT_MS } from "../../../src/features/observe/shared/SharedGestureDelegate";
import { resolveGestureCtrlProxyTimeoutMs } from "../../../src/features/action/gestureTransportTimeout";
import { describe, expect, mock, test } from "bun:test";
import { LONG_PRESS_TIMEOUT_HEADROOM_MS } from "../../../src/features/action/gestureTransportTimeout";
import { MAX_SETTIMEOUT_DELAY_MS } from "../../../src/utils/SystemTimer";
import { ActionableError } from "../../../src/models";
import {
  androidDisplayTapDispatch,
  dispatchAndroidCoordinateTap,
  dispatchIosCoordinateTap,
  type CoordinateTapClient,
} from "../../../src/features/action/coordinateTapDispatch";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { LONG_PRESS_MIN_MS } from "../../../src/features/action/tapAtGesture";
import { observation } from "../../helpers/tapAtCoordinate";
import { OPERATION_CANCELLED_MESSAGE } from "../../../src/utils/constants";

describe("dispatchAndroidCoordinateTap", () => {
  test.each([undefined, "frame-123"])(
    "does not replay a dispatched tap when its response is lost (frame %s)",
    async (frameContext) => {
      const adb = new FakeAdbExecutor();
      const client: CoordinateTapClient<() => void> = {
        requestTapCoordinates: async (_x, _y, _duration, _timeout, _perf, frame, onDispatch) => {
          expect(frame).toBe(frameContext);
          onDispatch?.();
          return { success: false, error: "Tap timed out after 5000ms" };
        },
      };

      const request = dispatchAndroidCoordinateTap(client, adb, 10, 20, 10, frameContext);

      await expect(request).rejects.toBeInstanceOf(ActionableError);
      await expect(request).rejects.toThrow(
        /outcome is indeterminate.*Do not retry automatically/i,
      );
      expect(adb.getExecutedCommands()).toEqual([]);
    },
  );

  test("falls back to ADB for a failure before dispatch", async () => {
    const adb = new FakeAdbExecutor();
    const client: CoordinateTapClient = {
      requestTapCoordinates: async () => ({ success: false, error: "Not connected" }),
    };

    await dispatchAndroidCoordinateTap(client, adb, 10, 20, 10);

    expect(adb.getExecutedCommands()).toEqual(["shell input touchscreen tap 10 20"]);
    expect(adb.getCommandCalls()[0].timeoutMs).toBeUndefined();
  });

  test("uses the shared long-press boundary for the ADB fallback", async () => {
    const adb = new FakeAdbExecutor();
    const client: CoordinateTapClient = {
      requestTapCoordinates: async () => ({ success: false, error: "Not connected" }),
    };

    await dispatchAndroidCoordinateTap(client, adb, 10, 20, LONG_PRESS_MIN_MS - 1);
    await dispatchAndroidCoordinateTap(client, adb, 10, 20, LONG_PRESS_MIN_MS);

    expect(adb.getExecutedCommands()).toEqual([
      "shell input touchscreen tap 10 20",
      `shell input touchscreen swipe 10 20 10 20 ${LONG_PRESS_MIN_MS}`,
    ]);
    expect(adb.getCommandCalls()[0].timeoutMs).toBeUndefined();
    expect(adb.getCommandCalls()[1].timeoutMs).toBeDefined();
  });

  test.each([false, true])(
    "covers a long press in the ADB fallback (fenced %s)",
    async (fenced) => {
      const adb = new FakeAdbExecutor();
      const client: CoordinateTapClient = {
        requestTapCoordinates: async () => ({ success: false, error: "Not connected" }),
      };

      await dispatchAndroidCoordinateTap(
        client,
        adb,
        10,
        20,
        20000,
        undefined,
        undefined,
        fenced ? () => {} : undefined,
      );

      expect(adb.getCommandCalls()[0].timeoutMs).toBeGreaterThanOrEqual(22000);
    },
  );

  test("does not fall back to ADB on a successful tap", async () => {
    const adb = new FakeAdbExecutor();
    const client: CoordinateTapClient = {
      requestTapCoordinates: async () => ({ success: true }),
    };

    await dispatchAndroidCoordinateTap(client, adb, 10, 20, 10);

    expect(adb.getExecutedCommands()).toEqual([]);
  });
});

describe("androidDisplayTapDispatch", () => {
  const target = {
    observation: {
      ...observation(100, 200),
      display: { key: "inner", role: "inner", posture: "opened", generation: 7 } as const,
    },
    displayId: 2,
    assertCurrent: () => {},
  };

  test.each(["Not connected", undefined])(
    "preserves a plain failure before dispatch (%s)",
    async (error) => {
      const adb = new FakeAdbExecutor();
      const onDispatched = mock(() => {});
      const client: Parameters<typeof androidDisplayTapDispatch>[0] = {
        supportsCommand: async (name) => name === "gesture_display_id_v1",
        requestTapCoordinates: async () => ({ success: false, error }),
      };
      const dispatch = await androidDisplayTapDispatch(
        client,
        adb,
        { action: "tap" },
        {
          target,
          onDispatched,
        },
      );

      const request = dispatch({ x: 10, y: 20 });

      await expect(request).rejects.toBeInstanceOf(ActionableError);
      await expect(request).rejects.toThrow(error ?? "Android tap failed");
      await expect(request).rejects.not.toThrow(/indeterminate/i);
      expect(onDispatched).not.toHaveBeenCalled();
      expect(adb.getExecutedCommands()).toEqual([]);
    },
  );

  test.each(["Tap timed out after 5000ms", "runner rejected", "Stale frame context", undefined])(
    "does not replay a dispatched tap after failure (%s)",
    async (error) => {
      const adb = new FakeAdbExecutor();
      const onDispatched = mock(() => {});
      const client: Parameters<typeof androidDisplayTapDispatch>[0] = {
        supportsCommand: async (name) => name === "gesture_display_id_v1",
        requestTapCoordinates: async (_x, _y, _duration, _timeout, _perf, frame, onDispatch) => {
          expect(frame).toBeUndefined();
          expect(onDispatch).toBeFunction();
          onDispatch?.();
          return { success: false, error };
        },
      };
      const dispatch = await androidDisplayTapDispatch(
        client,
        adb,
        { action: "tap" },
        {
          target,
          onDispatched,
        },
      );

      const request = dispatch({ x: 10, y: 20 });

      await expect(request).rejects.toBeInstanceOf(ActionableError);
      await expect(request).rejects.toThrow(
        /outcome is indeterminate.*Do not retry automatically/i,
      );
      await expect(request).rejects.toThrow(error ?? "unknown error");
      expect(onDispatched).not.toHaveBeenCalled();
      expect(adb.getExecutedCommands()).toEqual([]);
    },
  );

  test("propagates abort before classifying a dispatched failure", async () => {
    const adb = new FakeAdbExecutor();
    const controller = new AbortController();
    const onDispatched = mock(() => {});
    const client: Parameters<typeof androidDisplayTapDispatch>[0] = {
      supportsCommand: async () => true,
      requestTapCoordinates: async (
        _x,
        _y,
        _duration,
        _timeout,
        _perf,
        _frame,
        onDispatch,
        signal,
      ) => {
        expect(signal).toBe(controller.signal);
        onDispatch?.();
        controller.abort();
        return { success: false, error: "Tap timed out after 5000ms" };
      },
    };
    const dispatch = await androidDisplayTapDispatch(
      client,
      adb,
      { action: "tap" },
      {
        target,
        signal: controller.signal,
        onDispatched,
      },
    );

    const request = dispatch({ x: 10, y: 20 });

    await expect(request).rejects.toBeInstanceOf(Error);
    await expect(request).rejects.toThrow(OPERATION_CANCELLED_MESSAGE);
    await expect(request).rejects.not.toBeInstanceOf(ActionableError);
    await expect(request).rejects.not.toThrow(/indeterminate/i);
    expect(onDispatched).not.toHaveBeenCalled();
    expect(adb.getExecutedCommands()).toEqual([]);
  });

  test("does not attempt the second double tap after an indeterminate first tap", async () => {
    const adb = new FakeAdbExecutor();
    const onDispatched = mock(() => {});
    const requestTapCoordinates = mock<CoordinateTapClient<() => void>["requestTapCoordinates"]>(
      async (_x, _y, _duration, _timeout, _perf, _frame, onDispatch) => {
        onDispatch?.();
        return { success: false, error: "Tap timed out after 5000ms" };
      },
    );
    const dispatch = await androidDisplayTapDispatch(
      { supportsCommand: async () => true, requestTapCoordinates },
      adb,
      { action: "doubleTap" },
      { target, onDispatched },
    );

    await expect(dispatch({ x: 10, y: 20 })).rejects.toThrow(/outcome is indeterminate/i);

    expect(requestTapCoordinates).toHaveBeenCalledTimes(1);
    expect(onDispatched).not.toHaveBeenCalled();
    expect(adb.getExecutedCommands()).toEqual([]);
  });

  test.each([
    ["tap", 2, 1, 10],
    ["doubleTap", 2, 2, 10],
    ["longPress", 2, 1, 800],
    ["tap", 0, 1, 10],
  ] as const)(
    "preserves successful %s routing to display %s",
    async (action, displayId, count, duration) => {
      const adb = new FakeAdbExecutor();
      const onDispatched = mock(() => {});
      const controller = new AbortController();
      const requestTapCoordinates = mock<CoordinateTapClient<() => void>["requestTapCoordinates"]>(
        async (_x, _y, _duration, _timeout, _perf, _frame, onDispatch) => {
          expect(onDispatched).toHaveBeenCalledTimes(requestTapCoordinates.mock.calls.length - 1);
          onDispatch?.();
          return { success: true };
        },
      );
      const dispatch = await androidDisplayTapDispatch(
        { supportsCommand: async () => true, requestTapCoordinates },
        adb,
        { action },
        { target: { ...target, displayId }, signal: controller.signal, onDispatched },
      );

      await dispatch({ x: 10, y: 20 });

      expect(requestTapCoordinates).toHaveBeenCalledTimes(count);
      for (const call of requestTapCoordinates.mock.calls) {
        expect(call).toEqual([
          10,
          20,
          duration,
          duration === 10 ? undefined : resolveGestureCtrlProxyTimeoutMs(duration),
          undefined,
          undefined,
          expect.any(Function),
          controller.signal,
          displayId === 0 ? undefined : displayId,
          target.assertCurrent,
        ]);
      }
      expect(onDispatched).toHaveBeenCalledTimes(count);
      expect(adb.getExecutedCommands()).toEqual([]);
    },
  );

  test.each([
    ["tap", undefined, "tap 10 20", 1, undefined],
    ["longPress", async () => false, "swipe 10 20 10 20 800", 1, undefined],
    ["longPress", async () => false, "swipe 10 20 10 20 20000", 1, 20000],
    ["doubleTap", undefined, "tap 10 20", 2, undefined],
  ] as const)(
    "preserves ADB %s routing without display capability",
    async (action, supportsCommand, input, count, duration) => {
      const adb = new FakeAdbExecutor();
      const onDispatched = mock(() => {});
      const requestTapCoordinates = mock(async () => ({ success: true }));
      const dispatch = await androidDisplayTapDispatch(
        { supportsCommand, requestTapCoordinates },
        adb,
        { action, duration },
        { target, onDispatched },
      );

      await dispatch({ x: 10, y: 20 });

      expect(requestTapCoordinates).not.toHaveBeenCalled();
      expect(adb.getExecutedCommands()).toEqual(
        Array.from({ length: count }, () => `shell input touchscreen -d 2 ${input}`),
      );
      expect(onDispatched).toHaveBeenCalledTimes(count);
      if (action === "longPress" && duration === 20000) {
        expect(adb.getCommandCalls()[0].timeoutMs).toBeGreaterThanOrEqual(22000);
      } else if (action !== "longPress") {
        expect(adb.getCommandCalls()[0].timeoutMs).toBeUndefined();
      }
    },
  );
});

// Both transports must cover the native press plus the canonical tapAny margin.
describe("coordinate tap transport timeouts", () => {
  for (const platform of ["ios", "android"] as const) {
    test.each([
      [500, DEFAULT_GESTURE_REQUEST_TIMEOUT_MS],
      [4000, 4000 + LONG_PRESS_TIMEOUT_HEADROOM_MS],
      [MAX_SETTIMEOUT_DELAY_MS - 1, MAX_SETTIMEOUT_DELAY_MS],
      [MAX_SETTIMEOUT_DELAY_MS + 1, MAX_SETTIMEOUT_DELAY_MS],
    ])(
      `${platform} sizes and clamps a %sms long press to %sms`,
      async (duration, expectedTimeout) => {
        const requestTapCoordinates = mock(
          async (_x: number, _y: number, _duration?: number, _timeout?: number) => ({
            success: true,
          }),
        );
        const client: CoordinateTapClient = { requestTapCoordinates };
        if (platform === "ios") {
          await dispatchIosCoordinateTap(client, 10, 20, duration);
        } else {
          await dispatchAndroidCoordinateTap(client, new FakeAdbExecutor(), 10, 20, duration);
        }
        expect(requestTapCoordinates.mock.calls[0][3]).toBe(expectedTimeout);
      },
    );

    test(`${platform} leaves the ordinary tap timeout undefined`, async () => {
      const requestTapCoordinates = mock(
        async (_x: number, _y: number, _duration?: number, _timeout?: number) => ({
          success: true,
        }),
      );
      const client: CoordinateTapClient = { requestTapCoordinates };
      if (platform === "ios") {
        await dispatchIosCoordinateTap(client, 10, 20, 50);
      } else {
        await dispatchAndroidCoordinateTap(client, new FakeAdbExecutor(), 10, 20, 10);
      }
      expect(requestTapCoordinates.mock.calls[0][3]).toBeUndefined();
    });
  }
});

test.each([500, 4000, MAX_SETTIMEOUT_DELAY_MS])(
  "coordinate dispatchers match tapAny's shared timeout for %sms",
  async (duration) => {
    const requestTapCoordinates = mock(
      async (_x: number, _y: number, _duration?: number, _timeout?: number) => ({ success: true }),
    );
    const client: CoordinateTapClient = { requestTapCoordinates };
    await dispatchIosCoordinateTap(client, 10, 20, duration);
    await dispatchAndroidCoordinateTap(client, new FakeAdbExecutor(), 10, 20, duration);
    for (const call of requestTapCoordinates.mock.calls) {
      expect(call[3]).toBe(resolveGestureCtrlProxyTimeoutMs(duration));
    }
  },
);
