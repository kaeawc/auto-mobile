import type { DeviceLossOutcome } from "../../src/utils/deviceLossOutcome";
import { describe, expect, test, spyOn } from "bun:test";
import {
  resolveDeviceLossOutcome,
  type DeviceLossDaemonContext,
} from "../../src/server/pipeline/ingress/shapeResult";
import { logger } from "../../src/utils/logger";
import { DEVICE_LOSS_OUTCOME_CODE } from "../../src/utils/deviceLossOutcome";
import { installSessionManagerCleanup, makeSessionManager } from "../helpers/sessionManagerSuite";

installSessionManagerCleanup();
const outcome: DeviceLossOutcome = {
  code: DEVICE_LOSS_OUTCOME_CODE,
  deviceId: "a",
  sessionUuid: "s",
  reason: "confirmed-unavailable" as const,
};

describe("device-loss shaping reads live continuity on every resolution path", () => {
  test.each(["no-incident", "no-pool", "timeout", "pending", "error"] as const)(
    "%s",
    async (mode) => {
      const manager = makeSessionManager({ fakeBarrier: true });
      await manager.createSession("s", "a", "android");
      await manager.rebindSession("s", "b", "android");
      const warning = spyOn(logger, "warn").mockImplementation(() => {});
      const context: DeviceLossDaemonContext = {
        sessionManager: () => manager,
        devicePool: () =>
          mode === "no-pool"
            ? undefined
            : {
                waitForEmulatorLossIncident: async () => {
                  if (mode === "error") {
                    throw new Error("incident read failed");
                  }
                  return mode === "pending"
                    ? {
                        id: "i",
                        deviceId: "a",
                        observedAtMs: 0,
                        updatedAtMs: 1,
                        detectionPath: "device-discovery-miss",
                        recovery: { policy: { onLoss: true, maxAttempts: 2 }, attempts: [] },
                      }
                    : undefined;
                },
              },
      };
      try {
        const answer = await resolveDeviceLossOutcome(
          { ...outcome, ...(mode === "no-incident" ? {} : { incidentId: "i" }) },
          0,
          context,
        );
        expect(answer).toMatchObject({
          replacementDeviceId: "b",
          sessionState: "active",
          retry: { sameSession: true, requiresNewSession: false },
          recovery: { status: mode === "pending" ? "pending" : "recovered", attempts: 0 },
        });
        expect(warning).toHaveBeenCalledTimes(mode === "error" ? 1 : 0);
      } finally {
        warning.mockRestore();
      }
    },
  );

  test("lookup errors warn and leave the outcome intact", async () => {
    const warning = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const context: DeviceLossDaemonContext = {
        devicePool: () => undefined,
        sessionManager: () => ({
          peekSession: () => {
            throw new Error("lookup failed");
          },
        }),
      };
      expect(await resolveDeviceLossOutcome(outcome, 0, context)).toBe(outcome);
      expect(warning).toHaveBeenCalledTimes(1);
    } finally {
      warning.mockRestore();
    }
  });

  test("gone sessions keep the incident-free outcome intact", async () => {
    expect(
      await resolveDeviceLossOutcome(outcome, 0, {
        devicePool: () => undefined,
        sessionManager: () => ({ peekSession: () => null }),
      }),
    ).toBe(outcome);
  });
});
