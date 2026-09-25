import { describe, expect, test } from "bun:test";
import type { EmulatorLossIncident } from "../../src/daemon/emulatorLossIncident";
import {
  DEVICE_LOSS_OUTCOME_CODE,
  DeviceLostError,
  deviceLostErrorFromCancellationReason,
  deviceLossOutcomeFromError,
  enrichDeviceLossOutcome,
  remainingDeviceLossIncidentWaitMs,
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

  test("keeps a device-restart session resumable while terminal releases require a new session", () => {
    const outcome = deviceLossOutcomeFromError(
      new DeviceLostError("emulator-5554", "device-disconnected:emulator-5554", "emulator-loss-2"),
      "session-a",
    )!;
    const incident: EmulatorLossIncident = {
      id: "emulator-loss-2",
      observedAtMs: 10,
      updatedAtMs: 20,
      deviceId: "emulator-5554",
      avdName: "Pixel_8_API_35",
      detectionPath: "device-discovery-miss",
      session: {
        sessionUuid: "session-a",
        state: "awaiting-device",
        lastHeartbeatMs: 9,
        hasReceivedHeartbeat: true,
        heartbeatTimeoutMs: 10_000,
      },
      recovery: {
        policy: { onLoss: false, maxAttempts: 1 },
        attempts: [],
        outcome: "not-attempted",
      },
    };

    expect(enrichDeviceLossOutcome(outcome, incident)).toMatchObject({
      avdName: "Pixel_8_API_35",
      sessionState: "awaiting-device",
      recovery: { status: "not-attempted", attempts: 0 },
      retry: { sameSession: true, requiresNewSession: false },
    });

    incident.session!.state = "released";
    incident.recovery.outcome = "exhausted";
    incident.recovery.attempts.push({ attempt: 1, outcome: "failed" });
    expect(enrichDeviceLossOutcome(outcome, incident)).toMatchObject({
      sessionState: "released",
      recovery: { status: "exhausted", attempts: 1 },
      retry: { sameSession: false, requiresNewSession: true },
    });
  });

  test("reserves transport headroom when waiting for incident settlement", () => {
    expect(remainingDeviceLossIncidentWaitMs(30_000, 5_000)).toBe(24_000);
    expect(remainingDeviceLossIncidentWaitMs(30_000, 29_500)).toBe(0);
    expect(remainingDeviceLossIncidentWaitMs(undefined, 5_000)).toBeUndefined();
  });
});
