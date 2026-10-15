import { describe, expect, spyOn, test } from "bun:test";
import * as systemUiAnr from "../../src/server/deviceToolsSystemUiAnr";
import { prepareStartDeviceRunnerReadiness } from "../../src/server/deviceTools";
import { SystemUiAnrRecoveryRequiredError } from "../../src/ctrlProxy/RunnerReadinessService";
import type { DaemonState } from "../../src/daemon/daemonState";
import type { DevicePool, PooledDevice } from "../../src/daemon/devicePool";
import type { SessionManager, Session } from "../../src/daemon/sessionManager";
import type { DeviceBootService } from "../../src/devices/deviceBootService";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { FakeTimer } from "../fakes/FakeTimer";

type Scenario =
  | "session"
  | "missing"
  | "missing-pool-failure"
  | "wrong-preserved"
  | "wrong-instance"
  | "wrong-owner"
  | "session-failure"
  | "pool-failure";

describe("deviceTools preserved-session release caller ordering", () => {
  test.each([
    "session",
    "missing",
    "missing-pool-failure",
    "wrong-preserved",
    "wrong-instance",
    "wrong-owner",
    "session-failure",
    "pool-failure",
  ] as const)("%s", async (scenario: Scenario) => {
    const events: unknown[][] = [];
    const session = { assignedDevice: "old" } as Session;
    const replacement = { id: "replacement", sessionId: "s1" } as PooledDevice;
    const finished = new Error("callback exercised");
    const failure = new Error("release failed");
    let live = !scenario.startsWith("missing");
    const manager: Pick<SessionManager, "getSession" | "hasSession" | "releaseSessionIfOwned"> = {
      getSession: () => (scenario.startsWith("missing") ? null : session),
      hasSession: () => live,
      releaseSessionIfOwned: async (...args) => {
        events.push(["session.releaseSessionIfOwned", ...args]);
        if (scenario === "session-failure") throw failure;
        live = false;
        return "replacement";
      },
    };
    const pool: Pick<DevicePool, "getDevice" | "releaseDevice"> = {
      getDevice: (id) =>
        id === "old"
          ? ({ id, sessionId: "s1" } as PooledDevice)
          : scenario === "wrong-instance"
            ? { ...replacement }
            : replacement,
      releaseDevice: async (...args) => {
        events.push(["pool.releaseDevice", ...args]);
        if (scenario === "pool-failure" || scenario === "missing-pool-failure") throw failure;
      },
    };
    const daemonState = {
      isInitialized: () => true,
      getSessionManager: () => manager,
      getDevicePool: () => pool,
    } as unknown as DaemonState;
    const reboot = spyOn(systemUiAnr, "rebootAndroidAfterSystemUiAnr").mockImplementation(
      async (context) => {
        if (scenario === "wrong-owner") replacement.sessionId = "other";
        await context.releasePreservedSession(
          replacement,
          scenario === "wrong-preserved" ? "other" : "s1",
        );
        events.push(["callback.done"]);
        // Stop at this seam: no shutdown, boot, devices, or post-recovery reservation work.
        throw finished;
      },
    );
    try {
      await expect(
        prepareStartDeviceRunnerReadiness({
          autolockEnabled: false,
          boot: {
            device: { deviceId: "old", name: "Pixel", platform: "android" },
            source: "booted",
            provisioned: false,
          },
          args: { platform: "android" },
          operationName: "startDevice",
          bootService: {} as DeviceBootService,
          deviceUtils: new FakeDeviceManager(),
          daemonState,
          totalDeadlineMs: 10_000,
          readinessTimeoutMs: 1_000,
          timer: new FakeTimer(),
          signal: undefined,
          progress: undefined,
          perf: { mark: () => {} } as Parameters<
            typeof prepareStartDeviceRunnerReadiness
          >[0]["perf"],
          requestedIdentity: "Pixel",
          ensureCtrlProxyReady: async () => {
            throw new SystemUiAnrRecoveryRequiredError("ANR");
          },
          releaseReadinessReservations: [],
          collectColdBootSettlement: () => {},
        }),
      ).rejects.toBe(
        scenario === "session-failure" || scenario.endsWith("pool-failure") ? failure : finished,
      );
      expect(events).toEqual(
        scenario === "session" || scenario === "session-failure" || scenario === "pool-failure"
          ? [
              [
                "session.releaseSessionIfOwned",
                "s1",
                session,
                "replacement",
                "device-disconnected:replacement",
              ],
              ...(scenario === "session-failure"
                ? []
                : [["pool.releaseDevice", "replacement", "s1"]]),
              ...(scenario === "session" ? [["callback.done"]] : []),
            ]
          : scenario.startsWith("missing")
            ? [
                ["pool.releaseDevice", "replacement", "s1"],
                ...(scenario === "missing" ? [["callback.done"]] : []),
              ]
            : [["callback.done"]],
      );
    } finally {
      reboot.mockRestore();
    }
  });
});
