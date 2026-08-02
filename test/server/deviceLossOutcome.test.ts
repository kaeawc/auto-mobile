import { describe, expect, test } from "bun:test";
import {
  DEVICE_LOSS_OUTCOME_CODE,
  DeviceLostError,
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
});
