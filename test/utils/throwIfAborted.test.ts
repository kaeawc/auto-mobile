import { describe, expect, test } from "bun:test";
import { throwIfAborted } from "../../src/utils/toolUtils";
import { OPERATION_CANCELLED_MESSAGE } from "../../src/utils/constants";
import { DeviceLostError, rememberDeviceLossAbort } from "../../src/server/deviceLossOutcome";

describe("throwIfAborted", () => {
  test("throws the cancellation error when the signal is already aborted", () => {
    const controller = new AbortController();
    controller.abort();
    expect(() => throwIfAborted(controller.signal)).toThrow(OPERATION_CANCELLED_MESSAGE);
  });

  test("preserves the typed device-loss cancellation reason", () => {
    const controller = new AbortController();
    const deviceLoss = new DeviceLostError("emulator-5554", "device-disconnected:emulator-5554");
    controller.abort(deviceLoss);

    expect(() => throwIfAborted(controller.signal)).toThrow(deviceLoss);
  });

  test("preserves tracked device loss when AbortSignal.reason is unavailable", () => {
    // Regression for the device-loss fallback (issue #3909): Bun can report a
    // signal as aborted while its `reason` does not surface the typed
    // DeviceLostError. throwIfAborted must then recover the tracked device loss via
    // the remembered-abort seam instead of throwing a generic cancellation.
    //
    // The signal is aborted plainly, so `signal.reason` is a DOMException rather
    // than a DeviceLostError — the exact `isDeviceLostError(reason) === false`
    // condition that drives the WeakMap fallback. This is fully deterministic and
    // avoids redefining `reason` on a native AbortSignal, which was a non-portable,
    // uncaught hazard: the property descriptor of `AbortSignal.prototype.reason`
    // differs across Bun versions/platforms, so `Object.defineProperty` could throw
    // on some runners (a cross-platform flake), and it sat outside the try/catch.
    const controller = new AbortController();
    controller.abort();
    const deviceLoss = new DeviceLostError("emulator-5554", "device-disconnected:emulator-5554");
    rememberDeviceLossAbort(controller.signal, deviceLoss);

    let thrown: unknown;
    try {
      throwIfAborted(controller.signal);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBe(deviceLoss);
    expect(thrown).toBeInstanceOf(DeviceLostError);
  });

  test("does not throw when the signal is not aborted", () => {
    const controller = new AbortController();
    expect(() => throwIfAborted(controller.signal)).not.toThrow();
  });

  test("does not throw when no signal is provided", () => {
    expect(() => throwIfAborted(undefined)).not.toThrow();
  });
});
