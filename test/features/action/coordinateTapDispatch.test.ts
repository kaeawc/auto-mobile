import { DEFAULT_GESTURE_REQUEST_TIMEOUT_MS } from "../../../src/features/observe/shared/SharedGestureDelegate";
import { resolveGestureCtrlProxyTimeoutMs } from "../../../src/features/action/gestureTransportTimeout";
import { describe, expect, mock, test } from "bun:test";
import { LONG_PRESS_TIMEOUT_HEADROOM_MS } from "../../../src/features/action/gestureTransportTimeout";
import { MAX_SETTIMEOUT_DELAY_MS } from "../../../src/utils/SystemTimer";
import { ActionableError } from "../../../src/models";
import {
  dispatchAndroidCoordinateTap,
  dispatchIosCoordinateTap,
  type CoordinateTapClient,
} from "../../../src/features/action/coordinateTapDispatch";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";

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
  });

  test("does not fall back to ADB on a successful tap", async () => {
    const adb = new FakeAdbExecutor();
    const client: CoordinateTapClient = {
      requestTapCoordinates: async () => ({ success: true }),
    };

    await dispatchAndroidCoordinateTap(client, adb, 10, 20, 10);

    expect(adb.getExecutedCommands()).toEqual([]);
  });
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
