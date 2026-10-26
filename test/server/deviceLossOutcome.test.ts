import type { DeviceLossOutcome } from "../../src/utils/deviceLossOutcome";
import { describe, expect, test } from "bun:test";
import type { EmulatorLossIncident } from "../../src/daemon/emulatorLossIncident";
import {
  DEVICE_LOSS_OUTCOME_CODE,
  DeviceLostError,
  deviceLostErrorFromCancellationReason,
  deviceLossOutcomeFromError,
  enrichDeviceLossOutcome,
  enrichDeviceLossOutcomeFromSession,
  remainingDeviceLossIncidentWaitMs,
} from "../../src/utils/deviceLossOutcome";

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

describe("live session device-loss evidence", () => {
  const outcome: DeviceLossOutcome = {
    code: DEVICE_LOSS_OUTCOME_CODE,
    deviceId: "a",
    sessionUuid: "s",
    reason: "confirmed-unavailable" as const,
  };
  test("a moved session without an incident is recovered on the same UUID", () => {
    expect(enrichDeviceLossOutcomeFromSession(outcome, { assignedDevice: "b" })).toMatchObject({
      replacementDeviceId: "b",
      sessionState: "active",
      recovery: { status: "recovered", attempts: 0 },
      retry: { sameSession: true, requiresNewSession: false },
    });
  });
  test("pending incident keeps its assessment while reporting a moved session", () => {
    expect(
      enrichDeviceLossOutcomeFromSession(
        {
          ...outcome,
          recovery: { status: "pending", attempts: 2 },
          sessionState: "awaiting-device",
        },
        { assignedDevice: "b" },
      ),
    ).toMatchObject({
      replacementDeviceId: "b",
      sessionState: "awaiting-device",
      recovery: { status: "pending", attempts: 2 },
      retry: { sameSession: true, requiresNewSession: false },
    });
  });
  test("incident replacement wins over the live serial", () => {
    expect(
      enrichDeviceLossOutcomeFromSession(
        {
          ...outcome,
          replacementDeviceId: "incident-serial",
          recovery: { status: "exhausted", attempts: 2 },
        },
        { assignedDevice: "b" },
      ),
    ).toMatchObject({
      replacementDeviceId: "incident-serial",
      recovery: { status: "exhausted", attempts: 2 },
    });
  });
  test("a session still on the lost serial leaves the outcome untouched", () => {
    expect(enrichDeviceLossOutcomeFromSession(outcome, { assignedDevice: "a" })).toBe(outcome);
  });
  test("an incident that judged the session released is not overridden", () => {
    const released = { ...outcome, sessionState: "released" as const };
    expect(enrichDeviceLossOutcomeFromSession(released, { assignedDevice: "b" })).toBe(released);
  });
  test("a moved session overrides a recovering incident's retry verdict", () => {
    const recovering = {
      ...outcome,
      sessionState: "recovering" as const,
      retry: { sameSession: false, requiresNewSession: false },
    };
    expect(enrichDeviceLossOutcomeFromSession(recovering, { assignedDevice: "b" })).toMatchObject({
      sessionState: "active",
      retry: { sameSession: true, requiresNewSession: false },
      replacementDeviceId: "b",
    });
  });
  test("gone session preserves the existing outcome", () => {
    expect(enrichDeviceLossOutcomeFromSession(outcome, null)).toBe(outcome);
  });
});
