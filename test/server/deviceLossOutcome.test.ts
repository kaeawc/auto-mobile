import { describe, expect, test } from "bun:test";
import {
  DEVICE_LOSS_OUTCOME_CODE,
  DeviceLostError,
  deviceLostErrorFromCancellationReason,
  deviceLossOutcomeFromError,
} from "../../src/server/deviceLossOutcome";

describe("device-loss outcome", () => {
  test("makes confirmed device loss distinguishable from an ordinary tool failure", () => {
    const error = new DeviceLostError("emulator-5554", "device-disconnected:emulator-5554");

    expect(deviceLossOutcomeFromError(error, "session-a")).toEqual({
      code: DEVICE_LOSS_OUTCOME_CODE,
      deviceId: "emulator-5554",
      sessionUuid: "session-a",
      reason: "confirmed-unavailable",
    });
    expect(deviceLossOutcomeFromError(new Error("tap failed"), "session-a")).toBeUndefined();
  });

  test("preserves the emulator-loss incident correlation identifier", () => {
    const error = deviceLostErrorFromCancellationReason(
      "device-disconnected:emulator-5554;incident=emulator-loss-test-1",
    );

    expect(deviceLossOutcomeFromError(error, "session-a")).toEqual({
      code: DEVICE_LOSS_OUTCOME_CODE,
      deviceId: "emulator-5554",
      sessionUuid: "session-a",
      incidentId: "emulator-loss-test-1",
      reason: "confirmed-unavailable",
    });
  });
});
