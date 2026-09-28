import { describe, expect, test } from "bun:test";
import { ActionableError } from "../../../src/models";
import {
  dispatchAndroidCoordinateTap,
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
