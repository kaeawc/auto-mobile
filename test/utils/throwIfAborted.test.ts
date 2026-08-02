import { describe, expect, test } from "bun:test";
import { throwIfAborted } from "../../src/utils/toolUtils";
import { OPERATION_CANCELLED_MESSAGE } from "../../src/utils/constants";
import { DeviceLostError } from "../../src/server/deviceLossOutcome";

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

  test("does not throw when the signal is not aborted", () => {
    const controller = new AbortController();
    expect(() => throwIfAborted(controller.signal)).not.toThrow();
  });

  test("does not throw when no signal is provided", () => {
    expect(() => throwIfAborted(undefined)).not.toThrow();
  });
});
