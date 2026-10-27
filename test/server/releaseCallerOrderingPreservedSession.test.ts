import { DefaultPerformanceTracker } from "../../src/utils/PerformanceTracker";
import { describe, expect, spyOn, test } from "bun:test";
import * as systemUiAnr from "../../src/server/deviceToolsSystemUiAnr";
import { prepareStartDeviceRunnerReadiness } from "../../src/server/deviceTools";
import { SystemUiAnrRecoveryRequiredError } from "../../src/ctrlProxy/RunnerReadinessService";
import type { PooledDevice } from "../../src/daemon/devicePool";
import type { Session } from "../../src/daemon/sessionManager";
import type {
  ReadinessDaemonState,
  ReadinessDevicePool,
  ReadinessSessionManager,
} from "../../src/features/deviceLifecycle/startDeviceReadinessTypes";
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

/** A collaborator method this scenario must not reach; calling it fails the test loudly. */
function unexercised(name: string): () => never {
  return () => {
    throw new Error(`${name} must not be called in this scenario`);
  };
}

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
    const replacement = {
      id: "replacement",
      name: "Pixel",
      platform: "android",
      sessionId: "s1",
      status: "busy",
      lastUsedAt: 0,
      assignmentCount: 0,
      errorCount: 0,
      incarnation: 1,
    } satisfies PooledDevice;
    const finished = new Error("callback exercised");
    const failure = new Error("release failed");
    let live = !scenario.startsWith("missing");
    const manager: ReadinessSessionManager = {
      getDeviceLabels: unexercised("getDeviceLabels"),
      getSession: () => (scenario.startsWith("missing") ? null : session),
      findSession: () => (scenario.startsWith("missing") ? null : session),
      hasSession: () => live,
      releaseSession: async (...args) => {
        events.push(["session.releaseSession", ...args]);
        if (scenario === "session-failure") {
          throw failure;
        }
        live = false;
        return "replacement";
      },
    };
    const pool: ReadinessDevicePool = {
      reserveDeviceForReadiness: unexercised("reserveDeviceForReadiness"),
      reserveDeviceForShutdown: unexercised("reserveDeviceForShutdown"),
      captureAutolockSessionForMcpSession: unexercised("captureAutolockSessionForMcpSession"),
      replaceDeviceForSystemUiAnrRecovery: unexercised("replaceDeviceForSystemUiAnrRecovery"),
      retireDeviceAfterSystemUiAnrRecoveryFailure: unexercised(
        "retireDeviceAfterSystemUiAnrRecoveryFailure",
      ),
      noteLatePlatformShutdownSettled: unexercised("noteLatePlatformShutdownSettled"),
      markIntentionalShutdown: unexercised("markIntentionalShutdown"),
      clearIntentionalShutdown: unexercised("clearIntentionalShutdown"),
      getDevice: (id) =>
        id === "old"
          ? { ...replacement, id, sessionId: "s1" }
          : scenario === "wrong-instance"
            ? { ...replacement }
            : replacement,
      releaseDevice: async (...args) => {
        events.push(["pool.releaseDevice", ...args]);
        if (scenario === "pool-failure" || scenario === "missing-pool-failure") {
          throw failure;
        }
      },
    };
    const daemonState: ReadinessDaemonState = {
      isInitialized: () => true,
      getSessionManager: () => manager,
      getDevicePool: () => pool,
    };
    const reboot = spyOn(systemUiAnr, "rebootAndroidAfterSystemUiAnr").mockImplementation(
      async (context) => {
        if (scenario === "wrong-owner") {
          replacement.sessionId = "other";
        }
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
          perf: new DefaultPerformanceTracker(new FakeTimer()),
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
                "session.releaseSession",
                "s1",
                "device-disconnected:replacement",
                { expectedOwner: { session, deviceId: "replacement" } },
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
