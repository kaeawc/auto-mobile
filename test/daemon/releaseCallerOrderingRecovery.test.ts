import { describe, expect, test } from "bun:test";
import { recoveryCoordinatorHarness } from "../helpers/recoveryCoordinatorHarness";

describe("failed recovery release caller ordering", () => {
  test.each([
    [true, true],
    [true, false],
    [false, true],
    [false, false],
  ] as const)(
    "expiry=%s capture=%s releases only after attempt settles",
    async (expiryOrigin, capture) => {
      const { coordinator, port } = recoveryCoordinatorHarness();
      coordinator.startAndroidRecoveryRecord("s1", { deviceId: "d1" }, ["failed-release"]);
      const events: unknown[][] = [];
      const gate = Promise.withResolvers<string | null>();
      const started = Promise.withResolvers<void>();
      port.releaseDisconnectedRecoverySessionWithRetry = async (
        ...[id, device, reason, attempt]
      ) => {
        events.push(["retry", id, device, reason]);
        await attempt();
        events.push(["retry.done"]);
      };
      port.hasReleasedDeviceCapture = (id) => {
        events.push(["capture", id]);
        return capture;
      };
      port.releaseDevice = async (...args) => {
        events.push(["pool.releaseDevice", ...args]);
      };
      const result = coordinator.releaseFailedRecoveryOnExpiry(
        "s1",
        "cleanup-expired",
        async () => {
          events.push(["attempt"]);
          started.resolve();
          const id = await gate.promise;
          events.push(["attempt.done", id]);
          return id;
        },
        { expiryOrigin },
      );
      await started.promise;
      expect(events).toEqual([["retry", "s1", "d1", "cleanup-expired"], ["attempt"]]);
      gate.resolve("returned-device");
      expect(await result).toBe("returned-device");
      expect(events).toEqual([
        ["retry", "s1", "d1", "cleanup-expired"],
        ["attempt"],
        ["attempt.done", "returned-device"],
        ...(expiryOrigin ? [["capture", "s1"]] : []),
        ...(expiryOrigin && capture ? [["pool.releaseDevice", "d1", "s1"]] : []),
        ["retry.done"],
      ]);
    },
  );
  test("an expiry capture is released even when the attempt returns null", async () => {
    const { coordinator, port } = recoveryCoordinatorHarness();
    coordinator.startAndroidRecoveryRecord("s1", { deviceId: "d1" }, ["failed-release"]);
    const events: unknown[][] = [];
    port.hasReleasedDeviceCapture = (id) => {
      events.push(["capture", id]);
      return true;
    };
    port.releaseDevice = async (...args) => {
      events.push(["pool.releaseDevice", ...args]);
    };
    expect(
      await coordinator.releaseFailedRecoveryOnExpiry(
        "s1",
        "cleanup-expired",
        async () => {
          events.push(["attempt", null]);
          return null;
        },
        { expiryOrigin: true },
      ),
    ).toBeNull();
    expect(events).toEqual([
      ["attempt", null],
      ["capture", "s1"],
      ["pool.releaseDevice", "d1", "s1"],
    ]);
  });
  test.each(["attempt", "pool"] as const)(
    "%s rejection stops callback and is reported with recovery context",
    async (failure) => {
      const { coordinator, port } = recoveryCoordinatorHarness();
      coordinator.startAndroidRecoveryRecord("s1", { deviceId: "d1" }, ["failed-release"]);
      const events: unknown[][] = [];
      port.hasReleasedDeviceCapture = (id) => {
        events.push(["capture", id]);
        return true;
      };
      port.releaseDevice = async (...args) => {
        events.push(["pool.releaseDevice", ...args]);
        throw new Error("pool failed");
      };
      await expect(
        coordinator.releaseFailedRecoveryOnExpiry(
          "s1",
          "cleanup-expired",
          async () => {
            events.push(["attempt"]);
            if (failure === "attempt") {
              throw new Error("attempt failed");
            }
            return "returned-device";
          },
          { expiryOrigin: true },
        )!,
      ).rejects.toThrow(`Failed to release recovery-fenced session s1: ${failure} failed`);
      expect(events).toEqual([
        ["attempt"],
        ...(failure === "pool"
          ? [
              ["capture", "s1"],
              ["pool.releaseDevice", "d1", "s1"],
            ]
          : []),
      ]);
    },
  );
});
