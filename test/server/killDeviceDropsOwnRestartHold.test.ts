import { describe, expect, spyOn } from "bun:test";
import { INTERNAL_MCP_SESSION_PARAM } from "../../src/daemon/constants";
import { InputDeviceOwnedError } from "../../src/daemon/inputDeviceOwnership";
import { drainUntil, drainMicrotasks, settleByFakeEvents } from "../helpers/fakeTimerStepping";
import { IOSCtrlProxyManager } from "../../src/ctrlProxy/IOSCtrlProxyManager";
import { getDbWriteBarrier, resetDbWriteBarrier } from "../../src/db/dbWriteBarrier";
import { DaemonState } from "../../src/daemon/daemonState";
import { DevicePool, type PooledDevice } from "../../src/daemon/devicePool";
import type { SessionReleaseReason } from "../../src/daemon/releaseReasons";
import { SessionManager, type RehydrationDeviceReservation } from "../../src/daemon/sessionManager";
import { IOSCtrlProxyClient } from "../../src/features/observe/ios/IOSCtrlProxyClient";
import { runWithToolSelectionContext } from "../../src/features/toolSelection/toolSelectionContext";
import type { BootedDevice, Platform } from "../../src/models";
import {
  registerDeviceTools,
  resetDeviceToolsDependencies,
  setDeviceToolsDependencies,
} from "../../src/server/deviceTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import {
  resetVideoRecordingManagerDependencies,
  setVideoRecordingManagerDependencies,
} from "../../src/server/videoRecordingManager";
import { DefaultRetryExecutor } from "../../src/utils/retry/RetryExecutor";
import { FakeAvdManager } from "../fakes/FakeAvdManager";
import { warmedTests } from "../helpers/warmedTests";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeTimer } from "../fakes/FakeTimer";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";

const BASE = "restart-holder";
const LABEL = `${BASE}:phone`;
const SIBLING = `${BASE}:tablet`;
const originalIosManagerGetInstance = IOSCtrlProxyManager.getInstance;
const originalIosClientRetireInstance = IOSCtrlProxyClient.retireInstance;

interface RestartHoldInternals {
  releaseDisconnectedRecoverySessionWithRetry(
    sessionId: string,
    deviceId: string,
    reason: SessionReleaseReason,
  ): Promise<void>;
  rehydrationReservations: Map<
    string,
    RehydrationDeviceReservation["target"] & {
      restartHandoff?: boolean;
      daemonRehydration?: boolean;
      scheduledDeadlineMs?: number;
      expiryTimer?: NodeJS.Timeout;
      ownerMcpSessionIds?: ReadonlySet<string>;
    }
  >;
  intentionalShutdowns: Map<string, number>;
  isReservedForShutdown(device: PooledDevice): boolean;
}

class StoppingDeviceManager extends FakeDeviceUtils {
  readonly killed: string[] = [];
  beforeKill: (() => void | Promise<void>) | undefined;
  stayRunning = false;

  override async killDevice(device: BootedDevice): Promise<void> {
    this.killed.push(device.deviceId);
    await this.beforeKill?.();
    if (!this.stayRunning) {
      this.setBootedDevices(device.platform, []);
    }
  }
}

describe("lifecycle stops drop only the requester's device-restart hold", () => {
  const cleanups: Array<() => void> = [];

  const test = warmedTests(() => {
    for (const cleanup of cleanups.splice(0).reverse()) {
      cleanup();
    }
    resetDeviceToolsDependencies();
    resetVideoRecordingManagerDependencies();
    ToolRegistry.clearTools();
    DaemonState.getInstance().reset();
    resetDbWriteBarrier();
    expect(ToolRegistry.getAllTools()).toHaveLength(0);
    expect(DaemonState.getInstance().isInitialized()).toBe(false);
    expect(getDbWriteBarrier().inFlightCount()).toBe(0);
    expect(getDbWriteBarrier().isDraining()).toBe(false);
    expect(IOSCtrlProxyManager.getInstance).toBe(originalIosManagerGetInstance);
    expect(IOSCtrlProxyClient.retireInstance).toBe(originalIosClientRetireInstance);
  });

  async function fixture(
    platform: Platform,
    labelHolder = false,
    publishLabels = false,
    connection: string | null = "owner-conn",
  ) {
    const timer = new FakeTimer();
    timer.setCurrentTime(1_000);
    const manager = new StoppingDeviceManager();
    const device: BootedDevice = {
      platform,
      name: "restart-phone",
      deviceId: platform === "android" ? "emulator-5554" : "restart-sim",
    };
    manager.setBootedDevices(platform, [device]);
    manager.setDeviceImages(platform, [device]);
    const persistence = new FakeDeviceSessionPersistence();
    const sessions = new SessionManager(
      timer,
      persistence,
      () => new FakeDbWriteBarrier(),
      () => ({ restore: async () => {} }),
    );
    sessions.attachDaemonSessionId("stop-hold-daemon");
    sessions.stopCleanupTimer();
    const pool = new DevicePool(
      createDevicePoolDependencies(sessions, "stop-hold-daemon", {
        timer,
        deviceManager: manager,
        installedAppsRepository: new FakeInstalledAppsRepository(),
        retryExecutor: new DefaultRetryExecutor(timer),
        recoveryPolicy: { onLoss: false, maxAttempts: 1 },
      }),
    );
    cleanups.push(() => {
      pool.releaseDeviceClaimsForShutdown();
      sessions.stopCleanupTimer();
      timer.reset();
      expect(timer.getPendingTimeoutCount()).toBe(0);
    });
    const iosStop = spyOn(IOSCtrlProxyManager, "getInstance").mockReturnValue({
      stop: async () => {},
    } as unknown as IOSCtrlProxyManager);
    const iosRetire = spyOn(IOSCtrlProxyClient, "retireInstance").mockResolvedValue(undefined);
    cleanups.push(() => {
      iosStop.mockRestore();
      iosRetire.mockRestore();
    });
    await setVideoRecordingManagerDependencies({
      videoRecorderService: {} as never,
      recordingRepository: { listRecordings: async () => [] } as never,
      configRepository: {} as never,
      highlightClient: {} as never,
      timer,
      now: () => new Date(0),
    });
    setDeviceToolsDependencies({
      deviceManagerFactory: () => manager,
      avdManagerFactory: () => new FakeAvdManager(),
      notifyResourcesChanged: async () => {},
      clearInstalledAppsForDevice: async () => {},
      ensureCtrlProxyReady: async () => {},
      stopPerformanceMonitoring: () => {},
      stopAndroidObservers: async () => {},
      resolveRunningAndroidAvdName: async () => device.name,
      timer,
    });
    await pool.initializeWithDevices([device]);
    DaemonState.getInstance().initialize(sessions, pool);
    const holder = labelHolder ? LABEL : BASE;
    if (labelHolder) {
      await sessions.createSession(BASE, "base-spare", platform);
      sessions.setDeviceLabels(BASE, { phone: LABEL, tablet: SIBLING });
    }
    const closeMint = labelHolder ? sessions.openPlanLabelMints(BASE, { phone: LABEL }) : () => {};
    await pool.bindOrReuseDeviceSession(
      holder,
      device.deviceId,
      platform,
      undefined,
      undefined,
      device,
      false,
      undefined,
      undefined,
      undefined,
      connection ?? undefined,
    );
    closeMint();
    if (publishLabels) {
      sessions.setDeviceLabels(BASE, { phone: LABEL, tablet: SIBLING });
    }
    const internals = pool as unknown as RestartHoldInternals;
    if (platform === "ios") {
      manager.beforeKill = () => expect(internals.intentionalShutdowns.size).toBe(0);
    }
    await internals.releaseDisconnectedRecoverySessionWithRetry(
      holder,
      device.deviceId,
      `device-restart:${platform === "android" ? device.name : device.deviceId}`,
    );
    await pool.releaseDevice(device.deviceId, holder);
    expect(sessions.hasSession(holder)).toBe(false);
    expect(pool.genericAvailability(device.deviceId)).toBe("reserved");
    registerDeviceTools();
    const call = (
      name: "killDevice" | "deleteDevice",
      requester?: string,
      force = false,
      mcpSessionId?: string,
      signal?: AbortSignal,
    ) =>
      runWithToolSelectionContext({ routingSessionUuid: requester }, () =>
        ToolRegistry.getTool(name)!.handler(
          name === "killDevice"
            ? { device, force, [INTERNAL_MCP_SESSION_PARAM]: mcpSessionId }
            : {
                target: {
                  platform,
                  isVirtual: true,
                  stableId: platform === "android" ? device.name : device.deviceId,
                },
                mode: "destroy",
                verifyAbsence: true,
                force,
                cancellationPolicy: "cancel-on-request-abort",
                [INTERNAL_MCP_SESSION_PARAM]: mcpSessionId,
              },
          undefined,
          signal,
        ),
      );
    async function kill(requester?: string, force = false) {
      await call("killDevice", requester, force);
      expect(manager.killed).toEqual([device.deviceId]);
      if (platform === "ios") {
        expect(internals.intentionalShutdowns.size).toBe(0);
      }
      await pool.initializeWithDevices([device]);
    }
    return { pool, sessions, persistence, timer, internals, device, holder, manager, kill, call };
  }

  test("android: reset-cohort capture wins over a reused serial and commits only that image", async () => {
    const f = await fixture("android", true);
    const hold = f.internals.rehydrationReservations.get(LABEL)!;
    const replacement = { ...hold, stableDeviceId: "replacement-avd" };
    f.internals.rehydrationReservations.set(SIBLING, replacement);
    f.pool.getDevice(f.device.deviceId)!.name = "replacement-avd";
    const cohort = Reflect.get(f.pool, "adbServerResetRecoveryReservations") as Map<
      string,
      {
        deviceId: string;
        image: { name: string };
        cancelled?: boolean;
      }
    >;
    const reset = { deviceId: f.device.deviceId, image: { name: f.device.name }, cancelled: false };
    cohort.set("captured-reset", reset);
    const commit = f.pool.markIntentionalShutdown(f.device.deviceId, BASE);
    expect(reset.cancelled).toBe(true);
    expect(f.internals.rehydrationReservations.get(LABEL)).toBe(hold);
    cohort.clear();
    commit();
    expect(f.internals.rehydrationReservations.has(LABEL)).toBe(false);
    expect(f.internals.rehydrationReservations.get(SIBLING)).toBe(replacement);
    expect(replacement.restartHandoff).toBe(true);
  });

  for (const platform of ["android", "ios"] as const) {
    test(`${platform}: successful commit keeps a replacement reservation object`, async () => {
      const f = await fixture(platform);
      const hold = f.internals.rehydrationReservations.get(BASE)!;
      const commit = f.pool.releaseDeviceRestartReservationForStop(f.device.deviceId, BASE);
      expect(f.internals.rehydrationReservations.get(BASE)).toBe(hold);
      const replacement = { ...hold };
      f.internals.rehydrationReservations.set(BASE, replacement);
      commit();
      expect(f.internals.rehydrationReservations.get(BASE)).toBe(replacement);
      expect(replacement.restartHandoff).toBe(true);
    });
    test(`${platform}: successful commit uses the mark-time identity after pooled eviction`, async () => {
      const f = await fixture(platform);
      const commit = f.pool.releaseDeviceRestartReservationForStop(f.device.deviceId, BASE);
      await f.pool.removeDevice(f.device.deviceId, true, f.pool.getDevice(f.device.deviceId));
      expect(f.internals.rehydrationReservations.get(BASE)?.restartHandoff).toBe(true);
      commit();
      expect(f.internals.rehydrationReservations.has(BASE)).toBe(false);
    });
    test(`${platform}: successful commit uses mark-time live label resolution`, async () => {
      const f = await fixture(platform, true);
      const commit = f.pool.releaseDeviceRestartReservationForStop(f.device.deviceId, SIBLING);
      f.sessions.setDeviceLabels(BASE, {});
      commit();
      expect(f.internals.rehydrationReservations.has(LABEL)).toBe(false);
    });
    test(`${platform}: disconnected handoff owner snapshot still refuses rival stop`, async () => {
      const f = await fixture(platform);
      const hold = f.internals.rehydrationReservations.get(BASE)!;
      f.pool.releaseMcpSessionBindings("owner-conn");
      expect(hold.ownerMcpSessionIds).toEqual(new Set(["owner-conn"]));
      await expect(f.call("killDevice", BASE, true, "rival-conn")).rejects.toBeInstanceOf(
        InputDeviceOwnedError,
      );
      expect(f.manager.killed).toEqual([]);
      expect(f.internals.rehydrationReservations.get(BASE)).toBe(hold);
    });
    for (const mode of ["throws", "cancelled", "command timeout", "unconfirmed"] as const) {
      test(`${platform}: holder killDevice ${mode} preserves the exact hold and timer`, async () => {
        const f = await fixture(platform);
        const hold = f.internals.rehydrationReservations.get(BASE)!;
        const snapshot = { ...hold };
        const abort = new AbortController();
        const gate = Promise.withResolvers<void>();
        f.manager.stayRunning = mode === "unconfirmed";
        f.manager.beforeKill = async () => {
          if (mode === "throws") {
            throw new Error("platform stop failed");
          }
          if (mode === "cancelled") {
            abort.abort();
          }
          if (mode === "cancelled" || mode === "command timeout") {
            await gate.promise;
          }
        };
        const pending = f.call("killDevice", BASE, false, "owner-conn", abort.signal).then(
          () => undefined,
          (error: unknown) => error,
        );
        await drainUntil(() => f.manager.killed.length === 1, { description: "platform kill" });
        const error = await settleByFakeEvents(f.timer, pending, { description: mode });
        try {
          expect(error).toBeInstanceOf(Error);
          if (mode === "throws") {
            expect(String(error)).toContain("platform stop failed");
          }
          if (mode === "command timeout" || mode === "unconfirmed") {
            expect(error).toMatchObject({ code: "timeout" });
          }
          expect(f.internals.rehydrationReservations.get(BASE)).toBe(hold);
          expect(hold).toEqual(snapshot);
          expect(f.pool.genericAvailability(f.device.deviceId)).toBe("reserved");
          expect(
            f.pool.restartReservationForStart(platform, [f.device.deviceId], { sessionUuid: BASE })!
              .owned,
          ).toBe(true);
        } finally {
          // Settle the fake command to release retained stop/lease fences, even on regression.
          gate.resolve();
          await drainMicrotasks(156);
        }
        // Late completion of a failed call leaves the hold to its original window.
        expect(f.internals.rehydrationReservations.get(BASE)).toBe(hold);
        expect(hold).toEqual(snapshot);
      });
    }
    test(`${platform}: the holder's in-flight stop never opens the restart hold`, async () => {
      const f = await fixture(platform);
      const hold = f.internals.rehydrationReservations.get(BASE)!;
      const snapshot = { ...hold };
      let observed = false;
      f.manager.beforeKill = async () => {
        observed = true;
        expect(f.internals.rehydrationReservations.get(BASE)).toBe(hold);
        expect(hold).toEqual(snapshot);
        expect(
          f.pool.restartReservationForStart(platform, [f.device.deviceId], {
            sessionUuid: "rival",
            mcpSessionId: "rival-conn",
          }),
        ).toMatchObject({ owned: false, restartHandoff: true });
        await expect(
          f.pool.bindOrReuseDeviceSession(
            "rival",
            f.device.deviceId,
            platform,
            undefined,
            undefined,
            f.device,
          ),
        ).rejects.toThrow();
      };
      await f.call("killDevice", BASE, false, "owner-conn");
      expect(observed).toBe(true);
      expect(f.internals.rehydrationReservations.has(BASE)).toBe(false);
    });
    test(`${platform}: holder deleteDevice stop failure keeps the exact hold`, async () => {
      const f = await fixture(platform);
      const hold = f.internals.rehydrationReservations.get(BASE)!;
      const snapshot = { ...hold };
      f.manager.beforeKill = () => {
        throw new Error("platform stop failed");
      };
      expect(
        JSON.parse((await f.call("deleteDevice", BASE, false, "owner-conn")).content[0].text),
      ).toMatchObject({ success: false, failure: { phase: "stop" } });
      expect(f.internals.rehydrationReservations.get(BASE)).toBe(hold);
      expect(hold).toEqual(snapshot);
      expect(f.pool.genericAvailability(f.device.deviceId)).toBe("reserved");
    });
    for (const tool of ["killDevice", "deleteDevice"] as const) {
      test(`${platform}: ${tool} rechecks the handoff owner under the shutdown lock`, async () => {
        const f = await fixture(platform);
        const original = f.pool.reserveDeviceForShutdown.bind(f.pool);
        const recheck = spyOn(f.pool, "reserveDeviceForShutdown").mockImplementation(
          async (...args) => {
            f.internals.rehydrationReservations.get(BASE)!.ownerMcpSessionIds = new Set([
              "replacement-owner",
            ]);
            return await original(...args);
          },
        );
        cleanups.push(() => recheck.mockRestore());
        const result = f.call(tool, BASE, true, "owner-conn");
        if (tool === "killDevice") {
          await expect(result).rejects.toBeInstanceOf(InputDeviceOwnedError);
        } else {
          expect(JSON.parse((await result).content[0].text)).toMatchObject({
            failure: { code: "device_owned_by_other_session", phase: "stop" },
          });
        }
        expect(recheck).toHaveBeenCalledTimes(1);
        expect(f.manager.killed).toEqual([]);
        expect(f.internals.rehydrationReservations.get(BASE)?.restartHandoff).toBe(true);
        expect(f.internals.intentionalShutdowns.size).toBe(0);
        expect(f.internals.isReservedForShutdown(f.pool.getDevice(f.device.deviceId)!)).toBe(false);
      });
      for (const force of [false, true]) {
        test(`${platform}: ${tool} refuses the rival naming the holder, force ${force}`, async () => {
          const f = await fixture(platform);
          const hold = f.internals.rehydrationReservations.get(BASE)!;
          expect(hold.ownerMcpSessionIds).toEqual(new Set(["owner-conn"]));
          const snapshot = { ...hold };
          const row = { ...(await f.persistence.getSession!(BASE)) };
          const device = f.pool.getDevice(f.device.deviceId);
          const deviceSnapshot = { ...device };
          const shutdownReservation = spyOn(f.pool, "reserveDeviceForShutdown");
          cleanups.push(() => shutdownReservation.mockRestore());
          const pending = f.call(tool, BASE, force, "rival-conn");
          if (tool === "killDevice") {
            const error = await pending.then(
              () => undefined,
              (error: unknown) => error,
            );
            expect(error).toBeInstanceOf(InputDeviceOwnedError);
            expect(error).toMatchObject({ code: "device_owned_by_other_session" });
          } else {
            expect(JSON.parse((await pending).content[0].text)).toMatchObject({
              success: false,
              failure: { code: "device_owned_by_other_session", phase: "precondition" },
            });
          }
          expect(f.manager.killed).toEqual([]);
          expect(f.internals.rehydrationReservations.get(BASE)).toBe(hold);
          expect(hold).toEqual(snapshot);
          expect(await f.persistence.getSession!(BASE)).toEqual(row);
          expect(f.pool.getDevice(f.device.deviceId)).toBe(device);
          expect(device).toEqual(deviceSnapshot);
          expect(shutdownReservation).not.toHaveBeenCalled();
          expect(f.internals.intentionalShutdowns.size).toBe(0);
        });
      }
      for (const connection of ["owner-conn", "rival-conn"]) {
        test(`${platform}: ${tool} live-base label requester uses handoff connection ${connection}`, async () => {
          const f = await fixture(platform, true);
          expect(f.internals.rehydrationReservations.get(LABEL)!.ownerMcpSessionIds).toEqual(
            new Set(["owner-conn"]),
          );
          const result = f.call(tool, SIBLING, false, connection);
          if (connection === "rival-conn") {
            if (tool === "killDevice") {
              await expect(result).rejects.toBeInstanceOf(InputDeviceOwnedError);
            } else {
              expect(JSON.parse((await result).content[0].text)).toMatchObject({
                failure: { code: "device_owned_by_other_session" },
              });
            }
            expect(f.manager.killed).toEqual([]);
            expect(f.internals.rehydrationReservations.get(LABEL)?.restartHandoff).toBe(true);
          } else {
            await result;
            expect(f.manager.killed).toEqual([f.device.deviceId]);
            expect(f.internals.rehydrationReservations.has(LABEL)).toBe(false);
          }
        });
      }
      test(`${platform}: ${tool} owner connection drops its hold on success`, async () => {
        const f = await fixture(platform);
        await f.call(tool, BASE, false, "owner-conn");
        expect(f.internals.rehydrationReservations.has(BASE)).toBe(false);
      });
      for (const owners of [undefined, new Set<string>()]) {
        test(`${platform}: ${tool} ${owners === undefined ? "undefined" : "empty"} owner snapshot permits rival connection`, async () => {
          const f = await fixture(platform, false, false, null);
          expect(f.internals.rehydrationReservations.get(BASE)!.ownerMcpSessionIds?.size ?? 0).toBe(
            0,
          );
          f.internals.rehydrationReservations.get(BASE)!.ownerMcpSessionIds = owners;
          await f.call(tool, BASE, false, "rival-conn");
          expect(f.internals.rehydrationReservations.has(BASE)).toBe(false);
        });
      }
      for (const requester of [undefined, "other-session"]) {
        test(`${platform}: ${tool} rival connection with requester ${requester ?? "none"} keeps the hold`, async () => {
          const f = await fixture(platform);
          const hold = f.internals.rehydrationReservations.get(BASE)!;
          await f.call(tool, requester, true, "rival-conn");
          expect(f.manager.killed).toEqual([f.device.deviceId]);
          expect(f.internals.rehydrationReservations.get(BASE)).toBe(hold);
          expect(hold.restartHandoff).toBe(true);
        });
      }
    }
    for (const tool of ["killDevice", "deleteDevice"] as const) {
      test(`${platform}: ${tool} already-stopped success drops the captured hold`, async () => {
        const f = await fixture(platform);
        f.manager.beforeKill = () => {
          f.manager.setBootedDevices(platform, []);
          throw new Error(platform === "android" ? "emulator not running" : "already shut down");
        };
        await f.call(tool, BASE, false, "owner-conn");
        expect(f.internals.rehydrationReservations.has(BASE)).toBe(false);
      });
    }
    test(`${platform}: reserving session's killDevice drops its hold`, async () => {
      const f = await fixture(platform);
      await f.kill(BASE);
      expect(f.internals.rehydrationReservations.has(BASE)).toBe(false);
      expect(f.pool.genericAvailability(f.device.deviceId)).not.toBe("reserved");
    });
    for (const requester of [BASE, SIBLING]) {
      test(`${platform}: live base resolves label holder for requester ${requester}`, async () => {
        const f = await fixture(platform, true);
        expect(f.sessions.getDeviceLabels(BASE)).toEqual({ phone: LABEL, tablet: SIBLING });
        await f.kill(requester);
        expect(f.internals.rehydrationReservations.has(LABEL)).toBe(false);
        expect(f.pool.genericAvailability(f.device.deviceId)).not.toBe("reserved");
      });
    }
    test(`${platform}: handed-off base cannot resolve its label requester`, async () => {
      const f = await fixture(platform, false, true);
      expect(f.sessions.getDeviceLabels(BASE)).toBeUndefined();
      await f.kill(LABEL);
      expect(f.internals.rehydrationReservations.get(BASE)?.restartHandoff).toBe(true);
      expect(f.pool.genericAvailability(f.device.deviceId)).toBe("reserved");
    });
    for (const force of [false, true]) {
      test(`${platform}: another session's killDevice preserves the hold, force ${force}`, async () => {
        const f = await fixture(platform);
        await f.kill("other-session", force);
        expect(f.internals.rehydrationReservations.get(BASE)?.restartHandoff).toBe(true);
        expect(f.pool.genericAvailability(f.device.deviceId)).toBe("reserved");
      });
    }
    test(`${platform}: sessionless killDevice preserves the hold`, async () => {
      const f = await fixture(platform);
      await f.kill();
      expect(f.internals.rehydrationReservations.get(BASE)?.restartHandoff).toBe(true);
      expect(f.pool.genericAvailability(f.device.deviceId)).toBe("reserved");
    });
    test(`${platform}: holder stop preserves the daemon-restart source`, async () => {
      const f = await fixture(platform);
      await f.pool.reserveDevicesForRehydration([
        {
          sessionId: BASE,
          target: {
            platform,
            stableDeviceId: platform === "android" ? f.device.name : f.device.deviceId,
            deviceId: f.device.deviceId,
          },
        },
      ]);
      await f.kill(BASE);
      expect(f.internals.rehydrationReservations.get(BASE)).toMatchObject({
        restartHandoff: false,
        daemonRehydration: true,
      });
      expect(f.pool.genericAvailability(f.device.deviceId)).toBe("reserved");
      f.pool.releaseRehydrationReservation(BASE);
      expect(f.internals.rehydrationReservations.has(BASE)).toBe(false);
    });
    test(`${platform}: reserving session's deleteDevice drops its hold`, async () => {
      const f = await fixture(platform);
      const response = await f.call("deleteDevice", BASE);
      expect(response).toMatchObject({
        structuredContent: { state: "destroyed", command: { stop: "accepted" } },
      });
      expect(f.manager.killed).toEqual([f.device.deviceId]);
      expect(f.internals.rehydrationReservations.has(BASE)).toBe(false);
      if (platform === "ios") {
        expect(f.internals.intentionalShutdowns.size).toBe(0);
      }
    });
  }
});
