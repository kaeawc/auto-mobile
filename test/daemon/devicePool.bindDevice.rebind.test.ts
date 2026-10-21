import { afterEach, describe, expect, test, beforeEach } from "bun:test";
import { DevicePool } from "../../src/daemon/devicePool";
import { SessionManager } from "../../src/daemon/sessionManager";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { ActionableError } from "../../src/models";
import { DeviceLostError } from "../../src/models/DeviceLostError";

import { ExecutionTracker } from "../../src/daemon/executionTracker";
import { useSessionIdleWindowForSuite } from "../helpers/sessionIdleWindowEnv";
import {
  DeferredReconnectionDiscoveryFakeDeviceManager,
  createBootedDevice,
  createDevicePoolSuite,
  devicePoolSuiteActions,
} from "../helpers/devicePoolSuite";

useSessionIdleWindowForSuite();

describe("DevicePool", () => {
  let devicePool: DevicePool;
  let sessionManager: SessionManager;
  let fakeTimer: FakeTimer;
  let fakeAppsRepo: FakeInstalledAppsRepository;
  let fakeDeviceManager: FakeDeviceManager;
  const { initializeLiveDevices, makePool } = devicePoolSuiteActions(() => ({
    devicePool,
    sessionManager,
    fakeTimer,
    fakeAppsRepo,
    fakeDeviceManager,
  }));

  beforeEach(() => {
    ({ devicePool, sessionManager, fakeTimer, fakeAppsRepo, fakeDeviceManager } =
      createDevicePoolSuite());
  });

  afterEach(() => {
    sessionManager.stopCleanupTimer();
  });

  describe("assignDeviceToSession", () => {
    test("should bind a specific device to a session", async () => {
      await devicePool.initializeWithDevices([createBootedDevice("sim-1", "ios", "iPhone 15")]);
      fakeDeviceManager.bootedDevices = [createBootedDevice("sim-1", "ios", "iPhone 15")];

      const sessionId = await devicePool.bindOrReuseDeviceSession({
        sessionId: "session-1",
        deviceId: "sim-1",
        platform: "ios",
      });

      expect(sessionId).toBe("session-1");
      const device = devicePool.getDevice("sim-1");
      expect(device?.sessionId).toBe("session-1");
      expect(device?.status).toBe("busy");
      expect(sessionManager.getSession("session-1")?.assignedDevice).toBe("sim-1");
    });

    test("keeps a shutdown reservation exclusive to direct binding and autolock", async () => {
      const originalAutolock = process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK;
      const device = createBootedDevice("emulator-5554", "android", "Pixel 8");
      await initializeLiveDevices([device]);
      const captured = devicePool.getDevice(device.deviceId);
      if (!captured) {
        throw new Error("expected shutdown device to be pooled");
      }
      const reservation = await devicePool.reserveDeviceForShutdown(captured.id);
      if (!reservation) {
        throw new Error("expected shutdown reservation");
      }

      try {
        expect(devicePool.getAvailableDeviceCount()).toBe(0);
        devicePool.markIntentionalShutdown(captured.id);
        await devicePool.removeDisconnectedDevice(captured.id, false);
        expect(devicePool.getDevice(captured.id)).toBe(captured);
        await expect(
          devicePool.bindOrReuseDeviceSession({
            sessionId: "session-1",
            deviceId: device.deviceId,
            platform: device.platform,
          }),
        ).rejects.toThrow(/shutting down/);

        process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = "1";
        await expect(
          devicePool.autolockDevice(device.deviceId, device.platform, "mcp-session-1"),
        ).rejects.toThrow(/shutting down/);
      } finally {
        await reservation.release();
        if (originalAutolock === undefined) {
          delete process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK;
        } else {
          process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = originalAutolock;
        }
      }

      expect(devicePool.getAvailableDeviceCount()).toBe(0);
      devicePool.noteLatePlatformShutdownSettled(captured);
      await devicePool.refreshDevices();
      expect(devicePool.getAvailableDeviceCount()).toBe(1);
      await expect(
        devicePool.bindOrReuseDeviceSession({
          sessionId: "session-1",
          deviceId: device.deviceId,
          platform: device.platform,
        }),
      ).resolves.toBe("session-1");
    });

    test("releases the old pooled device after rebinding an existing session", async () => {
      await initializeLiveDevices([
        createBootedDevice("emulator-old"),
        createBootedDevice("emulator-new"),
      ]);
      await devicePool.bindOrReuseDeviceSession({
        sessionId: "session-1",
        deviceId: "emulator-old",
        platform: "android",
      });

      await devicePool.bindOrReuseDeviceSession({
        sessionId: "session-1",
        deviceId: "emulator-new",
        platform: "android",
        allowSessionRebind: true,
      });

      expect(devicePool.getDevice("emulator-old")).toMatchObject({
        sessionId: null,
        status: "idle",
      });
      expect(devicePool.getDevice("emulator-new")).toMatchObject({
        sessionId: "session-1",
        status: "busy",
      });
      expect(sessionManager.getSession("session-1")?.assignedDevice).toBe("emulator-new");
    });

    describe("rebind cancels the old device's running work (#9944)", () => {
      interface DeviceCancellation {
        deviceId: string;
        reason: string | Error;
        excludeExecutionId: string | undefined;
        onlySessionUuid: string | undefined;
        oldDeviceStatus: string | undefined;
      }
      let cancellations: DeviceCancellation[];
      let sessionCancellations: string[];
      let cancelImpl: () => Promise<number>;

      async function arrangeHarness(): Promise<void> {
        cancellations = [];
        sessionCancellations = [];
        cancelImpl = async () => 1;
        devicePool = makePool({
          ambientExecutionIdReader: { getExecutionId: () => "set-active-device-execution" },
          cancelDeviceSessionExecutions: Object.assign(
            async (sessionId: string) => {
              sessionCancellations.push(sessionId);
              return 0;
            },
            {
              cancelDeviceExecutions: async (
                deviceId: string,
                reason: string | Error,
                options?: { excludeExecutionId?: string; onlySessionUuid?: string },
              ) => {
                cancellations.push({
                  deviceId,
                  reason,
                  excludeExecutionId: options?.excludeExecutionId,
                  onlySessionUuid: options?.onlySessionUuid,
                  oldDeviceStatus: devicePool.getDevice("emulator-old")?.status,
                });
                return await cancelImpl();
              },
            },
          ),
        });
        await initializeLiveDevices([
          createBootedDevice("emulator-old"),
          createBootedDevice("emulator-new"),
        ]);
        await devicePool.bindOrReuseDeviceSession({
          sessionId: "session-1",
          deviceId: "emulator-old",
          platform: "android",
        });
      }

      // Builds the DevicePool harness inside each test, so its cost is paid honestly in the test body.
      function arranged(name: string, fn: () => void | Promise<void>, timeout?: number): void {
        test(
          name,
          async () => {
            await arrangeHarness();
            await fn();
          },
          timeout,
        );
      }

      const rebind = () =>
        devicePool.bindOrReuseDeviceSession({
          sessionId: "session-1",
          deviceId: "emulator-new",
          platform: "android",
          allowSessionRebind: true,
        });

      arranged(
        "cancels work on the old device, excluding the caller, before it goes idle",
        async () => {
          expect(cancellations).toEqual([]);

          await rebind();

          expect(cancellations).toHaveLength(1);
          const [cancellation] = cancellations;
          expect(cancellation).toMatchObject({
            deviceId: "emulator-old",
            excludeExecutionId: "set-active-device-execution",
            onlySessionUuid: "session-1",
            oldDeviceStatus: "busy",
          });
          // The caller-visible reason says what happened and is not a device-lost outcome.
          expect(cancellation.reason).toBeInstanceOf(ActionableError);
          expect(cancellation.reason).not.toBeInstanceOf(DeviceLostError);
          expect(cancellation.reason).toHaveProperty(
            "message",
            expect.stringMatching(
              /Session session-1 was rebound from device 'emulator-old' to another device/,
            ),
          );
          // Only device-bound work on the old device is cancelled: a session-wide
          // cancel would also stop calls already running on the new device.
          expect(sessionCancellations).toEqual([]);
          expect(devicePool.getDevice("emulator-old")).toMatchObject({
            sessionId: null,
            status: "idle",
          });
        },
      );

      arranged(
        "keeps the old device out of the pool until cancelled work has settled",
        async () => {
          const settled = Promise.withResolvers<number>();
          const cancelStarted = Promise.withResolvers<void>();
          cancelImpl = () => {
            cancelStarted.resolve();
            return settled.promise;
          };

          const rebinding = rebind();
          await cancelStarted.promise;

          expect(cancellations).toHaveLength(1);
          expect(devicePool.getDevice("emulator-old")?.status).toBe("busy");
          expect(devicePool.getDevice("emulator-old")?.sessionId).toBe("session-1");

          settled.resolve(1);
          await rebinding;

          expect(devicePool.getDevice("emulator-old")).toMatchObject({
            sessionId: null,
            status: "idle",
          });
        },
      );

      arranged("still releases the old device when the canceller fails", async () => {
        cancelImpl = async () => {
          throw new Error("drain failed");
        };

        await rebind();

        expect(devicePool.getDevice("emulator-old")).toMatchObject({
          sessionId: null,
          status: "idle",
        });
        expect(sessionManager.getSession("session-1")?.assignedDevice).toBe("emulator-new");
      });

      arranged(
        "with the real tracker, stops only the rebinding session's work with a clear message",
        async () => {
          const tracker = new ExecutionTracker(
            fakeTimer,
            new FakeIdGenerator(["own", "peer", "sessionless", "caller", "pending"]),
          );
          devicePool = makePool({
            ambientExecutionIdReader: { getExecutionId: () => "caller" },
            cancelDeviceSessionExecutions: Object.assign(
              tracker.cancelDeviceSessionExecutions.bind(tracker),
              { cancelDeviceExecutions: tracker.cancelDeviceExecutions.bind(tracker) },
            ),
          });
          await initializeLiveDevices([
            createBootedDevice("emulator-old"),
            createBootedDevice("emulator-new"),
          ]);
          await devicePool.bindOrReuseDeviceSession({
            sessionId: "session-1",
            deviceId: "emulator-old",
            platform: "android",
          });
          const own = tracker.startExecution("observe", undefined, "session-1");
          const peer = tracker.startExecution("observe", undefined, "session-2");
          const sessionless = tracker.startExecution("observe");
          const caller = tracker.startExecution("setActiveDevice", undefined, "session-1");
          // Admitted for session-1 but not yet bound to the old device when the rebind lands (#9958).
          const pending = tracker.startExecution("tapOn", undefined, "session-1");
          for (const execution of [own, peer, sessionless, caller]) {
            tracker.bindDeviceExecution(execution.id, "emulator-old");
          }

          await rebind();

          expect(() => tracker.bindDeviceExecution(pending.id, "emulator-old")).toThrow(
            /was rebound from device 'emulator-old'/,
          );
          expect(() => tracker.bindDeviceExecution(own.id, "emulator-old")).toThrow(
            ActionableError,
          );
          tracker.bindDeviceExecution(pending.id, "emulator-new");
          tracker.bindDeviceExecution(peer.id, "emulator-old");
          tracker.bindDeviceExecution(sessionless.id, "emulator-old");

          const reason = own.abortController.signal.reason;
          expect(reason).toBeInstanceOf(ActionableError);
          expect(reason).not.toBeInstanceOf(DeviceLostError);
          expect(reason.message).toContain("was rebound from device 'emulator-old'");
          expect(peer.abortController.signal.aborted).toBe(false);
          expect(sessionless.abortController.signal.aborted).toBe(false);
          expect(caller.abortController.signal.aborted).toBe(false);
        },
      );

      arranged("does not cancel anything when the session stays on the same device", async () => {
        await devicePool.bindOrReuseDeviceSession({
          sessionId: "session-1",
          deviceId: "emulator-old",
          platform: "android",
          allowSessionRebind: true,
        });

        expect(cancellations).toEqual([]);
        expect(devicePool.getDevice("emulator-old")?.sessionId).toBe("session-1");
      });

      arranged("does not cancel when a rebind is refused", async () => {
        await expect(
          devicePool.bindOrReuseDeviceSession({
            sessionId: "session-1",
            deviceId: "emulator-new",
            platform: "android",
          }),
        ).rejects.toThrow(/already assigned to device/);

        expect(cancellations).toEqual([]);
        expect(devicePool.getDevice("emulator-old")?.sessionId).toBe("session-1");
      });
    });

    describe("autolock rebind release", () => {
      let originalAutolock: string | undefined;

      beforeEach(async () => {
        originalAutolock = process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK;
        process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = "1";
        await initializeLiveDevices([
          createBootedDevice("emulator-old"),
          createBootedDevice("emulator-new"),
        ]);
      });

      afterEach(() => {
        if (originalAutolock === undefined) {
          delete process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK;
        } else {
          process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = originalAutolock;
        }
      });

      const rebind = (sessionId: string) =>
        devicePool.bindOrReuseDeviceSession({
          sessionId,
          deviceId: "emulator-new",
          platform: "android",
          allowSessionRebind: true,
        });

      test("allows another session to drive the old device after rebind", async () => {
        const sessionId = await devicePool.autolockDevice("emulator-old", "android", "mcp-1");
        expect(sessionId).toBeDefined();

        await rebind(sessionId!);
        await devicePool.bindOrReuseDeviceSession({
          sessionId: "next-owner",
          deviceId: "emulator-old",
          platform: "android",
        });

        expect(() => devicePool.assertAutolockAccess("emulator-old", "next-owner")).not.toThrow();
        expect(devicePool.getDevice("emulator-old")).toMatchObject({
          sessionId: "next-owner",
          autolockSessionId: undefined,
        });
        expect(devicePool.getDevice("emulator-new")?.autolockSessionId).toBe(sessionId);
        expect(() => devicePool.assertAutolockAccess("emulator-new", "next-owner")).toThrow(
          "held by another session",
        );
      });

      test("keeps the old device unlocked after releasing the rebound session", async () => {
        const sessionId = await devicePool.autolockDevice("emulator-old", "android", "mcp-1");
        await rebind(sessionId!);
        expect(devicePool.captureAutolockSessionForMcpSession("mcp-1")).toBe(sessionId);
        await sessionManager.releaseSession(sessionId!);
        expect(devicePool.captureAutolockSessionForMcpSession("mcp-1")).toBeUndefined();
        expect(
          devicePool.resolveAutolockSessionForMcpSession(
            "mcp-1",
            "android",
            undefined,
            "emulator-new",
          ),
        ).toBeUndefined();
        await devicePool.releaseDevice("emulator-new", sessionId!);
        await devicePool.bindOrReuseDeviceSession({
          sessionId: "next-owner",
          deviceId: "emulator-old",
          platform: "android",
        });

        expect(() => devicePool.assertAutolockAccess("emulator-old", "next-owner")).not.toThrow();
        expect(devicePool.getDevice("emulator-old")?.autolockSessionId).toBeUndefined();
        expect(devicePool.getDevice("emulator-new")).toMatchObject({
          sessionId: null,
          status: "idle",
          autolockSessionId: undefined,
        });
      });

      test("transfers the autolock before rebind publishes the replacement assignment", async () => {
        const sessionId = await devicePool.autolockDevice("emulator-old", "android", "mcp-1");
        const publishedStates: Array<{
          assignedDevice: string | undefined;
          lock: string | undefined;
          route: string | undefined;
        }> = [];
        sessionManager.onSessionDeviceUnbound(() => {
          publishedStates.push({
            assignedDevice: sessionManager.getSession(sessionId!)?.assignedDevice,
            lock: devicePool.getDevice("emulator-new")?.autolockSessionId,
            route: devicePool.resolveAutolockSessionForMcpSession("mcp-1"),
          });
        });

        await rebind(sessionId!);

        expect(publishedStates).toEqual([
          { assignedDevice: "emulator-new", lock: sessionId, route: sessionId },
        ]);
        expect(devicePool.captureAutolockSessionForMcpSession("mcp-1")).toBe(sessionId);
      });

      test("clears only the old lock before pool release and reuses the MCP session after rebind", async () => {
        const sessionId = await devicePool.autolockDevice("emulator-old", "android", "mcp-1");
        const events: string[] = [];
        sessionManager.onSessionDeviceUnbound((_id, deviceId) => {
          if (deviceId === "emulator-old") {
            events.push("unbound");
            expect(devicePool.getDevice(deviceId)?.autolockSessionId).toBe(sessionId);
          }
        });
        const releaseDevice = devicePool.releaseDevice.bind(devicePool);
        devicePool.releaseDevice = async (deviceId, expectedSessionId) => {
          events.push("pool-release");
          expect(devicePool.getDevice(deviceId)).toMatchObject({
            sessionId,
            status: "busy",
            autolockSessionId: undefined,
          });
          expect(devicePool.captureAutolockSessionForMcpSession("mcp-1")).toBe(sessionId);
          await releaseDevice(deviceId, expectedSessionId);
        };

        await rebind(sessionId!);

        expect(events).toEqual(["unbound", "pool-release"]);
        expect(devicePool.getDevice("emulator-new")?.autolockSessionId).toBe(sessionId);
        expect(devicePool.captureAutolockSessionForMcpSession("mcp-1")).toBe(sessionId);
        expect(
          devicePool.resolveAutolockSessionForMcpSession(
            "mcp-1",
            "android",
            undefined,
            "emulator-new",
          ),
        ).toBe(sessionId);
        expect(() => devicePool.assertAutolockAccess("emulator-new", sessionId!)).not.toThrow();
        const assignmentCount = devicePool.getDevice("emulator-new")!.assignmentCount;
        const reused = await devicePool.autolockDevice("emulator-new", "android", "mcp-1");
        expect(reused).toBe(sessionId);
        expect(devicePool.getDevice("emulator-new")!.assignmentCount).toBe(assignmentCount);
      });

      test.each([undefined, "target-lock"])(
        "keeps both locks unchanged when rebind persistence fails (target lock: %s)",
        async (targetLock) => {
          sessionManager.stopCleanupTimer();
          const persistence = new FakeDeviceSessionPersistence();
          sessionManager = new SessionManager(fakeTimer, persistence);
          devicePool = makePool();
          await initializeLiveDevices(fakeDeviceManager.bootedDevices);
          const sessionId = await devicePool.autolockDevice("emulator-old", "android", "mcp-1");
          devicePool.getDevice("emulator-new")!.autolockSessionId = targetLock;
          const oldDevice = { ...devicePool.getDevice("emulator-old")! };
          const newDevice = { ...devicePool.getDevice("emulator-new")! };
          persistence.failure = "create";

          await expect(rebind(sessionId!)).rejects.toThrow("persist create failed");

          expect(devicePool.getDevice("emulator-old")).toEqual(oldDevice);
          expect(devicePool.getDevice("emulator-new")).toEqual(newDevice);
          expect(sessionManager.getSession(sessionId!)?.assignedDevice).toBe("emulator-old");
          expect(devicePool.captureAutolockSessionForMcpSession("mcp-1")).toBe(sessionId);
        },
      );

      test("ordinary release clears autolock state before returning the device to the pool", async () => {
        const sessionId = await devicePool.autolockDevice("emulator-old", "android", "mcp-1");
        const releaseStates: Array<{ lock: string | undefined; owner: string | null | undefined }> =
          [];
        sessionManager.onSessionRelease(() => {
          releaseStates.push({
            lock: devicePool.getDevice("emulator-old")?.autolockSessionId,
            owner: devicePool.getDevice("emulator-old")?.sessionId,
          });
        });

        await sessionManager.releaseSession(sessionId!);

        expect(releaseStates).toEqual([{ lock: undefined, owner: sessionId }]);
        expect(devicePool.captureAutolockSessionForMcpSession("mcp-1")).toBeUndefined();
        await devicePool.releaseDevice("emulator-old", sessionId!);
        expect(devicePool.getDevice("emulator-old")).toMatchObject({
          sessionId: null,
          status: "idle",
          autolockSessionId: undefined,
        });
        await devicePool.bindOrReuseDeviceSession({
          sessionId: "next-owner",
          deviceId: "emulator-old",
          platform: "android",
        });
        expect(() => devicePool.assertAutolockAccess("emulator-old", "next-owner")).not.toThrow();
      });
    });

    test("binds a rediscovered same-serial emulator without requiring a retry", async () => {
      const firstConnection = createBootedDevice("emulator-5554", "android", "Pixel 8");
      const reconnected = { ...firstConnection };
      await initializeLiveDevices([firstConnection]);
      const incarnation = devicePool.getDevice(firstConnection.deviceId)?.incarnation;
      fakeDeviceManager.bootedDevices = [reconnected];

      await expect(
        devicePool.bindOrReuseDeviceSession({
          sessionId: "session-1",
          deviceId: reconnected.deviceId,
          platform: "android",
        }),
      ).resolves.toBe("session-1");

      expect(devicePool.getDevice(reconnected.deviceId)).toMatchObject({
        incarnation,
        sessionId: "session-1",
        status: "busy",
      });
      expect(sessionManager.getSession("session-1")?.assignedDevice).toBe(reconnected.deviceId);
    });

    test("autolocks a rediscovered same-serial emulator without reacquiring the assignment mutex", async () => {
      const originalAutolock = process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK;
      const firstConnection = createBootedDevice("emulator-5554", "android", "Pixel 8");
      const reconnected = { ...firstConnection };
      try {
        process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = "1";
        await initializeLiveDevices([firstConnection]);
        fakeDeviceManager.bootedDevices = [reconnected];

        await expect(
          devicePool.autolockDevice(reconnected.deviceId, "android", "mcp-session-1"),
        ).resolves.toBeDefined();

        expect(devicePool.getDevice(reconnected.deviceId)).toMatchObject({ status: "busy" });
      } finally {
        if (originalAutolock === undefined) {
          delete process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK;
        } else {
          process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = originalAutolock;
        }
      }
    });

    test("assigns the current replacement after liveness discovery supersedes a captured device", async () => {
      const firstConnection = createBootedDevice("emulator-5554", "android", "Pixel 8");
      const reconnected = { ...firstConnection };
      const manager = new DeferredReconnectionDiscoveryFakeDeviceManager(
        [reconnected],
        [reconnected],
      );
      devicePool = makePool({ deviceManager: manager });
      await devicePool.addDevice(firstConnection);

      const assignment = devicePool.assignDeviceToSession("session-1", "android");
      await manager.waitForDiscoveryStart();
      await devicePool.removeDevice(firstConnection.deviceId);
      await devicePool.addDevice(reconnected);

      manager.releaseDiscovery();

      await expect(assignment).resolves.toBe(reconnected.deviceId);
      expect(devicePool.getDevice(reconnected.deviceId)).toMatchObject({
        sessionId: "session-1",
        status: "busy",
      });
    });

    test("rejects a changed runtime identity inside the assignment mutex", async () => {
      await devicePool.initializeWithDevices([
        createBootedDevice("emulator-5554", "android", "Old Pixel"),
      ]);
      fakeDeviceManager.bootedDevices = [
        createBootedDevice("emulator-5554", "android", "New Pixel"),
      ];

      await expect(
        devicePool.bindOrReuseDeviceSession({
          sessionId: "session-1",
          deviceId: "emulator-5554",
          platform: "android",
          expectedIdentity: createBootedDevice("emulator-5554", "android", "New Pixel"),
        }),
      ).rejects.toThrow(/Device pool identity mismatch.*Old Pixel/);

      expect(devicePool.getDevice("emulator-5554")?.sessionId).toBeNull();
      expect(sessionManager.getSession("session-1")).toBeNull();
    });
  });
});
