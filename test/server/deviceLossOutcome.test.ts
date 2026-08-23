import { describe, expect, test } from "bun:test";
import {
  DEVICE_LOSS_OUTCOME_CODE,
  DeviceLostError,
  deviceLostErrorFromCancellationReason,
  deviceLossOutcomeFromError,
  enrichDeviceLossOutcome,
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

  test("adds same-session retry guidance from a settled recovery incident", () => {
    const outcome = deviceLossOutcomeFromError(
      new DeviceLostError("emulator-5554", "device-disconnected:emulator-5554", "emulator-loss-1"),
      "session-a",
    )!;

    expect(
      enrichDeviceLossOutcome(outcome, {
        id: "emulator-loss-1",
        observedAtMs: 10,
        updatedAtMs: 20,
        deviceId: "emulator-5554",
        avdName: "Pixel_8_API_35",
        replacementDeviceId: "emulator-5560",
        detectionPath: "device-discovery-miss",
        session: {
          sessionUuid: "session-a",
          state: "active",
          lastHeartbeatMs: 9,
          hasReceivedHeartbeat: true,
          heartbeatTimeoutMs: 10_000,
        },
        recovery: {
          policy: { onLoss: true, maxAttempts: 2 },
          attempts: [{ attempt: 1, outcome: "succeeded" }],
          outcome: "recovered",
        },
      }),
    ).toMatchObject({
      detectionPath: "device-discovery-miss",
      avdName: "Pixel_8_API_35",
      replacementDeviceId: "emulator-5560",
      sessionState: "active",
      recovery: { status: "recovered", attempts: 1 },
      retry: { sameSession: true, requiresNewSession: false },
    });
  });
});
